import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { playVideoCommand } from '../src/commands/playvid.ts'

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

type PlayVideoCtx = {
  args: string[]
  reply: ReturnType<typeof vi.fn>
  sendVideo: ReturnType<typeof vi.fn>
  commandName: string
  chatId: string
  sender: string
}

const createCtx = (args: string[] = []): PlayVideoCtx => ({
  args,
  reply: vi.fn().mockResolvedValue(undefined),
  sendVideo: vi.fn().mockResolvedValue(undefined),
  commandName: 'playvid',
  chatId: 'chat@s.whatsapp.net',
  sender: 'user@s.whatsapp.net',
})

const baseTrack = {
  lookupKey: 'video:q:teste',
  originalInput: 'teste',
  searchQuery: 'teste',
  identifier: 'abc',
  title: 'Video Title',
  uploaderName: 'Artist Name',
  durationMs: 123_000,
  webpageUrl: 'https://example.com/watch?v=1',
  thumbnailUrl: 'https://img.example/thumb.jpg',
  streamUrl: 'https://cdn.example/video.mp4',
  streamExpiresAt: null,
  resolvedAt: Date.now(),
  playAttempts: 0,
}

describe('playvid command', () => {
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

    await playVideoCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('Use `!playvid nome do vídeo` ou `!playvid <url>`.')
    expect(resolvePlayInputMock).not.toHaveBeenCalled()
  })

  it('resolve busca textual e envia vídeo com caption', async () => {
    const ctx = createCtx(['bala', 'love'])
    const videoBuffer = Buffer.from('video')
    fetchMock.mockResolvedValueOnce(new Response(videoBuffer, { status: 200, headers: { 'content-type': 'video/mp4' } }))

    await playVideoCommand.execute(ctx as never)

    expect(resolvePlayInputMock).toHaveBeenCalledWith('bala love', { mode: 'video', skipLookupKeys: [] })
    expect(refreshTrackIfNeededMock).toHaveBeenCalledWith(baseTrack, { mode: 'video', skipLookupKeys: ['video:q:teste'] })
    expect(ctx.sendVideo).toHaveBeenCalledWith({
      video: videoBuffer,
      mimetype: 'video/mp4',
      caption: '🎬 Video Title\nArtista/Canal: Artist Name\nDuração: 2:03\nID: abc\nhttps://example.com/watch?v=1',
    })
  })

  it('faz refresh e retry quando o download final falha de forma transitória', async () => {
    const ctx = createCtx(['retry'])
    const refreshedTrack = { ...baseTrack, streamUrl: 'https://cdn.example/video-fresh.mp4', title: 'Fresh Video' }
    const videoBuffer = Buffer.from('video-fresh')
    refreshTrackIfNeededMock.mockImplementationOnce(async (track: unknown) => track).mockResolvedValueOnce(refreshedTrack)
    fetchMock.mockResolvedValueOnce(new Response('expired', { status: 503 })).mockResolvedValueOnce(new Response(videoBuffer, { status: 200 }))
    isLikelyTransientPlayStreamErrorMock.mockReturnValue(true)

    await playVideoCommand.execute(ctx as never)

    expect(refreshTrackIfNeededMock).toHaveBeenNthCalledWith(1, baseTrack, { mode: 'video', skipLookupKeys: ['video:q:teste'] })
    expect(refreshTrackIfNeededMock).toHaveBeenNthCalledWith(2, baseTrack, { forceRefresh: true, mode: 'video', skipLookupKeys: ['video:q:teste'] })
    expect(ctx.sendVideo).toHaveBeenCalledWith(expect.objectContaining({ video: videoBuffer }))
  })

  it('tenta o próximo resultado quando o primeiro vídeo passa do limite', async () => {
    const ctx = createCtx(['huge'])
    const secondTrack = { ...baseTrack, lookupKey: 'video:q:huge-2', streamUrl: 'https://cdn.example/video-2.mp4', title: 'Video 2' }
    const videoBuffer = Buffer.from('video-2')
    resolvePlayInputMock.mockResolvedValueOnce(baseTrack).mockResolvedValueOnce(secondTrack)
    fetchMock
      .mockResolvedValueOnce(
        new Response('too big', {
          status: 200,
          headers: { 'content-length': String(100 * 1024 * 1024 + 1) },
        })
      )
      .mockResolvedValueOnce(new Response(videoBuffer, { status: 200 }))

    await playVideoCommand.execute(ctx as never)

    expect(resolvePlayInputMock).toHaveBeenNthCalledWith(1, 'huge', { mode: 'video', skipLookupKeys: [] })
    expect(resolvePlayInputMock).toHaveBeenNthCalledWith(2, 'huge', { mode: 'video', skipLookupKeys: ['video:q:teste'] })
    expect(ctx.sendVideo).toHaveBeenCalledWith(expect.objectContaining({ video: videoBuffer }))
    expect(ctx.reply).not.toHaveBeenCalledWith(expect.stringContaining('Vídeo acima do limite'))
  })

  it('retorna erro amigável quando o envio do vídeo falha sem mais candidatos', async () => {
    const ctx = createCtx(['fail'])
    resolvePlayInputMock.mockResolvedValueOnce(baseTrack).mockRejectedValueOnce(new Error('sem mais candidatos'))
    fetchMock.mockResolvedValueOnce(new Response('bad gateway', { status: 502 })).mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
    isLikelyTransientPlayStreamErrorMock.mockImplementation((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      return message.includes('HTTP 502 ao baixar vídeo')
    })

    await playVideoCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('❌ Não foi possível enviar o vídeo: HTTP 502 ao baixar vídeo')
    expect(ctx.sendVideo).not.toHaveBeenCalled()
  })
})
