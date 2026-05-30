import { type WAMessage, type WASocket, type proto } from 'baileys'
import fs from 'node:fs/promises'
import path from 'node:path'
import { domainToASCII } from 'node:url'
import linkify from 'linkifyjs'
import { commands } from '../../commands/index.js'
import type { AppLogger } from '../../observability/logger.js'
import type { SqlStore } from '../../store/sql-store.js'
import { config } from '../../config/index.js'
import { getMessageText, getNormalizedMessage } from '../../utils/message.js'
import { resolveStickerSourceMedia as resolveStickerSourceMediaFromMessage } from '../../utils/sticker.js'
import { createCommandAdminActions } from './admin.js'
import { CommandContext, type CommandSendOptions } from './context.js'
import { groupFeatureStore } from '../../store/group-feature-store.js'

const ANSI_RESET = '\x1b[0m'
const ANSI_BOLD = '\x1b[1m'
const ANSI_CYAN = '\x1b[36m'
const ANSI_GREEN = '\x1b[32m'
const ANSI_MAGENTA = '\x1b[35m'
const ANSI_GRAY = '\x1b[90m'
const ANSI_RED = '\x1b[31m'
const REACHOUT_TIMELOCK_STATUS_CODE = 463
const ANTIBAN_BLOCKED_MESSAGE = '[baileys-antiban] Message blocked'
const ANTIBAN_SEND_MAX_ATTEMPTS = 3
const NON_LINK_FILE_EXTENSIONS = new Set(['json', 'txt', 'md', 'log', 'csv', 'xml', 'yaml', 'yml', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar', '7z', 'tar', 'gz'])
const INTERNAL_WHATSAPP_HOSTS = new Set(['whatsapp.net', 'cdn.whatsapp.net'])
const PLAY_COMMAND_ANTILINK_BYPASS_COMMANDS = new Set(['play', 'playvid'])
const PLAY_COMMAND_ANTILINK_BYPASS_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'])
const MEDIA_TYPES = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage', 'contactMessage', 'contactsArrayMessage', 'locationMessage', 'liveLocationMessage'])

/**
 * Envelope de comando recebido, contendo dados extraídos e normalizados da mensagem.
 */
export type IncomingCommandEnvelope = {
  /** Instância do socket do Baileys. */
  sock: WASocket
  /** Mensagem original do Baileys. */
  message: WAMessage
  /** JID do chat. */
  chatId: string
  /** JID do remetente. */
  sender: string
  /** Texto completo da mensagem. */
  text: string
  /** Indica se é um grupo. */
  isGroup: boolean
  /** Nome do comando identificado (sem o prefixo), ou null se não for comando. */
  commandName: string | null
  /** Argumentos do comando. */
  commandArgs: string[]
  /** JIDs mencionados na mensagem de comando. */
  mentionedJids: string[]
  /** JID do autor da mensagem citada (quando existir). */
  quotedSender: string | null
}

/**
 * Opções para criação do processador de comandos.
 */
type CreateCommandProcessorOptions = {
  /** Logger da aplicação. */
  logger: AppLogger
  /** Store SQL para persistência de logs. Deve ser injetada pelo contexto da conexão. */
  sqlStore: SqlStore
}

/** Aplica cor ANSI somente quando a saída suporta TTY. */
const colorize = (value: string, color: string): string => (process.stdout.isTTY ? `${color}${value}${ANSI_RESET}` : value)

/**
 * Converte timestamp bruto do Baileys para número em segundos.
 * @param raw Valor bruto do timestamp.
 * @returns Timestamp em segundos ou `null` quando inválido.
 */
const parseTimestamp = (raw: unknown): number | null => {
  if (!raw) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof (raw as { toNumber?: () => number }).toNumber === 'function') {
    const value = (raw as { toNumber: () => number }).toNumber()
    return Number.isFinite(value) ? value : null
  }
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * Extrai status code de estruturas de erro conhecidas.
 * @param error Erro capturado durante envio/processamento.
 * @returns Código HTTP quando disponível.
 */
const isPlayCommandYoutubeBypass = (context: IncomingCommandEnvelope, links: string[]): boolean => {
  if (!PLAY_COMMAND_ANTILINK_BYPASS_COMMANDS.has(context.commandName ?? '')) return false
  if (!links.length) return false

  for (const link of links) {
    const url = parseLinkToUrl(link)
    if (!url) return false
    const hostname = url.hostname.toLowerCase()
    if (!PLAY_COMMAND_ANTILINK_BYPASS_HOSTS.has(hostname)) return false
  }

  return true
}

const getErrorStatusCode = (error: unknown): number | null => {
  const candidate = error as { output?: { statusCode?: unknown }; statusCode?: unknown } | null | undefined
  const raw = candidate?.output?.statusCode ?? candidate?.statusCode
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

const isAntiBanBlockedError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  return error.message.includes(ANTIBAN_BLOCKED_MESSAGE)
}

const getAntiBanBlockReason = (error: unknown): string | null => {
  if (!(error instanceof Error) || !error.message.includes(ANTIBAN_BLOCKED_MESSAGE)) return null
  const [, reason] = error.message.split(`${ANTIBAN_BLOCKED_MESSAGE}: `)
  return reason?.trim() || null
}

const getAntiBanRetryDelayMs = (reason: string | null, attempt: number): number | null => {
  if (!reason) return 2_000 * attempt

  if (reason.startsWith('Reachout timelocked')) {
    const match = reason.match(/Expires in (\d+)s\.?/)
    if (!match) return 60_000
    return Math.max(5_000, Number(match[1]) * 1000)
  }

  if (reason.startsWith('Warm-up limit:')) {
    return null
  }

  if (reason.startsWith('Health risk ')) {
    return null
  }

  if (reason === 'Rate limit exceeded or identical message spam detected') {
    const identicalWindowMs = config.antibanIdenticalMessageWindowMs
    const cappedWindowMs = identicalWindowMs === undefined ? 12_000 : Math.min(identicalWindowMs, 30_000)
    return Math.max(2_000 * attempt, cappedWindowMs)
  }

  return 2_000 * attempt
}

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const resolveUnwrappedSocket = (sock: WASocket): WASocket => {
  const prototype = Object.getPrototypeOf(sock) as WASocket | null
  if (!prototype) return sock
  if (typeof prototype.sendMessage !== 'function') return sock
  if (prototype.sendMessage === sock.sendMessage) return sock
  return prototype
}

const sendModerationMessage = async (sock: WASocket, chatId: string, content: Parameters<WASocket['sendMessage']>[1], options?: Parameters<WASocket['sendMessage']>[2]) => {
  const rawSock = resolveUnwrappedSocket(sock)
  if (options === undefined) {
    return rawSock.sendMessage(chatId, content)
  }
  return rawSock.sendMessage(chatId, content, options)
}

const parseLinkToUrl = (value: string): URL | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(normalized)
  } catch {
    return null
  }
}

