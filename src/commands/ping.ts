import type { Command } from './types.js'

/**
 * Comando simples utilizado para validar se o bot está respondendo.
 */
export const pingCommand: Command = {
  /** Identificador do comando. */
  name: 'ping',
  /** Descrição do comando exibida na ajuda. */
  description: 'Responde pong para verificar se o bot está ativo',
  /** Executa a resposta de teste. */
  async execute(ctx) {
    await ctx.reply('pong! sistema ativo e operando sem problemas.')
  },
}
