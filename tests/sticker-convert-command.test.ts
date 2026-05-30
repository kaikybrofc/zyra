import { describe, expect, it, vi } from 'vitest'
import { toGifCommand, toImageCommand } from '../src/commands/sticker-convert.ts'

const convertStickerWebpMock = vi.fn()

vi.mock('../src/utils/sticker-convert.js', () => ({
  convertStickerWebp: (...args: unknown[]) => convertStickerWebpMock(...args),
}))

type StickerConvertCtx = {
  reply: ReturnType<typeof vi.fn>
  sendImage: ReturnType<typeof vi.fn>
  sendVideo: ReturnType<typeof vi.fn>
  getStickerSourceMedia: ReturnType<typeof vi.fn>
}

const createCtx = (): StickerConvertCtx => ({
  reply: vi.fn().mockResolvedValue(undefined),
  sendImage: vi.fn().mockResolvedValue(undefined),
  sendVideo: vi.fn().mockResolvedValue(undefined),
  getStickerSourceMedia: vi.fn(),
})

describe('sticker convert commands', () => {
  it('retorna instrução quando não há mídia', async () => {
    const ctx = createCtx()
    ctx.getStickerSourceMedia.mockResolvedValue(null)

    await toImageCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('Não encontrei mídia para converter.\n' + 'Use o comando respondendo uma figurinha.\n' + 'Dica: se houver figurinha recente no chat, o bot tenta usar automaticamente.')
    expect(convertStickerWebpMock).not.toHaveBeenCalled()
  })

  it('retorna erro quando mídia não é sticker', async () => {
    const ctx = createCtx()
    ctx.getStickerSourceMedia.mockResolvedValue({ mediaType: 'image', buffer: Buffer.from('x') })

    await toGifCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('Esse comando aceita apenas figurinha (sticker WebP).')
    expect(convertStickerWebpMock).not.toHaveBeenCalled()
  })

  it('converte sticker para png no toimg', async () => {
    const ctx = createCtx()
    const source = { mediaType: 'sticker', buffer: Buffer.from('webp') as Buffer }
    const converted = Buffer.from('png')
    ctx.getStickerSourceMedia.mockResolvedValue(source)
    convertStickerWebpMock.mockResolvedValue(converted)

    await toImageCommand.execute(ctx as never)

    expect(convertStickerWebpMock).toHaveBeenCalledWith(source.buffer, 'png')
    expect(ctx.sendImage).toHaveBeenCalledWith({
      image: converted,
      caption: '🖼️ Sticker convertido para PNG',
    })
  })

  it('converte sticker para gif no togif', async () => {
    const ctx = createCtx()
    const source = { mediaType: 'sticker', buffer: Buffer.from('webp') as Buffer }
    const converted = Buffer.from('gif')
    ctx.getStickerSourceMedia.mockResolvedValue(source)
    convertStickerWebpMock.mockResolvedValue(converted)

    await toGifCommand.execute(ctx as never)

    expect(convertStickerWebpMock).toHaveBeenCalledWith(source.buffer, 'gif')
    expect(ctx.sendVideo).toHaveBeenCalledWith({
      video: converted,
      gifPlayback: true,
      mimetype: 'image/gif',
      caption: '🎞️ Sticker convertido para GIF',
    })
  })
})
