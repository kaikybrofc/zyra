import { createLogger } from '../observability/logger.js'
import { createSocket } from '../core/connection/socket.js'
import { registerEvents } from '../events/register.js'
import { initMysqlSchema } from '../core/db/init.js'

const logger = createLogger()

export async function start(): Promise<void> {
  await initMysqlSchema(logger)
  const sock = await createSocket(logger)
  registerEvents({ sock, logger, reconnect: start })
  logger.info('Bot sendo iniciado com sucesso.')
}
