import type { CommandContext } from '../core/command-runtime/context.js'

export type Command = {
  name: string
  description: string
  execute: (ctx: CommandContext) => Promise<void>
}
