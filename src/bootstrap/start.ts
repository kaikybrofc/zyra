import type { WASocket } from '@whiskeysockets/baileys'
import { createLogger, type AppLogger } from '../observability/logger.js'
import { createSocket } from '../core/connection/socket.js'
import { registerEvents } from '../events/register.js'
import { initMysqlSchema } from '../core/db/init.js'
import { config } from '../config/index.js'

let loggerRef: AppLogger | null = null
const RECONNECT_MIN_DELAY_MS = Math.max(500, Number(process.env.WA_RECONNECT_MIN_DELAY_MS ?? 2500))
let schemaInitPromise: Promise<void> | null = null
let reconnectPromise: Promise<void> | null = null
let activeSocket: WASocket | null = null
let socketGeneration = 0
let lastReconnectAt = 0

const getLogger = (): AppLogger => {
  if (!loggerRef) {
    loggerRef = createLogger()
  }
  return loggerRef
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const ensureSchemaReady = async () => {
  const logger = getLogger()
  if (!schemaInitPromise) {
    schemaInitPromise = initMysqlSchema(logger).catch((error) => {
      schemaInitPromise = null
      throw error
    })
  }
  await schemaInitPromise
}

const replaceSocket = async (reason: string) => {
  const logger = getLogger()
  await ensureSchemaReady()
  const connectionId = config.connectionId ?? 'default'
  const generation = ++socketGeneration
  const previousSocket = activeSocket

  if (previousSocket) {
    logger.warn('encerrando socket anterior para iniciar nova geração', {
      connectionId,
      generation,
      reason,
    })
    try {
      ;(previousSocket.ev as { removeAllListeners?: (...args: unknown[]) => unknown }).removeAllListeners?.()
    } catch (error) {
      logger.debug('falha ao remover listeners do socket anterior', {
        err: error,
        connectionId,
        generation,
      })
    }
    try {
      await previousSocket.end(new Error(`socket replaced: ${reason}`))
    } catch (error) {
      logger.debug('falha ao encerrar socket anterior (seguindo com nova conexão)', {
        err: error,
        connectionId,
        generation,
      })
    }
  }

  const sock = await createSocket(connectionId, logger)
  activeSocket = sock

  const reconnectFromThisSocket = async () => {
    if (generation !== socketGeneration) {
      logger.debug('ignorando pedido de reconexão de socket antigo', {
        connectionId,
        generation,
        currentGeneration: socketGeneration,
      })
      return
    }
    await scheduleReconnect(`connection_close_generation_${generation}`)
  }

  registerEvents({ sock, logger, reconnect: reconnectFromThisSocket, connectionId })
  logger.info('Bot sendo iniciado com sucesso.', { connectionId, generation, reason })
}

const scheduleReconnect = async (reason: string) => {
  const logger = getLogger()
  if (reconnectPromise) {
    logger.warn('reconexão já em andamento, ignorando solicitação paralela', { reason })
    return reconnectPromise
  }

  reconnectPromise = (async () => {
    const elapsedSinceLastReconnect = Date.now() - lastReconnectAt
    const waitMs = Math.max(0, RECONNECT_MIN_DELAY_MS - elapsedSinceLastReconnect)
    if (waitMs > 0) {
      logger.info('aguardando janela mínima antes de reconectar', { waitMs, reason })
      await wait(waitMs)
    }
    await replaceSocket(reason)
    lastReconnectAt = Date.now()
  })().finally(() => {
    reconnectPromise = null
  })

  return reconnectPromise
}

/**
 * Inicializa o MySQL (se configurado), cria o socket e registra eventos.
 */
export async function start(): Promise<void> {
  await scheduleReconnect('startup')
}
