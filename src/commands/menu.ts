import { config } from '../config/index.js'
import type { Command } from './types.js'

type CommandsProvider = () => Record<string, Command>

/**
 * Cria o comando de menu com leitura dinâmica do registry de comandos.
 */
export const createMenuCommand = (getCommands: CommandsProvider): Command => ({
  name: 'menu',
  description: 'Mostra os comandos disponíveis',
  async execute(ctx) {
    const prefix = config.commandPrefix || '!'
    const availableCommands = Object.values(getCommands()).sort((a, b) => a.name.localeCompare(b.name))
    const lines = [
      '📚 Comandos disponíveis:',
      ...availableCommands.map((command) => `- ${prefix}${command.name} — ${command.description}`),
    ]

    await ctx.reply(lines.join('\n'))
  },
})
