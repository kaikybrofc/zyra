import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { playCommand } from '../src/commands/play.ts'

const resolvePlayInputMock = vi.fn()
const refreshTrackIfNeededMock = vi.fn()
const isLikelyTransientPlayStreamErrorMock = vi.fn()
const formatDurationMsMock = vi.fn()
const fetchMock = vi.fn<typeof fetch>()

vi.mock('../src/utils/play-resolver.js', () => ({
  resolvePlayInput: (...args: unknown[]) => resolvePlayInputMock(...args),
  refreshTrackIfNeeded: (...args: unknown[]) => refreshTrackIfNeededMock(...args),
  isLikelyTransientPlayStreamError: (...args: unknown[]) => isLikelyTransientPlayStreamErrorMock(...args),
  formatDurationMs: (...args: unknown[]) => formatDurationMsMock(...args),
}))

type PlayCtx = {
  args: string[]
  reply: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  sendAudio: ReturnType<typeof vi.fn>
  commandName: string
  chatId: string
  sender: string
}

const createCtx = (args: string[] = []): PlayCtx => ({
  args,
  reply: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
  sendAudio: vi.fn().mockResolvedValue(undefined),
  commandName: 'play',
  chatId: 'chat@s.whatsapp.net',
  sender: 'user@s.whatsapp.net',
})

const baseTrack = {
  lookupKey: 'audio:q:teste',
  originalInput: 'teste',
  searchQuery: 'teste',
  identifier: 'abc',
  title: 'Track Title',
  uploaderName: 'Artist Name',
  durationMs: 123_000,
  webpageUrl: 'https://example.com/watch?v=1',
  thumbnailUrl: 'https://img.example/thumb.jpg',
  streamUrl: 'https://cdn.example/audio.mp3',
  streamExpiresAt: null,
  resolvedAt: Date.now(),
  playAttempts: 0,
}