const hasDetectableLink = (text: string): boolean => {
  for (const match of linkify.find(text)) {
    if (!match.isLink || match.type === 'email') continue
    const candidate = (match.value ?? '').trim().replace(/[)\],.!?;:]+$/g, '')
    const parsed = parseLinkToUrl(candidate)
    if (!parsed) continue
    if (!['http:', 'https:', 'ftp:'].includes(parsed.protocol)) continue
    const tld = parsed.hostname.toLowerCase().split('.').at(-1) ?? ''
    if (NON_LINK_FILE_EXTENSIONS.has(tld)) continue
    return true
  }
  return false
}

/**
 * Coleta menções e autor citado para comandos que operam em participantes.
 * @param message Mensagem recebida.
 * @returns JIDs mencionados e JID citado (se houver).
 */
const extractTargetHintsFromMessage = (message: proto.IWebMessageInfo): { mentionedJids: string[]; quotedSender: string | null } => {
  const { content, type } = getNormalizedMessage(message)
  if (!content || !type) {
    return { mentionedJids: [], quotedSender: null }
  }

  const node = (content as Record<string, unknown>)[type] as { contextInfo?: proto.IContextInfo } | null | undefined
  const contextInfo = node?.contextInfo
  const mentionedJids = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid.filter(Boolean) : []
  const quotedSender = contextInfo?.participant ?? null

  return { mentionedJids, quotedSender }
}

const extractQuotedStanzaIdFromMessage = (message: proto.IWebMessageInfo): string | null => {
  const { content, type } = getNormalizedMessage(message)
  if (!content || !type) return null
  const node = (content as Record<string, unknown>)[type] as { contextInfo?: proto.IContextInfo } | null | undefined
  return node?.contextInfo?.stanzaId ?? null
}

/**
 * Constrói um envelope de comando a partir de uma mensagem bruta do Baileys.
 * @param sock Instância do socket.
 * @param message Mensagem recebida.
 * @returns O envelope estruturado ou null se a mensagem deve ser ignorada.
 */
