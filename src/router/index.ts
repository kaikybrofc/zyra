import { type WASocket, type proto } from '@whiskeysockets/baileys'
import type { AppLogger } from '../observability/logger.js'
import { commands } from '../commands/index.js'
import { getMessageText, getNormalizedMessage } from '../utils/message.js'
import { config } from '../config/index.js'
import { createSqlStore, type SqlStore } from '../store/sql-store.js'

const COMMAND_PREFIX = '!'
const ANSI_RESET = '\x1b[0m'
const ANSI_BOLD = '\x1b[1m'
const ANSI_CYAN = '\x1b[36m'
const ANSI_GREEN = '\x1b[32m'
const ANSI_MAGENTA = '\x1b[35m'
const ANSI_GRAY = '\x1b[90m'

const colorize = (value: string, color: string): string =>
  process.stdout.isTTY ? `${color}${value}${ANSI_RESET}` : value

let defaultSqlStore: SqlStore | null = null

const resolveSqlStore = (sqlStore?: SqlStore): SqlStore => {
  if (sqlStore) return sqlStore
  if (!defaultSqlStore) {
    defaultSqlStore = createSqlStore()
  }
  return defaultSqlStore
}

export type IncomingMessageContext = {
  sock: WASocket
  message: proto.IWebMessageInfo
  chatId: string
  text: string | null
  isCommand: boolean
  commandName: string | null
  commandArgs: string[]
}

const buildContext = (
  sock: WASocket,
  message: proto.IWebMessageInfo
): IncomingMessageContext | null => {
  if (!message.message) return null
  const messageKey = message.key
  if (!messageKey) return null
  if (messageKey.fromMe && !config.allowOwnMessages) return null

  const chatId = messageKey.remoteJid
  if (!chatId) return null

  const text = getMessageText(message)
  const trimmed = text?.trim() ?? ''
  const isCommand = trimmed.startsWith(COMMAND_PREFIX)
  const [commandName, ...commandArgs] = isCommand
    ? trimmed.slice(COMMAND_PREFIX.length).split(/\s+/)
    : []

  return {
    sock,
    message,
    chatId,
    text,
    isCommand,
    commandName: commandName ?? null,
    commandArgs,
  }
}

const processIncomingMessage = async (
  context: IncomingMessageContext,
  logger: AppLogger
): Promise<void> => {
  const { type: messageType } = getNormalizedMessage(context.message)
  const mediaTypes = new Set([
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

  const messageKey = context.message.key
  const sender = messageKey?.participant ?? messageKey?.remoteJid ?? null
  const rawTimestamp = context.message.messageTimestamp
  const timestampSeconds =
    typeof rawTimestamp === 'number'
      ? rawTimestamp
      : typeof (rawTimestamp as { toNumber?: () => number } | null)?.toNumber === 'function'
        ? (rawTimestamp as { toNumber: () => number }).toNumber()
        : rawTimestamp
          ? Number(rawTimestamp)
          : null
  const timestampMs = timestampSeconds ? timestampSeconds * 1000 : null
  const timestampIso = timestampMs ? new Date(timestampMs).toISOString() : null
  const rawText = context.text?.trim()
  const text =
    rawText && rawText.length > 200 ? `${rawText.slice(0, 200)}...` : rawText ?? null
  const compactText = text ? text.replace(/\s+/g, ' ').trim() : null
  const hasMedia = messageType ? mediaTypes.has(messageType) : false
  const logParts = [
    `chatId=${context.chatId}`,
    `messageId=${messageKey?.id ?? ''}`,
    `fromMe=${messageKey?.fromMe ?? ''}`,
    `sender=${sender ?? ''}`,
    `pushName=${context.message.pushName ?? ''}`,
    `isGroup=${context.chatId.endsWith('@g.us')}`,
    `messageType=${messageType ? colorize(messageType, ANSI_MAGENTA) : ''}`,
    `hasMedia=${hasMedia}`,
    `text=${compactText ? JSON.stringify(compactText) : ''}`,
    `isCommand=${colorize(String(context.isCommand), context.isCommand ? ANSI_GREEN : ANSI_GRAY)}`,
    `commandName=${context.commandName ? colorize(context.commandName, ANSI_CYAN) : ''}`,
    `timestamp=${timestampIso ?? ''}`,
  ]
  const title = colorize('mensagem recebida', `${ANSI_BOLD}${ANSI_CYAN}`)
  logger.info(`\n\n${title} | ${logParts.join(' ')}`)
}

const handleCommand = async (
  context: IncomingMessageContext,
  logger: AppLogger,
  sqlStore: SqlStore
) => {
  if (!context.isCommand || !context.commandName) return

  const command = commands[context.commandName.toLowerCase()]
  if (!command) return

  const startedAt = Date.now()
  let success = true

  try {
    await command.execute({
      sock: context.sock,
      message: context.message,
      chatId: context.chatId,
      text: context.text?.trim() ?? '',
      args: context.commandArgs,
    })
  } catch (error) {
    success = false
    logger.error('comando falhou', { err: error, command: context.commandName })
  } finally {
    if (sqlStore.enabled) {
      const actorJid =
        context.message.key?.participant ??
        (!context.chatId.endsWith('@g.us') ? context.chatId : null)
      const durationMs = Date.now() - startedAt
      void sqlStore.recordCommandLog({
        actorJid,
        chatJid: context.chatId,
        commandName: context.commandName,
        argsText: context.commandArgs.length ? context.commandArgs.join(' ') : null,
        success,
        durationMs,
        data: { isGroup: context.chatId.endsWith('@g.us') },
      })
    }
  }
}

/**
 * Processa mensagens recebidas e executa comandos quando aplicavel.
 * Permite injetar a store SQL para multi-tenant.
 */
export async function handleIncomingMessages(
  sock: WASocket,
  messages: proto.IWebMessageInfo[],
  logger: AppLogger,
  sqlStore?: SqlStore
): Promise<void> {
  const resolvedSqlStore = resolveSqlStore(sqlStore)
  if (!messages.length) {
    logger.info('messages.upsert sem mensagens')
    return
  }
  for (const message of messages) {
    const context = buildContext(sock, message)
    if (!context) {
      logger.info('mensagem ignorada pelo buildContext', {
        hasMessage: Boolean(message.message),
        hasKey: Boolean(message.key),
        fromMe: message.key?.fromMe ?? null,
      })
      continue
    }

    await processIncomingMessage(context, logger)
    await handleCommand(context, logger, resolvedSqlStore)
  }
}
