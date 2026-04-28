import { createStickerFromMedia } from '../utils/sticker.js'
import type { Command } from './types.js'

const MAX_STICKER_SIZE_BYTES = 1.5 * 1024 * 1024
const DEFAULT_PACK_NAME = 'Zyra'
const DEFAULT_PACK_AUTHOR = 'Zyra'
const REPLACEMENT_TIMEZONE = 'America/Sao_Paulo'

const normalizePhoneFromJid = (jid: string): string => {
  const raw = jid.split('@')[0] ?? ''
  const digits = raw.replace(/\D/g, '')
  return digits || 'desconhecido'
}

const parseStickerPackOverrides = (args: string[]): { rawPackName: string | null; rawPackAuthor: string | null } => {
  const raw = args.join(' ').trim()
  if (!raw) return { rawPackName: null, rawPackAuthor: null }

  const slashIndex = raw.indexOf('/')
  if (slashIndex < 0) {
    return { rawPackName: raw, rawPackAuthor: null }
  }

  const rawPackName = raw.slice(0, slashIndex).trim()
  const rawPackAuthor = raw.slice(slashIndex + 1).trim()
  return {
    rawPackName: rawPackName || null,
    rawPackAuthor: rawPackAuthor || null,
  }
}

const applyStickerTemplate = (
  value: string,
  replacements: Record<'#data' | '#hora' | '#nome' | '#grupo' | '#numero', string>
): string => {
  return value
    .replace(/#data/gi, replacements['#data'])
    .replace(/#hora/gi, replacements['#hora'])
    .replace(/#nome/gi, replacements['#nome'])
    .replace(/#grupo/gi, replacements['#grupo'])
    .replace(/#numero/gi, replacements['#numero'])
}

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
    await safeReply(
      'Uso: envie `!s pack/autor` na legenda de uma mídia ou respondendo uma mídia.\n'
      + 'Exemplos:\n'
      + '- `!s Zyra/#nome`\n'
      + '- `!s Pack #grupo/#nome - #numero`\n'
      + '- `!s Evento #data/#hora`\n'
      + 'Placeholders: #data #hora #nome #grupo #numero'
    )
    return
  }

  try {
    const now = new Date()
    const date = new Intl.DateTimeFormat('pt-BR', {
      timeZone: REPLACEMENT_TIMEZONE,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(now)
    const hour = new Intl.DateTimeFormat('pt-BR', {
      timeZone: REPLACEMENT_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now)

    let groupName = 'conversa privada'
    if (ctx.isGroup) {
      try {
        const metadata = await ctx.getMetadata()
        groupName = metadata.subject?.trim() || 'grupo sem nome'
      } catch {
        groupName = 'grupo'
      }
    }

    const replacements = {
      '#data': date,
      '#hora': hour,
      '#nome': (ctx.pushName?.trim() || DEFAULT_PACK_AUTHOR),
      '#grupo': groupName,
      '#numero': normalizePhoneFromJid(ctx.sender),
    } as const

    const { rawPackName, rawPackAuthor } = parseStickerPackOverrides(ctx.args)
    const resolvedPackName = applyStickerTemplate(rawPackName ?? DEFAULT_PACK_NAME, replacements)
    const resolvedPackAuthor = applyStickerTemplate(rawPackAuthor ?? replacements['#nome'], replacements)

    const sticker = await createStickerFromMedia(source, {
      packName: resolvedPackName,
      packAuthor: resolvedPackAuthor,
    })

    if (sticker.length >= MAX_STICKER_SIZE_BYTES) {
      await safeReply('❌ A figurinha convertida ficou com 1.5MB ou mais. Envie uma mídia menor.')
      return
    }

    await ctx.sendSticker({ sticker })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'erro desconhecido'
    await safeReply(`❌ Não foi possível gerar a figurinha: ${reason}`)
  }
}

export const stickerCommand: Command = {
  name: 'sticker',
  description: 'Converte mídia em figurinha 512x512 com pack/autor customizáveis',
  execute: executeStickerCommand,
}

export const stickerAliasCommand: Command = {
  name: 's',
  description: 'Alias de !sticker (aceita !s pack/autor)',
  execute: executeStickerCommand,
}