export const buildIncomingCommandEnvelope = (sock: WASocket, message: proto.IWebMessageInfo): IncomingCommandEnvelope | null => {
  if (!message.message || !message.key) return null
  if (message.key.fromMe && !config.allowOwnMessages) return null

  const chatId = message.key.remoteJid
  if (!chatId) return null

  const text = getMessageText(message)?.trim() ?? ''
  const prefix = config.commandPrefix || '!'
  const isCommand = text.startsWith(prefix)
  const commandTokens = isCommand ? text.slice(prefix.length).trim().split(/\s+/).filter(Boolean) : []
  const [commandName, ...commandArgs] = commandTokens
  const { mentionedJids, quotedSender } = extractTargetHintsFromMessage(message)

  return {
    sock,
    message: message as WAMessage,
    chatId,
    sender: message.key.participant ?? chatId,
    text,
    isGroup: chatId.endsWith('@g.us'),
    commandName: commandName?.toLowerCase() ?? null,
    commandArgs,
    mentionedJids,
    quotedSender,
  }
}

/**
 * Emite log estruturado de cada mensagem recebida para observabilidade.
 * @param context Envelope da mensagem normalizada.
 * @param logger Logger da aplicação.
 */
const logIncomingMessage = async (context: IncomingCommandEnvelope, logger: AppLogger): Promise<void> => {
  const { type: messageType } = getNormalizedMessage(context.message)
  const messageKey = context.message.key
  const rawTimestamp = context.message.messageTimestamp
  const timestampSeconds = parseTimestamp(rawTimestamp)
  const timestampMs = timestampSeconds ? timestampSeconds * 1000 : null
  const timestampIso = timestampMs ? new Date(timestampMs).toISOString() : null
  const text = context.text.length > 200 ? `${context.text.slice(0, 200)}...` : context.text || null
  const compactText = text ? text.replace(/\s+/g, ' ').trim() : null
  const hasMedia = messageType ? MEDIA_TYPES.has(messageType) : false
  const hasLink = Boolean(context.text && hasDetectableLink(context.text))
  const logParts = [`chatId=${context.chatId}`, `messageId=${messageKey.id ?? ''}`, `fromMe=${messageKey.fromMe ?? ''}`, `sender=${context.sender}`, `pushName=${context.message.pushName ?? ''}`, `isGroup=${context.isGroup}`, `messageType=${messageType ? colorize(messageType, ANSI_MAGENTA) : ''}`, `hasMedia=${hasMedia}`, `text=${compactText ? JSON.stringify(compactText) : ''}`, `hasLink=${colorize(String(hasLink), hasLink ? ANSI_RED : ANSI_GRAY)}`, `isCommand=${colorize(String(Boolean(context.commandName)), context.commandName ? ANSI_GREEN : ANSI_GRAY)}`, `commandName=${context.commandName ? colorize(context.commandName, ANSI_CYAN) : ''}`, `timestamp=${timestampIso ?? ''}`]
  const title = colorize('mensagem recebida', `${ANSI_BOLD}${hasLink ? ANSI_RED : ANSI_CYAN}`)
  logger.info(`\n\n${title} | ${logParts.join(' ')}`)
}

/**
 * Cria o `CommandContext` com utilitários de envio e ações administrativas.
 * @param context Envelope de comando já normalizado.
 * @param logger Logger para telemetria de falhas de envio.
 * @returns Contexto pronto para execução de comandos.
 */
