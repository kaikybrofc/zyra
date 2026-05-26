import type { RowDataPacket } from 'mysql2/promise'
import type { WASocket } from 'baileys'
import { createLogger, type AppLogger } from '../../observability/logger.js'
import { createSocket, isShutdownInProgress, unregisterShutdownTarget } from './socket.js'
import { registerEvents } from '../../events/register.js'
import { initMysqlSchema } from '../db/init.js'
import { getMysqlPool } from '../db/mysql.js'
import { config } from '../../config/index.js'

/** Estado da conexão ao longo do seu ciclo de vida. */
export type ConnectionStatus = 'created' | 'connecting' | 'qr' | 'open' | 'closed' | 'error'

type ConnectionRuntime = {
  connectionId: string
  activeSocket: WASocket | null
  reconnectPromise: Promise<void> | null
  socketGeneration: number
  lastReconnectAt: number
  status: ConnectionStatus
  qrCode: string | null
  qrCodeAt: number | null
  label: string | null
}

/** Representação pública de uma conexão — retornada pelos endpoints da API. */
export type ConnectionInfo = {
  connectionId: string
  label: string | null
  status: ConnectionStatus
  socketGeneration: number
  lastReconnectAt: number
  reconnectInFlight: boolean
  socketActive: boolean
  qrCode: string | null
  qrCodeAt: number | null
}

type StartupConnectionRow = RowDataPacket & { connection_id: string }

const RECONNECT_MIN_DELAY_MS = Math.max(500, Number(process.env.WA_RECONNECT_MIN_DELAY_MS ?? 2500))

let loggerRef: AppLogger | null = null
let schemaInitPromise: Promise<void> | null = null
const runtimes = new Map<string, ConnectionRuntime>()

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

export const getLogger = (): AppLogger => {
  if (!loggerRef) loggerRef = createLogger()
  return loggerRef
}

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

