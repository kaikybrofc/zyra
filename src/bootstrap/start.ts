import { createLogger } from '../observability/logger.js'
import { createSocket } from '../core/connection/socket.js'
import { registerEvents } from '../events/register.js'
import { initMysqlSchema } from '../core/db/init.js'
import { config } from '../config/index.js'

const logger = createLogger()

/**
 * Inicializa o MySQL (se configurado), cria o socket e registra eventos.
 */
export async function start(): Promise<void> {
  await initMysqlSchema(logger)
  const connectionId = config.connectionId ?? 'default'
  const sock = await createSocket(connectionId, logger)
  registerEvents({ sock, logger, reconnect: start, connectionId })
  logger.info('Bot sendo iniciado com sucesso.')
}
