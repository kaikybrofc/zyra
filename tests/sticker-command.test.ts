import { describe, expect, it, vi } from 'vitest'
import { stickerCommand } from '../src/commands/sticker.ts'

const createStickerFromMediaMock = vi.fn()

vi.mock('../src/utils/sticker.js', () => ({
  createStickerFromMedia: (...args: unknown[]) => createStickerFromMediaMock(...args),
}))

type StickerCtx = {
  pushName: string | null
  reply: ReturnType<typeof vi.fn>
  sendSticker: ReturnType<typeof vi.fn>
  getStickerSourceMedia: ReturnType<typeof vi.fn>
}

const createCtx = (): StickerCtx => ({
  pushName: 'Tester',
  reply: vi.fn().mockResolvedValue(undefined),
  sendSticker: vi.fn().mockResolvedValue(undefined),
  getStickerSourceMedia: vi.fn(),
})

describe('sticker command', () => {
  it('retorna instrução quando não há mídia na mensagem atual/citada', async () => {
    const ctx = createCtx()
    ctx.getStickerSourceMedia.mockResolvedValue(null)

    await stickerCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('Uso: envie `!sticker` na legenda de uma mídia ou responda uma mídia com `!sticker`.')
    expect(ctx.sendSticker).not.toHaveBeenCalled()
  })

  it('converte mídia e envia sticker com metadados', async () => {
    const ctx = createCtx()
    const source = { buffer: Buffer.from('media'), mediaType: 'image' as const }
    const stickerBuffer = Buffer.from('fake-webp')
    ctx.getStickerSourceMedia.mockResolvedValue(source)
    createStickerFromMediaMock.mockResolvedValue(stickerBuffer)

    await stickerCommand.execute(ctx as never)

    expect(createStickerFromMediaMock).toHaveBeenCalledWith(source, {
      packName: 'Zyra',
      packAuthor: 'Tester',
    })
    expect(ctx.sendSticker).toHaveBeenCalledWith({ sticker: stickerBuffer })
  })

  it('retorna erro amigável quando conversão falha', async () => {
    const ctx = createCtx()
    const source = { buffer: Buffer.from('media'), mediaType: 'video' as const }
    ctx.getStickerSourceMedia.mockResolvedValue(source)
    createStickerFromMediaMock.mockRejectedValue(new Error('ffmpeg missing'))

    await stickerCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('❌ Não foi possível gerar a figurinha: ffmpeg missing')
  })
})
