import type { proto } from '@whiskeysockets/baileys'

export function getMessageText(message: proto.IWebMessageInfo): string | null {
  const msg = message.message
  if (!msg) return null

  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    msg.documentMessage?.caption ??
    null
  )
}
