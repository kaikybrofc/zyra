import type { Command } from './types.js'
import { pingCommand } from './ping.js'

export const commands: Record<string, Command> = {
  [pingCommand.name]: pingCommand,
}
