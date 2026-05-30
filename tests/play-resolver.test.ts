import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __playResolverInternals, buildPlayFileName, formatDurationMs, isLikelyTransientPlayStreamError, refreshTrackIfNeeded, resolvePlayInput } from '../src/utils/play-resolver.ts'

const fetchMock = vi.fn<typeof fetch>()

describe('play resolver', () => {
  beforeEach(() => {
    __playResolverInternals.clearCaches()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    fetchMock.mockReset()
  })

  it('normaliza chaves de busca para texto, youtube e outras urls', () => {
    expect(__playResolverInternals.normalizeLookupKey('  Hello   World  ')).toBe('q:hello world')
    expect(__playResolverInternals.normalizeLookupKey('https://youtu.be/dQw4w9WgXcQ')).toBe('yt:dQw4w9WgXcQ')
    expect(__playResolverInternals.normalizeLookupKey('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('yt:dQw4w9WgXcQ')
    expect(__playResolverInternals.normalizeLookupKey('https://example.com/a?b=1')).toBe('url:https://example.com/a?b=1')
  })

  it('nao aceita hosts que apenas terminam com youtube.com', () => {
    expect(__playResolverInternals.normalizeLookupKey('https://evil-youtube.com/watch?v=dQw4w9WgXcQ')).toBe('url:https://evil-youtube.com/watch?v=dQw4w9WgXcQ')
    expect(__playResolverInternals.normalizeLookupKey('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')).toBe('url:https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')
    expect(__playResolverInternals.normalizeLookupKey('https://example.com/path/youtube.com/watch?v=dQw4w9WgXcQ')).toBe('url:https://example.com/path/youtube.com/watch?v=dQw4w9WgXcQ')
  })

  it('extrai candidatos da busca e limita a cinco itens únicos', () => {
    const payload = {
      items: [
        { id: 'https://www.youtube.com/watch?v=sVx1mJDeUjY', type: 'stream', uploaderName: 'Mr.Kitty Official', duration: 258, thumbnailUrl: 'https://img.example/track.jpg' },
        { id: 'dQw4w9WgXcQ', type: 'video' },
        { url: 'https://example.com/1', type: 'video' },
        { url: 'https://example.com/1', type: 'video' },
        { url: 'https://example.com/2', type: 'stream' },
        { link: 'https://example.com/3', type: 'music' },
        { original_url: 'https://example.com/4', type: 'audio' },
        { webpageUrl: 'https://example.com/5', type: 'video' },
        { url: 'https://example.com/6', type: 'video' },
      ],
    }

    expect(__playResolverInternals.extractSearchCandidateUrls(payload)).toEqual(['https://www.youtube.com/watch?v=sVx1mJDeUjY', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://example.com/1', 'https://example.com/2', 'https://example.com/3'])
  })

  it('resolve busca textual até obter um downloadUrl final', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: 'dQw4w9WgXcQ', type: 'video' }],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statusUrl: 'https://hub.ytconvert.org/api/status/abc',
            title: 'Never Gonna Give You Up',
            duration: 213,
            thumbnail: 'https://img.example/create.jpg',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'completed',
            downloadUrl: 'https://cdn.example/audio.mp3?exp=4102444800',
            title: 'Never Gonna Give You Up',
            duration: 213,
            webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            thumbnail_url: 'https://img.example/final.jpg',
          }),
          { status: 200 }
        )
      )

    const track = await resolvePlayInput('rick astley')

    expect(track.lookupKey).toBe('audio:q:rick astley')
    expect(track.identifier).toBe('dQw4w9WgXcQ')
    expect(track.title).toBe('Never Gonna Give You Up')
    expect(track.uploaderName).toBeNull()
    expect(track.durationMs).toBe(213_000)
    expect(track.thumbnailUrl).toBe('https://img.example/final.jpg')
    expect(track.streamUrl).toBe('https://cdn.example/audio.mp3?exp=4102444800')

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://hub.ytconvert.org/api/download',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
    )
    const createInit = fetchMock.mock.calls[1]?.[1]
    expect(createInit).toBeDefined()
    const body = createInit && 'body' in createInit ? createInit.body : undefined
    expect(typeof body).toBe('string')
    expect(JSON.parse(String(body))).toEqual({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      os: 'linux',
      output: { type: 'audio', format: 'mp3' },
      audio: { bitrate: '128k', trackId: 'origin' },
    })
  })

  it('faz fallback sequencial quando o primeiro candidato falha', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              { url: 'https://example.com/first', type: 'video' },
              { url: 'https://example.com/second', type: 'video' },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'bad candidate' }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ statusUrl: 'https://hub.ytconvert.org/api/status/ok' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'completed',
            downloadUrl: 'https://cdn.example/final.mp3?expires=4102444800',
            title: 'Track',
            duration: '03:15',
            url: 'https://example.com/second',
          }),
          { status: 200 }
        )
      )

    const track = await resolvePlayInput('fallback query')

    expect(track.webpageUrl).toBe('https://example.com/second')
    expect(track.durationMs).toBe(195_000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('deduplica resoluções concorrentes pela mesma chave', async () => {
    let resolveSearch: ((value: Response) => void) | null = null
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveSearch = resolve
        })
    )
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ statusUrl: 'https://hub.ytconvert.org/api/status/abc' }), { status: 200 })).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'completed',
          downloadUrl: 'https://cdn.example/audio.mp3?exp=4102444800',
          title: 'Title',
          duration: 60,
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        }),
        { status: 200 }
      )
    )

    const first = resolvePlayInput('same query')
    const second = resolvePlayInput('same query')

    resolveSearch?.(new Response(JSON.stringify({ results: [{ id: 'dQw4w9WgXcQ', type: 'video' }] }), { status: 200 }))

    const [trackA, trackB] = await Promise.all([first, second])
    expect(trackA.streamUrl).toBe(trackB.streamUrl)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('usa cache para não refazer resolução idêntica', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ id: 'dQw4w9WgXcQ', type: 'video' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ statusUrl: 'https://hub.ytconvert.org/api/status/abc' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'completed',
            downloadUrl: 'https://cdn.example/audio.mp3?exp=4102444800',
            title: 'Cached title',
            duration: 120,
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          }),
          { status: 200 }
        )
      )

    const first = await resolvePlayInput('cached query')
    const second = await resolvePlayInput('cached query')

    expect(first.title).toBe('Cached title')
    expect(second.title).toBe('Cached title')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('faz refresh quando a stream está perto de expirar', async () => {
    const now = Date.now()
    const track = {
      lookupKey: 'audio:q:teste',
      originalInput: 'teste',
      searchQuery: 'teste',
      identifier: 'abc',
      title: 'Teste',
      uploaderName: null,
      durationMs: 10_000,
      webpageUrl: 'https://example.com/watch?v=1',
      thumbnailUrl: null,
      streamUrl: 'https://cdn.example/old.mp3?exp=1',
      streamExpiresAt: now + 10_000,
      resolvedAt: now,
      playAttempts: 0,
    }

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ url: 'https://example.com/source', type: 'video' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ statusUrl: 'https://hub.ytconvert.org/api/status/refresh' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'completed',
            downloadUrl: 'https://cdn.example/new.mp3?exp=4102444800',
            title: 'Atualizada',
            duration: 11,
            url: 'https://example.com/source',
          }),
          { status: 200 }
        )
      )

    const refreshed = await refreshTrackIfNeeded(track)
    expect(refreshed.streamUrl).toBe('https://cdn.example/new.mp3?exp=4102444800')
    expect(refreshed.title).toBe('Atualizada')
  })

  it('reaproveita metadados do candidato quando o status final não os traz', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'https://www.youtube.com/watch?v=xm7TWFiZgTw',
                type: 'stream',
                title: 'Bala Love',
                uploaderName: 'MC ANJIM',
                duration: 252,
                thumbnailUrl: 'https://img.example/bala.jpg',
              },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ statusUrl: 'https://hub.ytconvert.org/api/status/meta' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'completed',
            downloadUrl: 'https://cdn.example/bala.mp3?exp=4102444800',
            url: 'https://www.youtube.com/watch?v=xm7TWFiZgTw',
          }),
          { status: 200 }
        )
      )

    const track = await resolvePlayInput('bala love')

    expect(track.title).toBe('Bala Love')
    expect(track.uploaderName).toBe('MC ANJIM')
    expect(track.durationMs).toBe(252_000)
    expect(track.thumbnailUrl).toBe('https://img.example/bala.jpg')
  })

  it('detecta erros transitórios de stream', () => {
    expect(isLikelyTransientPlayStreamError(new Error('HTTP 503 ao baixar áudio'))).toBe(true)
    expect(isLikelyTransientPlayStreamError(new Error('signature expired'))).toBe(true)
    expect(isLikelyTransientPlayStreamError(new Error('validation failed'))).toBe(false)
  })

  it('formata duração e nome de arquivo', () => {
    expect(formatDurationMs(213_000)).toBe('3:33')
    expect(formatDurationMs(3_723_000)).toBe('1:02:03')
    expect(buildPlayFileName({ title: 'Música / Teste: Ao Vivo?' })).toBe('Musica Teste Ao Vivo.mp3')
  })
})