const createRuntimeContext = (context: IncomingCommandEnvelope, logger: AppLogger, sqlStore: SqlStore, getRecentStickerMessage: (chatId: string) => WAMessage | null, getRecentMessageById: (chatId: string, messageId: string) => WAMessage | null): CommandContext => {
  const admin = createCommandAdminActions({
    sock: context.sock,
    chatId: context.chatId,
    sender: context.sender,
    isGroup: context.isGroup,
  })

  const resolveStickerSourceFromLocalCache = async (message: WAMessage): Promise<{ buffer: Buffer; mediaType: 'sticker' } | null> => {
    if (!config.mediaAutoDownload || !sqlStore.enabled) return null
    const chatJid = message.key.remoteJid
    const messageId = message.key.id
    if (!chatJid || !messageId) return null
    const stored = await sqlStore.getLocalMediaByMessageKey({
      chatJid,
      messageId,
      fromMe: Boolean(message.key.fromMe),
    })
    if (!stored || stored.mediaType !== 'stickerMessage') return null
    try {
      const absolutePath = path.isAbsolute(stored.localPath) ? stored.localPath : path.resolve(process.cwd(), stored.localPath)
      const buffer = await fs.readFile(absolutePath)
      if (!buffer.length) return null
      return { buffer, mediaType: 'sticker' }
    } catch {
      return null
    }
  }

  const send = async (content: Parameters<CommandContext['send']>[0], options?: CommandSendOptions) => {
    const { quote = true, ...sendOptions } = options ?? {}
    const finalOptions = quote ? { quoted: context.message, ...sendOptions } : sendOptions
    for (let attempt = 1; attempt <= ANTIBAN_SEND_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await context.sock.sendMessage(context.chatId, content, finalOptions)
      } catch (error) {
        const statusCode = getErrorStatusCode(error)
        if (statusCode === REACHOUT_TIMELOCK_STATUS_CODE) {
          logger.error('alerta de envio com restricao de conta (463)', {
            statusCode,
            chatId: context.chatId,
            sender: context.sender,
            commandName: context.commandName,
            recommendation: 'evite reachout para novos contatos e valide timelock/tctoken da conta',
            err: error,
          })
        }

        const antiBanReason = getAntiBanBlockReason(error)
        if (!isAntiBanBlockedError(error)) {
          throw error
        }

        if (attempt === ANTIBAN_SEND_MAX_ATTEMPTS) {
          logger.error('envio bloqueado pelo antiban apos esgotar retentativas', {
            chatId: context.chatId,
            sender: context.sender,
            commandName: context.commandName,
            attempt,
            maxAttempts: ANTIBAN_SEND_MAX_ATTEMPTS,
            antiBanReason,
            err: error,
          })
          throw error
        }

        const retryDelayMs = getAntiBanRetryDelayMs(antiBanReason, attempt)
        if (retryDelayMs === null) {
          logger.warn('envio bloqueado pelo antiban sem retentativa automatica', {
            chatId: context.chatId,
            sender: context.sender,
            commandName: context.commandName,
            attempt,
            maxAttempts: ANTIBAN_SEND_MAX_ATTEMPTS,
            antiBanReason,
          })
          throw error
        }

        logger.warn('envio bloqueado pelo antiban, aplicando retentativa', {
          chatId: context.chatId,
          sender: context.sender,
          commandName: context.commandName,
          attempt,
          maxAttempts: ANTIBAN_SEND_MAX_ATTEMPTS,
          retryDelayMs,
          antiBanReason,
        })
        await wait(retryDelayMs)
      }
    }
    return undefined
  }

  return new CommandContext({
    chatId: context.chatId,
    sender: context.sender,
    text: context.text,
    args: context.commandArgs,
    isGroup: context.isGroup,
    commandName: context.commandName ?? '',
    messageId: context.message.key.id ?? null,
    pushName: context.message.pushName ?? null,
    mentionedJids: context.mentionedJids,
    quotedSender: context.quotedSender,
    admin,
    send,
    reply: async (text) => {
      await send({ text })
    },
    react: async (emoji) => {
      await send(
        {
          react: { text: emoji, key: context.message.key },
        },
        { quote: false }
      )
    },
    resolveStickerSourceMedia: async () => {
      const directSource = await resolveStickerSourceMediaFromMessage(context.message)
      if (directSource) return directSource
      const localDirectSource = await resolveStickerSourceFromLocalCache(context.message)
      if (localDirectSource) return localDirectSource
      const quotedStanzaId = extractQuotedStanzaIdFromMessage(context.message)
      if (quotedStanzaId) {
        const quotedMessage = getRecentMessageById(context.chatId, quotedStanzaId)
        if (quotedMessage) {
          const quotedSource = await resolveStickerSourceMediaFromMessage(quotedMessage)
          if (quotedSource) return quotedSource
          const localQuotedSource = await resolveStickerSourceFromLocalCache(quotedMessage)
          if (localQuotedSource) return localQuotedSource
        }
      }
      const fallbackMessage = getRecentStickerMessage(context.chatId)
      if (!fallbackMessage) return null
      const fallbackSource = await resolveStickerSourceMediaFromMessage(fallbackMessage)
      if (fallbackSource) return fallbackSource
      return resolveStickerSourceFromLocalCache(fallbackMessage)
    },
    saveStickerTemplate: async (templateText) => {
      if (!sqlStore.enabled) return
      await sqlStore.setUserStickerTemplate({ userJid: context.sender, templateText })
    },
    loadStickerTemplate: async () => {
      if (!sqlStore.enabled) return null
      return sqlStore.getUserStickerTemplate(context.sender)
    },
    recordGeneratedSticker: async (entry) => {
      if (!sqlStore.enabled) return
      await sqlStore.recordUserGeneratedSticker({
        userJid: context.sender,
        chatJid: context.chatId,
        packName: entry.packName,
        packAuthor: entry.packAuthor,
        templateText: entry.templateText ?? null,
        localPath: entry.localPath,
        fileSha256: entry.fileSha256,
        fileLength: entry.fileLength,
        mimeType: entry.mimeType ?? null,
        data: entry.data,
      })
    },
  })
}

