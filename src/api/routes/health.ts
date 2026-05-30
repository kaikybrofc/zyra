import process from 'node:process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { config } from '../../config/index.js'
import type { AppLogger } from '../../observability/logger.js'
import { listConnections, type ConnectionInfo } from '../../core/connection/manager.js'
import { getMysqlPool } from '../../core/db/mysql.js'
import { getRedisClient } from '../../core/redis/client.js'
import { listManagedConnections, type ManagedConnectionDesiredState, type ManagedConnectionPairingState, type ManagedConnectionRecord, type ManagedConnectionStatus } from '../../store/connection-admin-store.js'
import { matchRoute, sendJson } from '../http.js'

const CHECK_TIMEOUT_MS = Math.max(250, Number(process.env.WA_HEALTH_CHECK_TIMEOUT_MS ?? 3_000))

type ConnectionHealthSnapshot = {
  connection_id: string
  status: ManagedConnectionStatus
  desired_state: ManagedConnectionDesiredState
  pairing_state: ManagedConnectionPairingState
  enabled: boolean
  socket_active: boolean
  reconnect_in_flight: boolean
}

const withTimeout = async <T>(label: string, promise: Promise<T>, timeoutMs = CHECK_TIMEOUT_MS): Promise<T> => {
  let timeoutId: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`timeout (${timeoutMs}ms) em ${label}`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

const mapRuntimeStatusToManaged = (status: ConnectionInfo['status'], desiredState: ManagedConnectionDesiredState): ManagedConnectionStatus => {
  if (status === 'created') {
    if (desiredState === 'deleted') return 'deleted'
    if (desiredState === 'paused') return 'paused'
    return 'inactive'
  }
  if (status === 'connecting') return 'connecting'
  if (status === 'qr') return 'pairing'
  if (status === 'open') return 'open'
  if (status === 'error') return 'error'
  if (desiredState === 'deleted') return 'deleted'
  if (desiredState === 'paused') return 'paused'
  return 'closed'
}

const toSnapshot = (runtime: ConnectionInfo | null, managed: ManagedConnectionRecord | null): ConnectionHealthSnapshot | null => {
  const connectionId = runtime?.connectionId ?? managed?.connectionId
  if (!connectionId) return null
  const desiredState = managed?.desiredState ?? 'running'
  const status = runtime ? mapRuntimeStatusToManaged(runtime.status, desiredState) : (managed?.status ?? 'closed')
  const pairingState = runtime?.status === 'qr' ? 'qr_ready' : (managed?.pairingState ?? 'not_required')

  return {
    connection_id: connectionId,
    status,
    desired_state: desiredState,
    pairing_state: pairingState,
    enabled: managed?.enabled ?? true,
    socket_active: runtime?.socketActive ?? managed?.status === 'open',
    reconnect_in_flight: runtime?.reconnectInFlight ?? false,
  }
}

const buildConnectionsHealth = async (logger: AppLogger) => {
  const runtimeMap = new Map<string, ConnectionInfo>()
  for (const runtime of listConnections()) runtimeMap.set(runtime.connectionId, runtime)

  const managedMap = new Map<string, ManagedConnectionRecord>()
  try {
    const managed = await listManagedConnections()
    for (const row of managed) managedMap.set(row.connectionId, row)
  } catch (error) {
    logger.warn('health/connections: falha ao carregar managed_connections', { err: error })
  }

  const ids = new Set<string>([...runtimeMap.keys(), ...managedMap.keys()])
  const snapshots: ConnectionHealthSnapshot[] = []
  for (const id of ids) {
    const snapshot = toSnapshot(runtimeMap.get(id) ?? null, managedMap.get(id) ?? null)
    if (snapshot) snapshots.push(snapshot)
  }
  snapshots.sort((a, b) => a.connection_id.localeCompare(b.connection_id))

  const summary = {
    total: snapshots.length,
    open: snapshots.filter((item) => item.status === 'open').length,
    connecting: snapshots.filter((item) => item.status === 'connecting' || item.status === 'starting').length,
    paused: snapshots.filter((item) => item.status === 'paused').length,
    error: snapshots.filter((item) => item.status === 'error').length,
  }

  return { summary, snapshots }
}

const checkMysqlReady = async () => {
  if (!config.mysqlUrl) return { configured: false, ready: true, reason: null as string | null }
  const pool = getMysqlPool()
  if (!pool) return { configured: true, ready: false, reason: 'pool mysql indisponível' }
  try {
    await withTimeout('mysql_ready', pool.query('SELECT 1 AS ok'))
    return { configured: true, ready: true, reason: null as string | null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { configured: true, ready: false, reason: message }
  }
}

const checkRedisReady = async () => {
  if (!config.redisUrl) return { configured: false, ready: true, reason: null as string | null }
  try {
    const client = await withTimeout('redis_connect', getRedisClient())
    await withTimeout('redis_ping', client.ping())
    return { configured: true, ready: true, reason: null as string | null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { configured: true, ready: false, reason: message }
  }
}

/**
 * Endpoints de liveness/readiness e resumo de estado por conexão.
 */
export async function handleHealthRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, logger: AppLogger): Promise<boolean> {
  const method = req.method ?? 'GET'
  const isHealthRoute = Boolean(matchRoute('/health/live', pathname) || matchRoute('/health/ready', pathname) || matchRoute('/health/connections', pathname))
  if (!isHealthRoute) return false
  if (!config.healthEnabled) return false
  if (method !== 'GET') return false

  if (matchRoute('/health/live', pathname)) {
    sendJson(res, 200, {
      ok: true,
      live: true,
      now: Date.now(),
      uptime_sec: Math.floor(process.uptime()),
    })
    return true
  }

  if (matchRoute('/health/ready', pathname)) {
    const [mysql, redis] = await Promise.all([checkMysqlReady(), checkRedisReady()])
    const ready = mysql.ready && redis.ready
    sendJson(res, ready ? 200 : 503, {
      ok: ready,
      ready,
      checks: {
        mysql,
        redis,
        control_plane: {
          manages_connections: config.bootstrapConnectionsEnabled,
          api_enabled: config.apiEnabled,
          webhook_ingress_enabled: Boolean(config.webhookSharedSecret?.trim()),
        },
      },
    })
    return true
  }

  if (matchRoute('/health/connections', pathname)) {
    const data = await buildConnectionsHealth(logger)
    sendJson(res, 200, {
      ok: true,
      ...data.summary,
      connections: data.snapshots,
    })
    return true
  }

  return false
}
