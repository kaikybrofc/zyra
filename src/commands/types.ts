import type { CommandContext } from '../core/command-runtime/context.js'

/**
 * Interface que define a estrutura de um comando do sistema.
 */
export type Command = {
  /** Nome único do comando (usado para invocação). */
  name: string
  /** Descrição breve da funcionalidade do comando. */
  description: string
  /**
   * Lógica de execução do comando.
   * @param ctx Contexto do comando contendo dados da mensagem e métodos utilitários.
   */
  execute: (ctx: CommandContext) => Promise<void>
}