/**
 * Registra o resultado da execução de um comando no SQL store.
 * @param sqlStore Store responsável por persistir logs de comando.
 * @param context Envelope do comando executado.
 * @param durationMs Duração total da execução em milissegundos.
 * @param success Indica sucesso (`true`) ou falha (`false`) da execução.
 */
const recordCommandExecution = (sqlStore: SqlStore, context: IncomingCommandEnvelope, durationMs: number, success: boolean): void => {
  if (!sqlStore.enabled || !context.commandName) return

  const messageKey = context.message.key
  const selfJid = messageKey.fromMe ? (context.sock.user?.id ?? null) : null
  const actorJid = selfJid ?? messageKey.participant ?? (!context.isGroup ? context.chatId : null)
  void sqlStore.recordCommandLog({
    actorJid,
    chatJid: context.chatId,
    commandName: context.commandName,
    argsText: context.commandArgs.length ? context.commandArgs.join(' ') : null,
    success,
    durationMs,
    data: { isGroup: context.isGroup },
  })
}

/**
 * Processador de comandos que lida com o ciclo de vida de uma mensagem recebida.
 */
export type CommandProcessor = {
  /**
   * Processa uma mensagem de entrada, identifica se é um comando e o executa.
   * @param sock Instância do socket do Baileys.
   * @param message Mensagem bruta recebida.
   */
  process: (sock: WASocket, message: proto.IWebMessageInfo) => Promise<void>
}

/**
 * Cria uma instância do processador de comandos.
 * @param options Dependências do processador.
 * @returns Um objeto CommandProcessor.
 */
const MAX_SENDER_TRACKING_ENTRIES = 5_000
const MAX_CHAT_TRACKING_ENTRIES = 2_000

