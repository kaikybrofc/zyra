import type { WASocket, proto } from '@whiskeysockets/baileys'

export type CommandContext = {
  sock: WASocket
  message: proto.IWebMessageInfo
  chatId: string
  text: string
  args: string[]
}

export type Command = {
  name: string
  description: string
  execute: (context: CommandContext) => Promise<void>
}
