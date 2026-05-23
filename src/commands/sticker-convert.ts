import type { Command } from './types.js'
import { convertStickerWebp, type StickerConversionTarget } from '../utils/sticker-convert.js'
import { createLogger } from '../observability/logger.js'

const logger = createLogger()
const SOURCE_RESOLVE_TIMEOUT_MS = 15_000

const MESSAGES = {
  missingMedia:
    'Não encontrei mídia para converter.\n'
    + 'Use o comando respondendo uma figurinha.\n'
    + 'Dica: se houver figurinha recente no chat, o bot tenta usar automaticamente.',
  stickerOnly:
    'Esse comando aceita apenas figurinha (sticker WebP).',
}

/**
 * Cria um executor de comando para converter stickers WebP
 * em um formato de saída compatível com o chat.
 */
const executeStickerConvert =
  (target: StickerConversionTarget): Command['execute'] =>
    async (ctx) => {
      const source = await Promise.race<Awaited<ReturnType<typeof ctx.getStickerSourceMedia>>>([
        ctx.getStickerSourceMedia().catch((error) => {
          logger.warn('sticker convert falhou ao resolver mídia de origem', {
            command: ctx.commandName,
            chatId: ctx.chatId,
            sender: ctx.sender,
            err: error,
          })
          return null
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SOURCE_RESOLVE_TIMEOUT_MS)),
      ])
      if (!source) {
        logger.info('sticker convert sem mídia de origem', {
          command: ctx.commandName,
          chatId: ctx.chatId,
          sender: ctx.sender,
          timeoutMs: SOURCE_RESOLVE_TIMEOUT_MS,
        })
        await ctx.reply(MESSAGES.missingMedia)
        return
      }
      if (source.mediaType !== 'sticker') {
        await ctx.reply(MESSAGES.stickerOnly)
        return
      }

      try {
        const converted = await convertStickerWebp(source.buffer, target)
        if (target === 'gif') {
          await ctx.sendVideo({
            video: converted,
            gifPlayback: true,
            mimetype: 'image/gif',
            caption: '🎞️ Sticker convertido para GIF',
          })
          return
        }

        await ctx.sendImage({
          image: converted,
          caption: '🖼️ Sticker convertido para PNG',
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'erro desconhecido'
        await ctx.reply(`❌ Não foi possível converter a figurinha: ${message}`)
      }
    }

/**
 * Converte uma figurinha WebP em imagem PNG.
 */
export const toImageCommand: Command = {
  name: 'toimg',
  description: 'Converte figurinha (WebP) para imagem PNG',
  execute: executeStickerConvert('png'),
}

/**
 * Converte uma figurinha WebP em GIF animado.
 */
export const toGifCommand: Command = {
  name: 'togif',
  description: 'Converte figurinha (WebP) para GIF',
  execute: executeStickerConvert('gif'),
}
