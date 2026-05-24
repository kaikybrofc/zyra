import type { RowDataPacket } from 'mysql2/promise'
import type { WASocket } from 'baileys'
import { createLogger, type AppLogger } from '../observability/logger.js'
import { createSocket, isShutdownInProgress, unregisterShutdownTarget } from '../core/connection/socket.js'
import { registerEvents } from '../events/register.js'
import { initMysqlSchema } from '../core/db/init.js'
import { getMysqlPool } from '../core/db/mysql.js'
import { config } from '../config/index.js'
import { startAntiBanMetricsServer } from '../observability/antiban-metrics.js'

type ConnectionRuntime = {
  connectionId: string
  activeSocket: WASocket | null
  reconnectPromise: Promise<void> | null
  socketGeneration: number
  lastReconnectAt: number
}

type StartupConnectionRow = RowDataPacket & { connection_id: string }

let loggerRef: AppLogger | null = null
const RECONNECT_MIN_DELAY_MS = Math.max(500, Number(process.env.WA_RECONNECT_MIN_DELAY_MS ?? 2500))
let schemaInitPromise: Promise<void> | null = null
let metricsServerHandle: { stop: () => Promise<void> } | null = null
const runtimes = new Map<string, ConnectionRuntime>()

const getLogger = (): AppLogger => {
  if (!loggerRef) {
    loggerRef = createLogger()
  }
  return loggerRef
}

/**
 * Aguarda a quantidade de milissegundos informada.
 *
 * @param ms Tempo de espera em milissegundos.
 * @returns Promise resolvida após o tempo definido.
 */
const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Obtém o estado em memória de uma conexão, criando-o quando necessário.
 *
 * @param connectionId Identificador lógico da conexão WhatsApp.
 * @returns Runtime da conexão, com socket ativo e estado de reconexão.
 */
const getOrCreateRuntime = (connectionId: string): ConnectionRuntime => {
  const existing = runtimes.get(connectionId)
  if (existing) return existing
  const created: ConnectionRuntime = {
    connectionId,
    activeSocket: null,
    reconnectPromise: null,
    socketGeneration: 0,
    lastReconnectAt: 0,
  }
  runtimes.set(connectionId, created)
  return created
}

/**
 * Garante que o schema do MySQL seja inicializado apenas uma vez por processo.
 *
 * Em caso de falha, permite nova tentativa em chamadas futuras.
 *
 * @returns Promise resolvida quando o schema estiver pronto.
 */
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

/**
 * Remove valores vazios, aplica trim e elimina duplicados mantendo a ordem.
 *
 * @param values Lista de identificadores de conexão em estado bruto.
 * @returns Lista normalizada e única de connection ids.
 */
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

/**
 * Carrega os connection ids persistidos no MySQL para bootstrap automático.
 *
 * @returns Lista de connection ids normalizada; vazia quando pool indisponível.
 */
const loadConnectionIdsFromMysql = async (): Promise<string[]> => {
  const pool = getMysqlPool()
  if (!pool) return []
  const [rows] = await pool.execute<StartupConnectionRow[]>(
    `SELECT connection_id
     FROM auth_creds
     ORDER BY updated_at ASC, connection_id ASC`
  )
  return normalizeConnectionIds(rows.map((row) => row.connection_id))
}

/**
 * Resolve quais conexões devem subir no boot.
 *
 * Ordem de prioridade:
 * 1) `config.connectionIds`
 * 2) IDs existentes em `auth_creds` (quando MySQL está configurado)
 * 3) `config.connectionId` ou fallback `'default'`
 *
 * @returns Lista final de connection ids sem duplicidade.
 */
const resolveStartupConnectionIds = async (): Promise<string[]> => {
  if (config.connectionIds?.length) {
    return normalizeConnectionIds(config.connectionIds)
  }
  if (config.mysqlUrl) {
    const fromMysql = await loadConnectionIdsFromMysql()
    if (fromMysql.length) return fromMysql
  }
  return normalizeConnectionIds([config.connectionId ?? 'default'])
}

/**
 * Substitui o socket ativo de uma conexão por uma nova geração.
 *
 * A geração anterior é encerrada com limpeza de listeners para evitar vazamento
 * de eventos e reconexões concorrentes.
 *
 * @param connectionId Identificador da conexão alvo.
 * @param reason Motivo textual da substituição (log/observabilidade).
 */
const replaceSocket = async (connectionId: string, reason: string) => {
  const logger = getLogger()
  await ensureSchemaReady()
  const runtime = getOrCreateRuntime(connectionId)
  const generation = ++runtime.socketGeneration
  const previousSocket = runtime.activeSocket

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

  registerEvents({ sock, logger, reconnect: reconnectFromThisSocket, connectionId })
  logger.info('Bot sendo iniciado com sucesso.', { connectionId, generation, reason })
}

/**
 * Agenda uma reconexão respeitando janela mínima e garantindo exclusão mútua
 * por `connectionId`.
 *
 * Se já existir reconexão em andamento, retorna a mesma Promise.
 *
 * @param connectionId Identificador da conexão alvo.
 * @param reason Motivo textual da reconexão (log/observabilidade).
 * @returns Promise da reconexão em andamento/concluída.
 */
const scheduleReconnect = async (connectionId: string, reason: string) => {
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

/**
 * Executa o bootstrap da aplicação.
 *
 * Responsabilidades:
 * 1) Inicia servidor de métricas anti-ban (quando habilitado)
 * 2) Resolve as conexões de inicialização
 * 3) Garante runtime de cada conexão
 * 4) Dispara conexão inicial via `scheduleReconnect('startup')`
 *
 * @throws Error Quando nenhuma conexão inicial puder ser resolvida.
 */
export async function start(): Promise<void> {
  if (!metricsServerHandle && config.antibanEnabled && config.antibanMetricsEnabled) {
    const logger = getLogger()
    metricsServerHandle = startAntiBanMetricsServer({
      logger,
      getStats: () => {
        for (const runtime of runtimes.values()) {
          const stats = (runtime.activeSocket as { antiban?: { getStats?: () => unknown } } | null)?.antiban?.getStats?.()
          if (stats) return stats
        }
        return {}
      },
      getOperationalSnapshots: () =>
        Array.from(runtimes.values()).map((runtime) => ({
          connectionId: runtime.connectionId,
          socketActive: Boolean(runtime.activeSocket),
          reconnectInFlight: Boolean(runtime.reconnectPromise),
          socketGeneration: runtime.socketGeneration,
          lastReconnectAtMs: runtime.lastReconnectAt || 0,
        })),
    })
  }

  const logger = getLogger()
  const connectionIds = await resolveStartupConnectionIds()
  if (!connectionIds.length) {
    throw new Error('nenhuma conexão inicial pôde ser resolvida para o boot')
  }
  logger.info('conexões resolvidas para inicialização', { connectionIds, total: connectionIds.length })
  for (const connectionId of connectionIds) {
    getOrCreateRuntime(connectionId)
    await scheduleReconnect(connectionId, 'startup')
  }
}
