import type { Command } from './types.js'
import { pingCommand } from './ping.js'

/**
 * Lista de comandos disponiveis no bot.
 */
export const commands: Record<string, Command> = {
  [pingCommand.name]: pingCommand,
}
