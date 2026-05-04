import { createStickerFromMedia } from '../utils/sticker.js'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config/index.js'
import type { Command } from './types.js'

const MAX_STICKER_SIZE_BYTES = 1.5 * 1024 * 1024
const DEFAULT_PACK_NAME = 'Zyra'
const DEFAULT_PACK_AUTHOR = 'Zyra'
const REPLACEMENT_TIMEZONE = 'America/Sao_Paulo'
const STICKER_HELP_FLAGS = new Set(['-help', '--help', '-h'])
const GENERATED_STICKER_MIME = 'image/webp'

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

const parseStickerPackOverridesFromText = (text: string): { rawPackName: string | null; rawPackAuthor: string | null } => {
  return parseStickerPackOverrides(text ? [text] : [])
}

const stringifyStickerTemplate = (rawPackName: string | null, rawPackAuthor: string | null): string | null => {
  if (!rawPackName && !rawPackAuthor) return null
  if (rawPackName && rawPackAuthor) return `${rawPackName}/${rawPackAuthor}`
  if (rawPackName) return rawPackName
  return `/${rawPackAuthor}`
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

const buildStickerHelpMessage = (): string => {
  return (
    'Comando de figurinha (`!sticker`, `!s`, `!st`)\n'
    + '\n'
    + 'Como usar:\n'
    + '- Envie o comando na legenda da mídia ou respondendo uma mídia.\n'
    + '- `!s` usa seu template salvo (ou padrão se ainda não houver).\n'
    + '- `!s texto` atualiza só o lado esquerdo (pack).\n'
    + '- `!s pack/autor` atualiza os dois lados.\n'
    + '- `!s pack/` atualiza só pack e mantém autor salvo.\n'
    + '- `!s /autor` atualiza só autor e mantém pack salvo.\n'
    + '\n'
    + 'Persistência por usuário:\n'
    + '- O último template fica salvo no banco por usuário.\n'
    + '- Ao enviar novo texto, só os lados informados são alterados.\n'
    + '\n'
    + 'Placeholders disponíveis:\n'
    + '- `#data` data atual\n'
    + '- `#hora` hora atual\n'
    + '- `#nome` nome do usuário\n'
    + '- `#grupo` nome do grupo\n'
    + '- `#numero` número do remetente\n'
    + '\n'
    + 'Exemplos:\n'
    + '- `!s`\n'
    + '- `!s Zyra`\n'
    + '- `!s Zyra/#nome`\n'
    + '- `!s Pack #grupo/#nome - #numero`\n'
    + '- `!s Evento #data/#hora`\n'
    + '\n'
    + 'Ajuda rápida: `!s -h` ou `!s -help`'
  )
}

const safeFileName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_')

const toRelativePath = (absolutePath: string): string => {
  const relative = path.relative(process.cwd(), absolutePath)
  return relative && !relative.startsWith('..') ? relative : absolutePath
}

const isAnimatedWebP = (buffer: Buffer): boolean => {
  if (
    buffer.length < 12
    || buffer[0] !== 0x52
    || buffer[1] !== 0x49
    || buffer[2] !== 0x46
    || buffer[3] !== 0x46
    || buffer[8] !== 0x57
    || buffer[9] !== 0x45
    || buffer[10] !== 0x42
    || buffer[11] !== 0x50
  ) {
    return false
  }

  let offset = 12
  while (offset < buffer.length - 8) {
    const chunkFourCC = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    if (chunkFourCC === 'VP8X') {
      const flagsOffset = offset + 8
      if (flagsOffset < buffer.length) {
        const flags = buffer[flagsOffset] ?? 0
        if (flags & 0x02) return true
      }
    } else if (chunkFourCC === 'ANIM' || chunkFourCC === 'ANMF') {
      return true
    }
    offset += 8 + chunkSize + (chunkSize % 2)
  }

  return false
}

const persistGeneratedSticker = async (params: {
  sticker: Buffer
  sender: string
  packName: string
  packAuthor: string
  templateText?: string | null
  record: (entry: {
    packName: string
    packAuthor: string
    templateText?: string | null
    localPath: string
    fileSha256: string
    fileLength: number
    mimeType?: string | null
    data?: unknown
  }) => Promise<void>
}): Promise<void> => {
  const hashHex = createHash('sha256').update(params.sticker).digest('hex')
  const hashB64 = createHash('sha256').update(params.sticker).digest('base64')
  const stickerPackFileName = `${hashB64.replace(/\//g, '-')}.webp`
  const isAnimated = isAnimatedWebP(params.sticker)
  const senderTag = safeFileName(params.sender.split('@')[0] ?? 'unknown')
  const baseDir = path.resolve(process.cwd(), config.mediaDownloadDir, 'stickers', safeFileName(config.connectionId))
  await fs.mkdir(baseDir, { recursive: true })
  const fileName = `${Date.now()}-${senderTag}-${hashHex.slice(0, 16)}.webp`
  const absolutePath = path.join(baseDir, fileName)
  await fs.writeFile(absolutePath, params.sticker)
  const localPath = toRelativePath(absolutePath)
  await params.record({
    packName: params.packName,
    packAuthor: params.packAuthor,
    templateText: params.templateText ?? null,
    localPath,
    fileSha256: hashHex,
    fileLength: params.sticker.length,
    mimeType: GENERATED_STICKER_MIME,
    data: {
      link: localPath,
      hash: hashHex,
      sender: params.sender,
      generatedAt: new Date().toISOString(),
      stickerPackDraft: {
        sticker: {
          fileName: stickerPackFileName,
          mimetype: GENERATED_STICKER_MIME,
          isAnimated,
          emojis: [],
          accessibilityLabel: '',
        },
        pack: {
          name: params.packName,
          publisher: params.packAuthor,
          description: null,
          packId: null,
        },
      },
    },
  })
}

const executeStickerCommand: Command['execute'] = async (ctx) => {
  const safeReply = async (text: string): Promise<void> => {
    try {
      await ctx.reply(text)
    } catch {
      // Evita quebrar o comando quando o antiban bloqueia a própria resposta de erro.
    }
  }

  const firstArg = ctx.args[0]?.toLowerCase() ?? ''
  if (STICKER_HELP_FLAGS.has(firstArg)) {
    await safeReply(buildStickerHelpMessage())
    return
  }

  const source = await ctx.getStickerSourceMedia()
  if (!source) {
    await safeReply(
      'Não encontrei mídia para converter em figurinha.\n'
      + 'Use `!s` na legenda da mídia ou respondendo uma imagem/vídeo/sticker.\n'
      + 'Dica: `!s` sozinho reutiliza seu template salvo.\n'
      + 'Para ajuda completa use `!s -h`.'
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

    const commandArgsText = ctx.args.join(' ').trim()
    const savedTemplateText = await ctx.loadStickerTemplate()
    const savedTemplateParts = parseStickerPackOverridesFromText(savedTemplateText ?? '')
    const nextTemplateParts = parseStickerPackOverridesFromText(commandArgsText)
    const commandHasSlash = commandArgsText.includes('/')
    const hasNewText = commandArgsText.length > 0

    let rawPackName = savedTemplateParts.rawPackName
    let rawPackAuthor = savedTemplateParts.rawPackAuthor

    if (hasNewText) {
      if (commandHasSlash) {
        if (nextTemplateParts.rawPackName) rawPackName = nextTemplateParts.rawPackName
        if (nextTemplateParts.rawPackAuthor) rawPackAuthor = nextTemplateParts.rawPackAuthor
      } else {
        rawPackName = nextTemplateParts.rawPackName
      }
      const mergedTemplate = stringifyStickerTemplate(rawPackName, rawPackAuthor)
      if (mergedTemplate) {
        await ctx.saveStickerTemplate(mergedTemplate)
      }
    }

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

    try {
      await persistGeneratedSticker({
        sticker,
        sender: ctx.sender,
        packName: resolvedPackName,
        packAuthor: resolvedPackAuthor,
        templateText: hasNewText ? (stringifyStickerTemplate(rawPackName, rawPackAuthor) ?? commandArgsText) : null,
        record: (entry) => ctx.recordGeneratedSticker(entry),
      })
    } catch {
      // Não bloqueia envio do sticker se a persistência local/DB falhar.
    }

    await ctx.sendSticker({ sticker })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'erro desconhecido'
    await safeReply(`❌ Não foi possível gerar a figurinha: ${reason}`)
  }
}

export const stickerCommand: Command = {
  name: 'sticker',
  description: 'Converte mídia em figurinha (aliases: !s, !st). Ajuda: !s -h',
  execute: executeStickerCommand,
}

export const stickerAliasCommand: Command = {
  name: 's',
  description: 'Alias curto de !sticker. Suporta template salvo e !s -h',
  execute: executeStickerCommand,
}

export const stickerSecondAliasCommand: Command = {
  name: 'st',
  description: 'Segundo alias de !sticker. Ajuda detalhada: !st -h',
  execute: executeStickerCommand,
}
