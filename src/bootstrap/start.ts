import { createLogger } from '../observability/logger.js'
import { createSocket } from '../core/connection/socket.js'
import { registerEvents } from '../events/register.js'

const logger = createLogger()

export async function start(): Promise<void> {
  const sock = await createSocket(logger)
  registerEvents({ sock, logger, reconnect: start })
  logger.info('bot started')
}
