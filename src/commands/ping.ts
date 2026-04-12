import type { Command } from './types.js'

/**
 * Comando simples para validar se o bot esta respondendo.
 */
export const pingCommand: Command = {
  name: 'ping',
  description: 'Responde pong para verificar se o bot está ativo',
  async execute(ctx) {
    await ctx.reply('pong! sistema ativo e operando sem problemas.')
  },
}
