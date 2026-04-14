import { type WAMessage, type WASocket, type proto } from '@whiskeysockets/baileys'
import { commands } from '../../commands/index.js'
import type { AppLogger } from '../../observability/logger.js'
import type { SqlStore } from '../../store/sql-store.js'
import { config } from '../../config/index.js'
import { getMessageText, getNormalizedMessage } from '../../utils/message.js'
import { createCommandAdminActions } from './admin.js'
import { CommandContext, type CommandSendOptions } from './context.js'

const ANSI_RESET = '\x1b[0m'
const ANSI_BOLD = '\x1b[1m'
const ANSI_CYAN = '\x1b[36m'
const ANSI_GREEN = '\x1b[32m'
const ANSI_MAGENTA = '\x1b[35m'
const ANSI_GRAY = '\x1b[90m'
const MEDIA_TYPES = new Set([
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
  'ptvMessage',
  'contactMessage',
  'contactsArrayMessage',
  'locationMessage',
  'liveLocationMessage',
])

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

const colorize = (value: string, color: string): string => (process.stdout.isTTY ? `${color}${value}${ANSI_RESET}` : value)

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
 * Constrói um envelope de comando a partir de uma mensagem bruta do Baileys.
 * @param sock Instância do socket.
 * @param message Mensagem recebida.
 * @returns O envelope estruturado ou null se a mensagem deve ser ignorada.
 */
export const buildIncomingCommandEnvelope = (
  sock: WASocket,
  message: proto.IWebMessageInfo
): IncomingCommandEnvelope | null => {
  if (!message.message || !message.key) return null
  if (message.key.fromMe && !config.allowOwnMessages) return null

  const chatId = message.key.remoteJid
  if (!chatId) return null

  const text = getMessageText(message)?.trim() ?? ''
  const prefix = config.commandPrefix || '!'
  const isCommand = text.startsWith(prefix)
  const commandTokens = isCommand ? text.slice(prefix.length).trim().split(/\s+/).filter(Boolean) : []
  const [commandName, ...commandArgs] = commandTokens

  return {
    sock,
    message: message as WAMessage,
    chatId,
    sender: message.key.participant ?? chatId,
    text,
    isGroup: chatId.endsWith('@g.us'),
    commandName: commandName?.toLowerCase() ?? null,
    commandArgs,
  }
}

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
  const logParts = [
    `chatId=${context.chatId}`,
    `messageId=${messageKey.id ?? ''}`,
    `fromMe=${messageKey.fromMe ?? ''}`,
    `sender=${context.sender}`,
    `pushName=${context.message.pushName ?? ''}`,
    `isGroup=${context.isGroup}`,
    `messageType=${messageType ? colorize(messageType, ANSI_MAGENTA) : ''}`,
    `hasMedia=${hasMedia}`,
    `text=${compactText ? JSON.stringify(compactText) : ''}`,
    `isCommand=${colorize(String(Boolean(context.commandName)), context.commandName ? ANSI_GREEN : ANSI_GRAY)}`,
    `commandName=${context.commandName ? colorize(context.commandName, ANSI_CYAN) : ''}`,
    `timestamp=${timestampIso ?? ''}`,
  ]
  const title = colorize('mensagem recebida', `${ANSI_BOLD}${ANSI_CYAN}`)
  logger.info(`\n\n${title} | ${logParts.join(' ')}`)
}

const createRuntimeContext = (context: IncomingCommandEnvelope): CommandContext => {
  const admin = createCommandAdminActions({
    sock: context.sock,
    chatId: context.chatId,
    sender: context.sender,
    isGroup: context.isGroup,
  })

  const send = async (content: Parameters<CommandContext['send']>[0], options?: CommandSendOptions) => {
    const { quote = true, ...sendOptions } = options ?? {}
    const finalOptions = quote ? { quoted: context.message, ...sendOptions } : sendOptions
    return context.sock.sendMessage(context.chatId, content, finalOptions)
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
  })
}

const recordCommandExecution = (
  sqlStore: SqlStore,
  context: IncomingCommandEnvelope,
  durationMs: number,
  success: boolean
): void => {
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
export function createCommandProcessor({ logger, sqlStore }: CreateCommandProcessorOptions): CommandProcessor {
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

      if (!context.commandName) return

      const command = commands[context.commandName]
      if (!command) return

      const startedAt = Date.now()
      let success = true
      const cmdCtx = createRuntimeContext(context)

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
