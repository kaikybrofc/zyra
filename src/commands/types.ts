import type { CommandContext } from '../core/commands/context.js'

export type Command = {
  name: string
  description: string
  execute: (ctx: CommandContext) => Promise<void>
}
