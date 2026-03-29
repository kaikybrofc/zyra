import type { WASocket, proto } from '@whiskeysockets/baileys'
import type { AppLogger } from '../observability/logger.js'
import { commands } from '../commands/index.js'
import { getMessageText } from '../utils/message.js'

export async function handleMessagesUpsert(
  sock: WASocket,
  messages: proto.IWebMessageInfo[],
  logger: AppLogger
): Promise<void> {
  for (const message of messages) {
    if (!message.message) continue
    if (message.key.fromMe) continue

    const chatId = message.key.remoteJid
    if (!chatId) continue

    const text = getMessageText(message)
    if (!text) continue

    const trimmed = text.trim()
    if (!trimmed.startsWith('!')) continue

    const [name, ...args] = trimmed.slice(1).split(/\s+/)
    const command = commands[name.toLowerCase()]

    if (!command) continue

    try {
      await command.execute({ sock, message, chatId, text: trimmed, args })
    } catch (error) {
      logger.error({ err: error, command: name }, 'command failed')
    }
  }
}