export function createCommandProcessor({ logger, sqlStore }: CreateCommandProcessorOptions): CommandProcessor {
  const recentMessagesBySender = new Map<string, proto.IMessageKey[]>()
  const recentStickerMessagesByChat = new Map<string, WAMessage[]>()
  const recentMessagesByChat = new Map<string, WAMessage[]>()

  const normalizeParticipantId = (jid: string): string => {
    const normalized = jid.trim().toLowerCase()
    const [user, domain] = normalized.split('@')
    if (!user || !domain) return normalized
    const baseUser = user.split(':')[0] ?? user
    return `${baseUser}@${domain}`
  }

  const toUserKey = (jid: string): string => {
    const normalized = normalizeParticipantId(jid)
    const [user] = normalized.split('@')
    return user ?? normalized
  }

  const trackRecentSenderMessage = (context: IncomingCommandEnvelope): void => {
    if (!context.isGroup) return
    const key = context.message.key
    if (!key?.id || !key.remoteJid || !key.participant || key.fromMe) return
    const senderKey = `${context.chatId}|${normalizeParticipantId(context.sender)}`
    const current = recentMessagesBySender.get(senderKey) ?? []
    current.push({
      id: key.id,
      remoteJid: key.remoteJid,
      participant: key.participant,
      fromMe: Boolean(key.fromMe),
    })
    const lastFive = current.slice(-5)
    recentMessagesBySender.set(senderKey, lastFive)
    if (recentMessagesBySender.size > MAX_SENDER_TRACKING_ENTRIES) {
      const oldest = recentMessagesBySender.keys().next().value
      if (oldest !== undefined) recentMessagesBySender.delete(oldest)
    }
  }

  const trackRecentStickerMessage = (context: IncomingCommandEnvelope): void => {
    const { type: messageType } = getNormalizedMessage(context.message)
    if (messageType !== 'stickerMessage') return
    const list = recentStickerMessagesByChat.get(context.chatId) ?? []
    list.push(context.message)
    recentStickerMessagesByChat.set(context.chatId, list.slice(-8))
    if (recentStickerMessagesByChat.size > MAX_CHAT_TRACKING_ENTRIES) {
      const oldest = recentStickerMessagesByChat.keys().next().value
      if (oldest !== undefined) recentStickerMessagesByChat.delete(oldest)
    }
  }

  const trackRecentChatMessage = (context: IncomingCommandEnvelope): void => {
    if (!context.message?.key?.id) return
    const list = recentMessagesByChat.get(context.chatId) ?? []
    list.push(context.message)
    recentMessagesByChat.set(context.chatId, list.slice(-200))
    if (recentMessagesByChat.size > MAX_CHAT_TRACKING_ENTRIES) {
      const oldest = recentMessagesByChat.keys().next().value
      if (oldest !== undefined) recentMessagesByChat.delete(oldest)
    }
  }

  const getRecentStickerMessage = (chatId: string): WAMessage | null => {
    const list = recentStickerMessagesByChat.get(chatId)
    if (!list?.length) return null
    return list[list.length - 1] ?? null
  }

  const getRecentMessageById = (chatId: string, messageId: string): WAMessage | null => {
    const list = recentMessagesByChat.get(chatId)
    if (!list?.length) return null
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const candidate = list[index]
      if (candidate?.key?.id === messageId) return candidate
    }
    return null
  }

  const deleteRecentMessagesFromSender = async (context: IncomingCommandEnvelope): Promise<{ deleted: number; total: number }> => {
    const senderKey = `${context.chatId}|${normalizeParticipantId(context.sender)}`
    const recentKeys = [...(recentMessagesBySender.get(senderKey) ?? [])]
    if (!recentKeys.length) return { deleted: 0, total: 0 }

    const firstPass = await Promise.allSettled(
      recentKeys.map(async (key) => {
        await sendModerationMessage(context.sock, context.chatId, { delete: key })
      })
    )

    const failedIndexes: number[] = []
    let deleted = 0
    for (let index = 0; index < firstPass.length; index += 1) {
      if (firstPass[index]?.status === 'fulfilled') {
        deleted += 1
      } else {
        failedIndexes.push(index)
      }
    }

    // Revalidação: tenta novamente os deletes que falharam na primeira passagem.
    for (const index of failedIndexes) {
      const key = recentKeys[index]
      if (!key) continue
      try {
        await sendModerationMessage(context.sock, context.chatId, { delete: key })
        deleted += 1
      } catch (error) {
        logger.warn('falha ao revalidar delete de mensagem no antilink', {
          chatId: context.chatId,
          sender: context.sender,
          messageId: key.id ?? null,
          err: error,
        })
      }
    }

    recentMessagesBySender.delete(senderKey)
    return { deleted, total: recentKeys.length }
  }

  const extractLinks = (text: string): string[] => {
    const matches = linkify.find(text)
    const deduped = new Set<string>()
    for (const match of matches) {
      if (!match.isLink || match.type === 'email') continue
      const candidate = (match.value ?? '').trim().replace(/[)\],.!?;:]+$/g, '')
      if (!candidate) continue
      const parsed = parseLinkToUrl(candidate)
      if (!parsed) continue
      if (!['http:', 'https:', 'ftp:'].includes(parsed.protocol)) continue
      const tld = parsed.hostname.toLowerCase().split('.').at(-1) ?? ''
      if (NON_LINK_FILE_EXTENSIONS.has(tld)) continue
      deduped.add(candidate)
    }
    return [...deduped]
  }

  const normalizeLinkToUrl = (link: string): URL | null => {
    return parseLinkToUrl(link)
  }

  const isAllowedByDomain = (url: URL, allowedDomains: string[]): boolean => {
    const normalizeDomainCandidate = (value: string): { host: string; wildcard: boolean } | null => {
      const trimmed = value.trim().toLowerCase()
      if (!trimmed) return null
      const wildcard = trimmed.startsWith('*.')
      const raw = wildcard ? trimmed.slice(2) : trimmed
      const withoutProtocol = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      const hostPart = withoutProtocol.split('/')[0]?.split(':')[0]?.replace(/\.+$/, '') ?? ''
      if (!hostPart) return null
      const asciiHost = domainToASCII(hostPart).toLowerCase()
      if (!asciiHost) return null
      return { host: asciiHost, wildcard }
    }

    const normalizedHost = domainToASCII(url.hostname.replace(/\.+$/, '')).toLowerCase()
    if (!normalizedHost) return false

    return allowedDomains.some((domain) => {
      const normalizedDomain = normalizeDomainCandidate(domain)
      if (!normalizedDomain) return false
      if (normalizedDomain.wildcard) {
        return normalizedHost.endsWith(`.${normalizedDomain.host}`) && normalizedHost !== normalizedDomain.host
      }
      return normalizedHost === normalizedDomain.host || normalizedHost.endsWith(`.${normalizedDomain.host}`)
    })
  }

  const extractInviteCode = (url: URL): string | null => {
    if (url.hostname.toLowerCase() !== 'chat.whatsapp.com') return null
    const firstPathSegment = url.pathname.replace(/^\/+/, '').split('/')[0]
    if (!firstPathSegment) return null
    return firstPathSegment
  }

  const isInternalWhatsAppLink = (url: URL): boolean => {
    const host = url.hostname.toLowerCase()
    if (host === 'chat.whatsapp.com' || host === 'wa.me') return false
    return host === 'whatsapp.net' || host.endsWith('.whatsapp.net') || INTERNAL_WHATSAPP_HOSTS.has(host)
  }

  type GroupWithLinkedParent = {
    id?: string | null
    linkedParent?: string | null
  }

  const enforceAntilink = async (context: IncomingCommandEnvelope): Promise<void> => {
    if (!context.isGroup) return
    if (!context.text) return

    const enabled = await groupFeatureStore.isAntilinkEnabled(context.chatId)
    if (!enabled) {
      logger.info('antilink ignorado: desativado no grupo', { chatId: context.chatId })
      return
    }
    const links = extractLinks(context.text)
    if (!links.length) return
    const messageKey = context.message.key
    const messageTimestamp = parseTimestamp(context.message.messageTimestamp)
    const messageTextPreview = context.text.length > 500 ? `${context.text.slice(0, 500)}...` : context.text
    const { type: messageType } = getNormalizedMessage(context.message)
    const allowedDomains = await groupFeatureStore.getAntilinkAllowedDomains(context.chatId)
    const allowOwnInvite = await groupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled(context.chatId)

    let ownInviteCode: string | null = null
    let foundExternalLink = false
    const shouldAllowMessage = async (): Promise<boolean> => {
      for (const link of links) {
        const url = normalizeLinkToUrl(link)
        if (!url) return false
        if (isInternalWhatsAppLink(url)) continue
        foundExternalLink = true
        if (isAllowedByDomain(url, allowedDomains)) continue
        if (!allowOwnInvite) return false

        const inviteCode = extractInviteCode(url)
        if (!inviteCode) return false
        if (!ownInviteCode) {
          ownInviteCode = (await context.sock.groupInviteCode(context.chatId)) ?? null
        }
        if (inviteCode !== ownInviteCode) return false
      }
      return true
    }

    if (await shouldAllowMessage()) {
      logger.info('antilink: mensagem permitida por whitelist/invite', { chatId: context.chatId, sender: context.sender, links })
      return
    }

    if (isPlayCommandYoutubeBypass(context, links)) {
      logger.info('antilink ignorado: link do youtube usado no comando play', {
        chatId: context.chatId,
        sender: context.sender,
        links,
      })
      return
    }

    if (messageType === 'stickerMessage' && !foundExternalLink) {
      logger.info('antilink ignorado: sticker com link interno do WhatsApp', {
        chatId: context.chatId,
        sender: context.sender,
      })
      return
    }

    const metadata = await context.sock.groupMetadata(context.chatId)
    const sender = normalizeParticipantId(context.sender)
    const botJid = normalizeParticipantId(context.sock.user?.id ?? '')
    const participantById = new Map(metadata.participants.map((participant) => [normalizeParticipantId(participant.id), participant]))
    const participantByUserKey = new Map(metadata.participants.map((participant) => [toUserKey(participant.id), participant]))
    const senderParticipant = participantById.get(sender) ?? participantByUserKey.get(toUserKey(sender))

    const senderIsAdmin = Boolean(senderParticipant && (senderParticipant.admin === 'admin' || senderParticipant.admin === 'superadmin'))

    if (senderIsAdmin) {
      logger.info('antilink ignorado: remetente admin', { chatId: context.chatId, sender: context.sender, links })
      logger.info('antilink: evento detalhado (admin ignorado)', {
        chatId: context.chatId,
        sender: context.sender,
        pushName: context.message.pushName ?? null,
        messageId: messageKey.id ?? null,
        messageTimestamp,
        messageType: messageType ?? null,
        textPreview: messageTextPreview,
        links,
        allowedDomains,
        allowOwnInvite,
      })
      try {
        await sendModerationMessage(context.sock, context.chatId, {
          text: `ℹ️ Link detectado na mensagem de ${context.message.pushName ?? 'um administrador'}, mas nenhuma remoção foi aplicada porque o remetente é admin.`,
        })
      } catch (error) {
        logger.warn('falha ao enviar aviso de antilink para admin', {
          chatId: context.chatId,
          sender: context.sender,
          err: error,
        })
      }
      return
    }
    try {
      await context.sock.groupParticipantsUpdate(context.chatId, [context.sender], 'remove')
    } catch (error) {
      logger.warn('antilink não aplicado: falha ao remover participante', {
        chatId: context.chatId,
        botJid,
        sender: context.sender,
        links,
        err: error,
      })
      return
    }

    const removeFromLinkedCommunityGroups = async () => {
      const communityJid = (metadata as GroupWithLinkedParent | null | undefined)?.linkedParent ?? null
      if (!communityJid) return { communityJid: null as string | null, cascadedGroups: [] as string[] }
      const fetchAll = (context.sock as { groupFetchAllParticipating?: () => Promise<Record<string, GroupWithLinkedParent>> }).groupFetchAllParticipating
      if (typeof fetchAll !== 'function') return { communityJid, cascadedGroups: [] as string[] }

      try {
        const groupMap = await fetchAll()
        const siblingGroupJids = Object.values(groupMap)
          .map((group) => group.id ?? null)
          .filter((groupJid): groupJid is string => Boolean(groupJid))
          .filter((groupJid) => groupJid !== context.chatId)
          .filter((groupJid) => (groupMap[groupJid]?.linkedParent ?? null) === communityJid)

        const removedFromGroups: string[] = []
        for (const siblingJid of siblingGroupJids) {
          try {
            await context.sock.groupParticipantsUpdate(siblingJid, [context.sender], 'remove')
            removedFromGroups.push(siblingJid)
          } catch (error) {
            logger.warn('antilink: falha ao remover participante de grupo vinculado da comunidade', {
              sourceChatId: context.chatId,
              targetChatId: siblingJid,
              communityJid,
              sender: context.sender,
              err: error,
            })
          }
        }
        return { communityJid, cascadedGroups: removedFromGroups }
      } catch (error) {
        logger.warn('antilink: falha ao listar grupos da comunidade para remocao em cascata', {
          chatId: context.chatId,
          communityJid,
          sender: context.sender,
          err: error,
        })
        return { communityJid, cascadedGroups: [] as string[] }
      }
    }

    const cascadeResult = await removeFromLinkedCommunityGroups()

    const { deleted, total } = await deleteRecentMessagesFromSender(context)
    logger.warn('antilink: usuario removido por violacao de link (detalhado)', {
      sourceChatId: context.chatId,
      sender: context.sender,
      pushName: context.message.pushName ?? null,
      messageId: messageKey.id ?? null,
      messageTimestamp,
      messageType: messageType ?? null,
      textPreview: messageTextPreview,
      links,
      allowedDomains,
      allowOwnInvite,
      communityJid: cascadeResult.communityJid,
      removedFromLinkedGroups: cascadeResult.cascadedGroups,
      removedFromLinkedGroupsCount: cascadeResult.cascadedGroups.length,
      deletedMessagesCount: deleted,
      trackedMessagesCount: total,
    })
    try {
      await sendModerationMessage(context.sock, context.chatId, {
        text: 'o user foi banido pelo sistema de anti link',
      })
    } catch (error) {
      logger.warn('falha ao enviar confirmacao de acao do antilink', {
        chatId: context.chatId,
        sender: context.sender,
        deleted,
        total,
        err: error,
      })
    }
  }

  return {
    async process(sock, message) {
      const context = buildIncomingCommandEnvelope(sock, message)
      if (!context) {
        logger.info('mensagem ignorada pelo processor', {
          hasMessage: Boolean(message.message),
          hasKey: Boolean(message.key),
          fromMe: message.key?.fromMe ?? null,
        })
        return
      }

      await logIncomingMessage(context, logger)
      trackRecentSenderMessage(context)
      trackRecentStickerMessage(context)
      trackRecentChatMessage(context)
      try {
        await enforceAntilink(context)
      } catch (error) {
        logger.error('falha ao aplicar antilink', { err: error, chatId: context.chatId, sender: context.sender })
      }

      if (!context.commandName) return

      const command = commands[context.commandName]
      if (!command) return

      const startedAt = Date.now()
      let success = true
      const cmdCtx = createRuntimeContext(context, logger, sqlStore, getRecentStickerMessage, getRecentMessageById)

      try {
        await command.execute(cmdCtx)
      } catch (error) {
        success = false
        logger.error('comando falhou', { err: error, command: context.commandName })
        try {
          await cmdCtx.reply('❌ Ocorreu um erro interno ao executar este comando.')
        } catch (sendError) {
          logger.error('falha ao enviar aviso de erro do comando', {
            err: sendError,
            command: context.commandName,
          })
        }
      } finally {
        recordCommandExecution(sqlStore, context, Date.now() - startedAt, success)
      }
    },
  }
}
