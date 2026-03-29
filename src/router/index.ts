import {
  extractMessageContent,
  getContentType,
  normalizeMessageContent,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys'
import type { AppLogger } from '../observability/logger.js'
import { commands } from '../commands/index.js'
import { getMessageText } from '../utils/message.js'

const COMMAND_PREFIX = '!'

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
  if (messageKey.fromMe) return null

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
  const normalized = extractMessageContent(normalizeMessageContent(context.message.message))
  const messageType = normalized ? getContentType(normalized) : null
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

  logger.info('mensagem recebida', {
    chatId: context.chatId,
    messageId: messageKey?.id ?? null,
    fromMe: messageKey?.fromMe ?? null,
    sender,
    pushName: context.message.pushName ?? null,
    isGroup: context.chatId.endsWith('@g.us'),
    messageType,
    hasMedia: messageType ? mediaTypes.has(messageType) : false,
    text,
    isCommand: context.isCommand,
    commandName: context.commandName,
    timestamp: timestampIso,
  })
}

const handleCommand = async (context: IncomingMessageContext, logger: AppLogger) => {
  if (!context.isCommand || !context.commandName) return

  const command = commands[context.commandName.toLowerCase()]
  if (!command) return

  try {
    await command.execute({
      sock: context.sock,
      message: context.message,
      chatId: context.chatId,
      text: context.text?.trim() ?? '',
      args: context.commandArgs,
    })
  } catch (error) {
    logger.error('comando falhou', { err: error, command: context.commandName })
  }
}

export async function handleIncomingMessages(
  sock: WASocket,
  messages: proto.IWebMessageInfo[],
  logger: AppLogger
): Promise<void> {
  for (const message of messages) {
    const context = buildContext(sock, message)
    if (!context) continue

    await processIncomingMessage(context, logger)
    await handleCommand(context, logger)
  }
}