const normalizeConnectionIds = (values: Array<string | null | undefined>): string[] => {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

const loadConnectionIdsFromMysql = async (): Promise<string[]> => {
  const pool = getMysqlPool()
  if (!pool) return []
  const [rows] = await pool.execute<StartupConnectionRow[]>(
    `SELECT connection_id FROM auth_creds ORDER BY updated_at ASC, connection_id ASC`
  )
  return normalizeConnectionIds(rows.map((row) => row.connection_id))
}

export const resolveStartupConnectionIds = async (): Promise<string[]> => {
  if (config.connectionIds?.length) {
    return normalizeConnectionIds(config.connectionIds)
  }
  if (config.mysqlUrl) {
    const fromMysql = await loadConnectionIdsFromMysql()
    if (fromMysql.length) return fromMysql
  }
  return normalizeConnectionIds([config.connectionId ?? 'default'])
}

const toConnectionInfo = (runtime: ConnectionRuntime): ConnectionInfo => ({
  connectionId: runtime.connectionId,
  label: runtime.label,
  status: runtime.status,
  socketGeneration: runtime.socketGeneration,
  lastReconnectAt: runtime.lastReconnectAt,
  reconnectInFlight: runtime.reconnectPromise !== null,
  socketActive: runtime.activeSocket !== null,
  qrCode: runtime.qrCode,
  qrCodeAt: runtime.qrCodeAt,
})

export const getOrCreateRuntime = (connectionId: string): ConnectionRuntime => {
  const existing = runtimes.get(connectionId)
  if (existing) return existing
  const created: ConnectionRuntime = {
    connectionId,
    activeSocket: null,
    reconnectPromise: null,
    socketGeneration: 0,
    lastReconnectAt: 0,
    status: 'created',
    qrCode: null,
    qrCodeAt: null,
    label: null,
  }
  runtimes.set(connectionId, created)
  return created
}

/** Cria uma entrada de conexão no manager sem iniciar o socket. */
export const createConnection = (connectionId: string): ConnectionInfo => {
  const runtime = getOrCreateRuntime(connectionId)
  return toConnectionInfo(runtime)
}

/** Retorna informações públicas de todas as conexões registradas. */
export const listConnections = (): ConnectionInfo[] =>
  Array.from(runtimes.values()).map(toConnectionInfo)

/** Retorna informações públicas de uma conexão, ou null se não existir. */
export const getConnection = (connectionId: string): ConnectionInfo | null => {
  const runtime = runtimes.get(connectionId)
  return runtime ? toConnectionInfo(runtime) : null
}

/** Atualiza o rótulo de uma conexão. */
export const setConnectionLabel = (connectionId: string, label: string | null): void => {
  const runtime = runtimes.get(connectionId)
  if (runtime) runtime.label = label
}

/** Armazena o QR code recebido e atualiza o status para 'qr'. */
export const setQrCode = (connectionId: string, qr: string): void => {
  const runtime = runtimes.get(connectionId)
  if (!runtime) return
  runtime.qrCode = qr
  runtime.qrCodeAt = Date.now()
  runtime.status = 'qr'
}

/** Atualiza o status de uma conexão baseado em eventos de conexão do Baileys. */
export const setConnectionStatus = (connectionId: string, status: 'open' | 'close'): void => {
  const runtime = runtimes.get(connectionId)
  if (!runtime) return
  if (status === 'open') {
    runtime.status = 'open'
    runtime.qrCode = null
    runtime.qrCodeAt = null
  } else if (status === 'close') {
    if (runtime.status !== 'closed') {
      runtime.status = 'connecting'
    }
  }
}

/** Retorna o socket ativo de uma conexão, se disponível. */
export const getActiveSocket = (connectionId: string): WASocket | null => {
  return runtimes.get(connectionId)?.activeSocket ?? null
}

/** Substitui o socket ativo de uma conexão por uma nova geração. */
export const replaceSocket = async (connectionId: string, reason: string): Promise<void> => {
  const logger = getLogger()
  await ensureSchemaReady()
  const runtime = getOrCreateRuntime(connectionId)
  const generation = ++runtime.socketGeneration
  const previousSocket = runtime.activeSocket

  runtime.status = 'connecting'

  if (previousSocket) {
    unregisterShutdownTarget(connectionId, previousSocket)
    logger.warn('encerrando socket anterior para iniciar nova geração', {
      connectionId,
      generation,
      reason,
    })
    try {
      ;(previousSocket.ev as { removeAllListeners?: (...args: unknown[]) => unknown }).removeAllListeners?.()
    } catch (error) {
      logger.debug('falha ao remover listeners do socket anterior', { err: error, connectionId, generation })
    }
    try {
      await previousSocket.end(new Error(`socket replaced: ${reason}`))
    } catch (error) {
      logger.debug('falha ao encerrar socket anterior (seguindo com nova conexão)', { err: error, connectionId, generation })
    }
  }

  const sock = await createSocket(connectionId, logger)
  runtime.activeSocket = sock

  const reconnectFromThisSocket = async () => {
    if (generation !== runtime.socketGeneration) {
      logger.debug('ignorando pedido de reconexão de socket antigo', {
        connectionId,
        generation,
        currentGeneration: runtime.socketGeneration,
      })
      return
    }
    await scheduleReconnect(connectionId, `connection_close_generation_${generation}`)
  }

  registerEvents({
    sock,
    logger,
    reconnect: reconnectFromThisSocket,
    connectionId,
    onQrCode: (qr) => setQrCode(connectionId, qr),
    onConnectionOpen: () => setConnectionStatus(connectionId, 'open'),
    onConnectionClose: () => setConnectionStatus(connectionId, 'close'),
  })

  logger.info('socket iniciado com sucesso', { connectionId, generation, reason })
}

/** Agenda uma reconexão com janela mínima e exclusão mútua por connectionId. */
export const scheduleReconnect = async (connectionId: string, reason: string): Promise<void> => {
  const logger = getLogger()
  const runtime = getOrCreateRuntime(connectionId)
  if (isShutdownInProgress()) {
    logger.warn('reconexao ignorada: shutdown em andamento', { connectionId, reason })
    return
  }
  if (runtime.reconnectPromise) {
    logger.warn('reconexão já em andamento, ignorando solicitação paralela', { connectionId, reason })
    return runtime.reconnectPromise
  }

  runtime.reconnectPromise = (async () => {
    const elapsedSinceLastReconnect = Date.now() - runtime.lastReconnectAt
    const waitMs = Math.max(0, RECONNECT_MIN_DELAY_MS - elapsedSinceLastReconnect)
    if (waitMs > 0) {
      logger.info('aguardando janela mínima antes de reconectar', { connectionId, waitMs, reason })
      await wait(waitMs)
    }
    await replaceSocket(connectionId, reason)
    runtime.lastReconnectAt = Date.now()
  })().finally(() => {
    runtime.reconnectPromise = null
  })

  return runtime.reconnectPromise
}

/** Inicia a conexão de uma instância existente, disparando criação de socket e QR. */
export const connect = async (connectionId: string, logger: AppLogger): Promise<void> => {
  const runtime = runtimes.get(connectionId)
  if (!runtime) {
    logger.warn('connect chamado para connectionId inexistente', { connectionId })
    return
  }
  if (runtime.status === 'open' || runtime.status === 'connecting' || runtime.status === 'qr') {
    logger.info('connect ignorado: instância já está em estado ativo', { connectionId, status: runtime.status })
    return
  }
  await scheduleReconnect(connectionId, 'api_connect')
}

/** Desconecta uma instância, encerrando o socket sem agendar reconexão. */
export const disconnect = async (connectionId: string, logger: AppLogger): Promise<void> => {
  const runtime = runtimes.get(connectionId)
  if (!runtime) {
    logger.warn('disconnect chamado para connectionId inexistente', { connectionId })
    return
  }
  runtime.status = 'closed'
  runtime.qrCode = null
  runtime.qrCodeAt = null
  const sock = runtime.activeSocket
  if (!sock) return
  unregisterShutdownTarget(connectionId, sock)
  try {
    ;(sock.ev as { removeAllListeners?: (...args: unknown[]) => unknown }).removeAllListeners?.()
  } catch (_err) {
    // ignora falha ao remover listeners
  }
  try {
    await sock.end(new Error('api_disconnect'))
  } catch (error) {
    logger.debug('falha ao encerrar socket no disconnect', { err: error, connectionId })
  }
  runtime.activeSocket = null
}

/** Reinicia uma instância: desconecta e reconecta. */
export const restart = async (connectionId: string, logger: AppLogger): Promise<void> => {
  const runtime = runtimes.get(connectionId)
  if (!runtime) {
    logger.warn('restart chamado para connectionId inexistente', { connectionId })
    return
  }
  await disconnect(connectionId, logger)
  runtime.status = 'connecting'
  await scheduleReconnect(connectionId, 'api_restart')
}

/** Remove uma instância do manager, desconectando-a se ativa. */
export const deleteConnection = async (connectionId: string, logger: AppLogger): Promise<void> => {
  await disconnect(connectionId, logger)
  runtimes.delete(connectionId)
}

/** Retorna os snapshots operacionais para o servidor de métricas do antiban. */
export const getOperationalSnapshots = () =>
  Array.from(runtimes.values()).map((runtime) => ({
    connectionId: runtime.connectionId,
    socketActive: runtime.activeSocket !== null,
    reconnectInFlight: runtime.reconnectPromise !== null,
    socketGeneration: runtime.socketGeneration,
    lastReconnectAtMs: runtime.lastReconnectAt || 0,
  }))

/** Retorna as estatísticas antiban do primeiro socket ativo disponível. */
export const getAntiBanStats = (): unknown => {
  for (const runtime of runtimes.values()) {
    const stats = (runtime.activeSocket as { antiban?: { getStats?: () => unknown } } | null)?.antiban?.getStats?.()
    if (stats) return stats
  }
  return {}
}
