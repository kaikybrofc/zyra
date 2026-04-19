import { createStickerFromMedia } from '../utils/sticker.js'
import type { Command } from './types.js'

const executeStickerCommand: Command['execute'] = async (ctx) => {
  const safeReply = async (text: string): Promise<void> => {
    try {
      await ctx.reply(text)
    } catch {
      // Evita quebrar o comando quando o antiban bloqueia a própria resposta de erro.
    }
  }

  const source = await ctx.getStickerSourceMedia()
  if (!source) {
    await safeReply('Uso: envie `!sticker` na legenda de uma mídia ou responda uma mídia com `!sticker`.')
    return
  }

  try {
    const sticker = await createStickerFromMedia(source, {
      packName: 'Zyra',
      packAuthor: ctx.pushName ?? 'Zyra',
    })
    await ctx.sendSticker({ sticker })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'erro desconhecido'
    await safeReply(`❌ Não foi possível gerar a figurinha: ${reason}`)
  }
}

export const stickerCommand: Command = {
  name: 'sticker',
  description: 'Converte mídia (atual ou citada) em figurinha 512x512',
  execute: executeStickerCommand,
}

export const stickerAliasCommand: Command = {
  name: 's',
  description: 'Alias de !sticker',
  execute: executeStickerCommand,
}
