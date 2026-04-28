import { describe, expect, it, vi } from 'vitest'
import { stickerCommand } from '../src/commands/sticker.ts'

const createStickerFromMediaMock = vi.fn()

vi.mock('../src/utils/sticker.js', () => ({
  createStickerFromMedia: (...args: unknown[]) => createStickerFromMediaMock(...args),
}))

type StickerCtx = {
  pushName: string | null
  sender: string
  args: string[]
  isGroup: boolean
  reply: ReturnType<typeof vi.fn>
  sendSticker: ReturnType<typeof vi.fn>
  getStickerSourceMedia: ReturnType<typeof vi.fn>
  getMetadata: ReturnType<typeof vi.fn>
}

const createCtx = (): StickerCtx => ({
  pushName: 'Tester',
  sender: '5511999999999@s.whatsapp.net',
  args: [],
  isGroup: false,
  reply: vi.fn().mockResolvedValue(undefined),
  sendSticker: vi.fn().mockResolvedValue(undefined),
  getStickerSourceMedia: vi.fn(),
  getMetadata: vi.fn().mockResolvedValue({ subject: 'Grupo Teste' }),
})

describe('sticker command', () => {
  it('retorna instrução quando não há mídia na mensagem atual/citada', async () => {
    const ctx = createCtx()
    ctx.getStickerSourceMedia.mockResolvedValue(null)

    await stickerCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith(
      'Uso: envie `!s pack/autor` na legenda de uma mídia ou respondendo uma mídia.\n'
      + 'Exemplos:\n'
      + '- `!s Zyra/#nome`\n'
      + '- `!s Pack #grupo/#nome - #numero`\n'
      + '- `!s Evento #data/#hora`\n'
      + 'Placeholders: #data #hora #nome #grupo #numero'
    )
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
