import type { Command } from './types.js'
import { pingCommand } from './ping.js'

/**
 * Mapa de todos os comandos disponíveis no sistema.
 * As chaves correspondem ao nome do comando e os valores ao objeto de definição Command.
 */
export const commands: Record<string, Command> = {
  [pingCommand.name]: pingCommand,
}