describe('play command', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    resolvePlayInputMock.mockReset()
    refreshTrackIfNeededMock.mockReset()
    isLikelyTransientPlayStreamErrorMock.mockReset()
    fetchMock.mockReset()

    resolvePlayInputMock.mockResolvedValue(baseTrack)
    refreshTrackIfNeededMock.mockImplementation(async (track: unknown) => track)
    isLikelyTransientPlayStreamErrorMock.mockReturnValue(false)
    formatDurationMsMock.mockReturnValue('2:03')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('retorna uso quando não há argumentos', async () => {
    const ctx = createCtx()

    await playCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('Use `!play nome da música` ou `!play <url>`.')
    expect(resolvePlayInputMock).not.toHaveBeenCalled()
  })

  it('resolve busca textual e envia áudio', async () => {
    const ctx = createCtx(['never', 'gonna', 'give', 'you', 'up'])
    const audioBuffer = Buffer.from('audio')
    const thumbBuffer = Buffer.from('thumb')
    fetchMock.mockResolvedValueOnce(new Response(audioBuffer, { status: 200, headers: { 'content-type': 'audio/mpeg' } })).mockResolvedValueOnce(new Response(thumbBuffer, { status: 200, headers: { 'content-type': 'image/jpeg' } }))

    await playCommand.execute(ctx as never)

    expect(resolvePlayInputMock).toHaveBeenCalledWith('never gonna give you up', { skipLookupKeys: [] })
    expect(refreshTrackIfNeededMock).toHaveBeenCalledWith(baseTrack, { skipLookupKeys: ['audio:q:teste'] })
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://cdn.example/audio.mp3', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://img.example/thumb.jpg', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(ctx.send).toHaveBeenCalledWith({
      image: thumbBuffer,
      caption: '🎵 Track Title\nArtista/Canal: Artist Name\nDuração: 2:03\nID: abc\nhttps://example.com/watch?v=1',
    })
    expect(ctx.sendAudio).toHaveBeenCalledWith({
      audio: audioBuffer,
      mimetype: 'audio/mpeg',
      ptt: false,
    })
    expect(ctx.send.mock.invocationCallOrder[0]).toBeLessThan(ctx.sendAudio.mock.invocationCallOrder[0])
  })

  it('resolve url direta e envia áudio', async () => {
    const ctx = createCtx(['https://youtu.be/dQw4w9WgXcQ'])
    const audioBuffer = Buffer.from('url-audio')
    const thumbBuffer = Buffer.from('url-thumb')
    fetchMock.mockResolvedValueOnce(new Response(audioBuffer, { status: 200 })).mockResolvedValueOnce(new Response(thumbBuffer, { status: 200 }))

    await playCommand.execute(ctx as never)

    expect(resolvePlayInputMock).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ', { skipLookupKeys: [] })
    expect(ctx.send).toHaveBeenCalledOnce()
    expect(ctx.sendAudio).toHaveBeenCalledOnce()
  })

  it('retorna erro amigável quando a resolução falha', async () => {
    const ctx = createCtx(['broken'])
    resolvePlayInputMock.mockRejectedValue(new Error('resolver offline'))

    await playCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('❌ Não foi possível localizar o áudio: resolver offline')
    expect(ctx.send).not.toHaveBeenCalled()
    expect(ctx.sendAudio).not.toHaveBeenCalled()
  })

  it('faz refresh e retry quando o download final falha de forma transitória', async () => {
    const ctx = createCtx(['retry'])
    const refreshedTrack = { ...baseTrack, streamUrl: 'https://cdn.example/audio-fresh.mp3', title: 'Fresh Title' }
    const thumbBuffer = Buffer.from('fresh-thumb')
    const audioBuffer = Buffer.from('fresh-audio')

    refreshTrackIfNeededMock.mockImplementationOnce(async (track: unknown) => track).mockResolvedValueOnce(refreshedTrack)
    fetchMock
      .mockResolvedValueOnce(new Response('expired', { status: 503 }))
      .mockResolvedValueOnce(new Response(audioBuffer, { status: 200 }))
      .mockResolvedValueOnce(new Response(thumbBuffer, { status: 200 }))
    isLikelyTransientPlayStreamErrorMock.mockReturnValue(true)

    await playCommand.execute(ctx as never)

    expect(refreshTrackIfNeededMock).toHaveBeenNthCalledWith(1, baseTrack, { skipLookupKeys: ['audio:q:teste'] })
    expect(refreshTrackIfNeededMock).toHaveBeenNthCalledWith(2, baseTrack, { forceRefresh: true, skipLookupKeys: ['audio:q:teste'] })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://cdn.example/audio-fresh.mp3', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, 'https://img.example/thumb.jpg', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(ctx.send).toHaveBeenCalledWith({
      image: thumbBuffer,
      caption: '🎵 Fresh Title\nArtista/Canal: Artist Name\nDuração: 2:03\nID: abc\nhttps://example.com/watch?v=1',
    })
    expect(ctx.sendAudio).toHaveBeenCalledWith(expect.objectContaining({ audio: audioBuffer }))
  })

  it('retorna erro amigável quando o envio falha sem ser transitório', async () => {
    const ctx = createCtx(['fail'])
    resolvePlayInputMock.mockResolvedValueOnce(baseTrack).mockRejectedValueOnce(new Error('sem mais candidatos'))
    fetchMock.mockResolvedValueOnce(new Response('bad gateway', { status: 502 })).mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
    isLikelyTransientPlayStreamErrorMock.mockImplementation((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      return message.includes('HTTP 502 ao baixar áudio')
    })

    await playCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('❌ Não foi possível enviar o áudio: HTTP 502 ao baixar áudio')
    expect(ctx.send).not.toHaveBeenCalled()
    expect(ctx.sendAudio).not.toHaveBeenCalled()
  })

  it('tenta o próximo resultado quando o primeiro áudio passa do limite', async () => {
    const ctx = createCtx(['big'])
    const secondTrack = { ...baseTrack, lookupKey: 'audio:q:big-2', streamUrl: 'https://cdn.example/audio-2.mp3', title: 'Track 2' }
    const audioBuffer = Buffer.from('audio-2')
    const thumbBuffer = Buffer.from('thumb-2')
    resolvePlayInputMock.mockResolvedValueOnce(baseTrack).mockResolvedValueOnce(secondTrack)
    fetchMock
      .mockResolvedValueOnce(
        new Response('too big', {
          status: 200,
          headers: { 'content-length': String(100 * 1024 * 1024 + 1) },
        })
      )
      .mockResolvedValueOnce(new Response(audioBuffer, { status: 200 }))
      .mockResolvedValueOnce(new Response(thumbBuffer, { status: 200 }))
    isLikelyTransientPlayStreamErrorMock.mockReturnValue(false)

    await playCommand.execute(ctx as never)

    expect(resolvePlayInputMock).toHaveBeenNthCalledWith(1, 'big', { skipLookupKeys: [] })
    expect(resolvePlayInputMock).toHaveBeenNthCalledWith(2, 'big', { skipLookupKeys: ['audio:q:teste'] })
    expect(ctx.sendAudio).toHaveBeenCalledWith({
      audio: audioBuffer,
      mimetype: 'audio/mpeg',
      ptt: false,
    })
    expect(ctx.reply).not.toHaveBeenCalledWith(expect.stringContaining('Áudio acima do limite'))
  })

  it('bloqueia áudio acima de 100 MB quando o tamanho real ultrapassa o limite', async () => {
    const ctx = createCtx(['huge'])
    const oversizeBuffer = new Uint8Array(100 * 1024 * 1024 + 1)
    resolvePlayInputMock.mockResolvedValueOnce(baseTrack).mockRejectedValueOnce(new Error('sem mais candidatos'))
    fetchMock.mockResolvedValueOnce(
      new Response(oversizeBuffer, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })
    )
    isLikelyTransientPlayStreamErrorMock.mockReturnValue(false)

    await playCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('❌ Não foi possível enviar o áudio: Áudio acima do limite de 100 MB do WhatsApp')
    expect(ctx.send).not.toHaveBeenCalled()
    expect(ctx.sendAudio).not.toHaveBeenCalled()
  })
})
