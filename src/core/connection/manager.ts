import type { RowDataPacket } from 'mysql2/promise'
import type { WASocket } from 'baileys'
import { createLogger, type AppLogger } from '../../observability/logger.js'
import { createSocket, isShutdownInProgress, unregisterShutdownTarget } from './socket.js'
import { registerEvents } from '../../events/register.js'
import { initMysqlSchema } from '../db/init.js'
import { getMysqlPool } from '../db/mysql.js'
import { config } from '../../config/index.js'
import {
  recordConnectionAdminEvent,
  upsertManagedConnection,
  type CreateConnectionAdminEventInput,
  type ManagedConnectionStatus,
  type UpsertManagedConnectionInput,
} from '../../store/connection-admin-store.js'
import { enqueueConnectionOutboxEvent } from '../webhooks/outbox-dispatcher.js'

/** Estado da conexão ao longo do seu ciclo de vida em memória. */
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

export interface ConnectionManager {
  bootstrap(): Promise<void>
  resolveStartupConnectionIds(): Promise<string[]>
  getOrCreateRuntime(connectionId: string): ConnectionRuntime
  createConnection(connectionId: string): ConnectionInfo
  listConnections(): ConnectionInfo[]
  getConnection(connectionId: string): ConnectionInfo | null
  setConnectionLabel(connectionId: string, label: string | null): void
  setQrCode(connectionId: string, qr: string): void
  setConnectionStatus(connectionId: string, status: 'open' | 'close'): void
  getActiveSocket(connectionId: string): WASocket | null
  replaceSocket(connectionId: string, reason: string): Promise<void>
  scheduleReconnect(connectionId: string, reason: string): Promise<void>
  connect(connectionId: string, logger: AppLogger): Promise<void>
  disconnect(connectionId: string, logger: AppLogger): Promise<void>
  restart(connectionId: string, logger: AppLogger): Promise<void>
  pause(connectionId: string, logger: AppLogger): Promise<void>
  resume(connectionId: string, logger: AppLogger): Promise<void>
  deleteConnection(connectionId: string, logger: AppLogger): Promise<void>
  getOperationalSnapshots(): Array<{
    connectionId: string
    socketActive: boolean
    reconnectInFlight: boolean
    socketGeneration: number
    lastReconnectAtMs: number
  }>
  getAntiBanStats(): unknown
}

type StartupConnectionRow = RowDataPacket & { connection_id: string }

const RECONNECT_MIN_DELAY_MS = Math.max(500, Number(process.env.WA_RECONNECT_MIN_DELAY_MS ?? 2500))

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

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

const runtimeStatusToManagedStatus: Record<ConnectionStatus, ManagedConnectionStatus> = {
  created: 'inactive',
  connecting: 'connecting',
  qr: 'pairing',
  open: 'open',
  closed: 'closed',
  error: 'error',
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

class DefaultConnectionManager implements ConnectionManager {
  private loggerRef: AppLogger | null = null

  private schemaInitPromise: Promise<void> | null = null

  private readonly runtimes = new Map<string, ConnectionRuntime>()

  private readonly managedSyncByConnection = new Map<string, Promise<void>>()

  getLogger(): AppLogger {
    if (!this.loggerRef) this.loggerRef = createLogger()
    return this.loggerRef
  }

  async bootstrap(): Promise<void> {
    const logger = this.getLogger()
    const connectionIds = await this.resolveStartupConnectionIds()
    if (!connectionIds.length) {
      throw new Error('nenhuma conexão inicial pôde ser resolvida para o boot')
    }
    logger.info('conexões resolvidas para inicialização', { connectionIds, total: connectionIds.length })

    for (const connectionId of connectionIds) {
      this.getOrCreateRuntime(connectionId)
      await this.scheduleReconnect(connectionId, 'startup')
    }
  }

  private async ensureSchemaReady() {
    if (!this.schemaInitPromise) {
      this.schemaInitPromise = initMysqlSchema(this.getLogger()).catch((error) => {
        this.schemaInitPromise = null
        throw error
      })
    }
    await this.schemaInitPromise
  }

  private async loadConnectionIdsFromMysql(): Promise<string[]> {
    const pool = getMysqlPool()
    if (!pool) return []
    const [rows] = await pool.execute<StartupConnectionRow[]>(
      `SELECT connection_id FROM auth_creds ORDER BY updated_at ASC, connection_id ASC`
    )
    return normalizeConnectionIds(rows.map((row) => row.connection_id))
  }

  async resolveStartupConnectionIds(): Promise<string[]> {
    if (config.connectionIds?.length) {
      return normalizeConnectionIds(config.connectionIds)
    }
    if (config.mysqlUrl) {
      const fromMysql = await this.loadConnectionIdsFromMysql()
      if (fromMysql.length) return fromMysql
    }
    return normalizeConnectionIds([config.connectionId ?? 'default'])
  }

  getOrCreateRuntime(connectionId: string): ConnectionRuntime {
    const existing = this.runtimes.get(connectionId)
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
    this.runtimes.set(connectionId, created)

    this.syncManagedConnection(connectionId, {
      status: runtimeStatusToManagedStatus[created.status],
      desiredState: 'running',
      enabled: true,
      pairingState: 'not_required',
      webhookSource: 'manager.runtime',
    })
    this.recordAdminEvent({
      connectionId,
      eventType: 'connection.registered',
      source: 'manager.runtime',
      newState: created.status,
      payload: { reason: 'runtime_created' },
    })

    return created
  }

  createConnection(connectionId: string): ConnectionInfo {
    const runtime = this.getOrCreateRuntime(connectionId)
    return toConnectionInfo(runtime)
  }

  listConnections(): ConnectionInfo[] {
    return Array.from(this.runtimes.values()).map(toConnectionInfo)
  }

  getConnection(connectionId: string): ConnectionInfo | null {
    const runtime = this.runtimes.get(connectionId)
    return runtime ? toConnectionInfo(runtime) : null
  }

  setConnectionLabel(connectionId: string, label: string | null): void {
    const runtime = this.runtimes.get(connectionId)
    if (!runtime) return
    runtime.label = label
    this.syncManagedConnection(connectionId, { displayName: label, webhookSource: 'manager.label' })
    this.recordAdminEvent({
      connectionId,
      eventType: 'connection.label.updated',
      source: 'manager.label',
      payload: { label },
    })
  }

  setQrCode(connectionId: string, qr: string): void {
    const runtime = this.runtimes.get(connectionId)
    if (!runtime) return
    runtime.qrCode = qr
    runtime.qrCodeAt = Date.now()
    const oldStatus = runtime.status
    runtime.status = 'qr'

    this.syncManagedConnection(connectionId, {
      status: runtimeStatusToManagedStatus[runtime.status],
      pairingState: 'qr_ready',
      lastSeenAt: Date.now(),
      webhookSource: 'manager.socket.qr',
    })
    this.recordAdminEvent({
      connectionId,
      eventType: 'pairing.qr_ready',
      source: 'manager.socket.qr',
      oldState: oldStatus,
      newState: runtime.status,
    })
    this.emitOutbox(connectionId, 'connection.qr.updated', {
      qrCode: qr,
      qrUpdatedAt: runtime.qrCodeAt,
      qrExpiresAt: runtime.qrCodeAt ? runtime.qrCodeAt + 60_000 : null,
    })
  }

  setConnectionStatus(connectionId: string, status: 'open' | 'close'): void {
    const runtime = this.runtimes.get(connectionId)
    if (!runtime) return

    const oldStatus = runtime.status
    if (status === 'open') {
      runtime.status = 'open'
      runtime.qrCode = null
      runtime.qrCodeAt = null
      this.syncManagedConnection(connectionId, {
        status: runtimeStatusToManagedStatus[runtime.status],
        pairingState: 'not_required',
        lastSeenAt: Date.now(),
        lastConnectedAt: Date.now(),
        lastError: null,
        webhookSource: 'manager.socket.open',
      })
    } else if (status === 'close') {
      if (runtime.status !== 'closed') {
        runtime.status = 'connecting'
      }
      this.syncManagedConnection(connectionId, {
        status: runtimeStatusToManagedStatus[runtime.status],
        lastSeenAt: Date.now(),
        lastDisconnectedAt: Date.now(),
        webhookSource: 'manager.socket.close',
      })
    }

    if (runtime.status !== oldStatus) {
      this.recordAdminEvent({
        connectionId,
        eventType: 'connection.status.changed',
        source: 'manager.socket',
        oldState: oldStatus,
        newState: runtime.status,
      })
      this.emitStatusChanged(connectionId, oldStatus, runtime.status, 'running', 'socket_update')
    }
  }

  getActiveSocket(connectionId: string): WASocket | null {
    return this.runtimes.get(connectionId)?.activeSocket ?? null
  }

  async replaceSocket(connectionId: string, reason: string): Promise<void> {
    const logger = this.getLogger()
    await this.ensureSchemaReady()
    const runtime = this.getOrCreateRuntime(connectionId)
    const generation = ++runtime.socketGeneration
    const previousSocket = runtime.activeSocket

    const previousStatus = runtime.status
    runtime.status = 'connecting'
    this.syncManagedConnection(connectionId, {
      status: runtimeStatusToManagedStatus[runtime.status],
      lastSeenAt: Date.now(),
      desiredState: 'running',
      webhookSource: 'manager.socket.replace',
    })
    if (previousStatus !== runtime.status) {
      this.emitStatusChanged(connectionId, previousStatus, runtime.status, 'running', reason)
    }

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
      await this.scheduleReconnect(connectionId, `connection_close_generation_${generation}`)
    }

    registerEvents({
      sock,
      logger,
      reconnect: reconnectFromThisSocket,
      connectionId,
      onQrCode: (qr) => this.setQrCode(connectionId, qr),
      onConnectionOpen: () => this.setConnectionStatus(connectionId, 'open'),
      onConnectionClose: () => this.setConnectionStatus(connectionId, 'close'),
    })

    logger.info('socket iniciado com sucesso', { connectionId, generation, reason })
  }

  async scheduleReconnect(connectionId: string, reason: string): Promise<void> {
    const logger = this.getLogger()
    const runtime = this.getOrCreateRuntime(connectionId)
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
      await this.replaceSocket(connectionId, reason)
      runtime.lastReconnectAt = Date.now()
    })().finally(() => {
      runtime.reconnectPromise = null
    })

    return runtime.reconnectPromise
  }

  async connect(connectionId: string, logger: AppLogger): Promise<void> {
    const runtime = this.runtimes.get(connectionId)
    if (!runtime) {
      logger.warn('connect chamado para connectionId inexistente', { connectionId })
      return
    }
    if (runtime.status === 'open' || runtime.status === 'connecting' || runtime.status === 'qr') {
      logger.info('connect ignorado: instância já está em estado ativo', { connectionId, status: runtime.status })
      return
    }
    this.syncManagedConnection(connectionId, {
      desiredState: 'running',
      status: 'connecting',
      webhookSource: 'manager.connect',
    })
    this.recordAdminEvent({
      connectionId,
      eventType: 'connection.start.requested',
      source: 'manager.connect',
      oldState: runtime.status,
      newState: 'connecting',
    })
    await this.scheduleReconnect(connectionId, 'api_connect')
  }

  async disconnect(connectionId: string, logger: AppLogger): Promise<void> {
    const runtime = this.runtimes.get(connectionId)
    if (!runtime) {
      logger.warn('disconnect chamado para connectionId inexistente', { connectionId })
      return
    }

    const oldStatus = runtime.status
    runtime.status = 'closed'
    runtime.qrCode = null
    runtime.qrCodeAt = null

    this.syncManagedConnection(connectionId, {
      status: 'closed',
      desiredState: 'stopped',
      lastSeenAt: Date.now(),
      lastDisconnectedAt: Date.now(),
      pairingState: 'not_required',
      webhookSource: 'manager.disconnect',
    })
    this.recordAdminEvent({
      connectionId,
      eventType: 'connection.stopped',
      source: 'manager.disconnect',
      oldState: oldStatus,
      newState: runtime.status,
    })
    this.emitStatusChanged(connectionId, oldStatus, runtime.status, 'stopped', 'disconnect')

    const sock = runtime.activeSocket
    if (!sock) return

    unregisterShutdownTarget(connectionId, sock)
    try {
      ;(sock.ev as { removeAllListeners?: (...args: unknown[]) => unknown }).removeAllListeners?.()
    } catch (_error) {
      // ignora falha ao remover listeners
    }
    try {
      await sock.end(new Error('api_disconnect'))
    } catch (error) {
      logger.debug('falha ao encerrar socket no disconnect', { err: error, connectionId })
    }
    runtime.activeSocket = null
  }

  async restart(connectionId: string, logger: AppLogger): Promise<void> {
    const runtime = this.runtimes.get(connectionId)
    if (!runtime) {
      logger.warn('restart chamado para connectionId inexistente', { connectionId })
      return
    }

    this.recordAdminEvent({
      connectionId,
      eventType: 'connection.reconnect.requested',
      source: 'manager.restart',
      oldState: runtime.status,
      newState: 'connecting',
    })
    await this.disconnect(connectionId, logger)
    runtime.status = 'connecting'
    this.syncManagedConnection(connectionId, {
      status: 'connecting',
      desiredState: 'running',
      webhookSource: 'manager.restart',
    })
    this.emitStatusChanged(connectionId, 'closed', 'connecting', 'running', 'restart')
    await this.scheduleReconnect(connectionId, 'api_restart')
  }

  async pause(connectionId: string, logger: AppLogger): Promise<void> {
    const runtime = this.runtimes.get(connectionId)
    if (!runtime) {
      logger.warn('pause chamado para connectionId inexistente', { connectionId })
      return
    }

    const oldStatus = runtime.status
    await this.disconnect(connectionId, logger)
    this.syncManagedConnection(connectionId, {
      status: 'paused',
      desiredState: 'paused',
      enabled: true,
      webhookSource: 'manager.pause',
    })
    this.recordAdminEvent({
      connectionId,
      eventType: 'connection.paused',
      source: 'manager.pause',
      oldState: oldStatus,
      newState: 'paused',
    })
    this.emitStatusChanged(connectionId, oldStatus, 'paused', 'paused', 'pause')
  }

  async resume(connectionId: string, logger: AppLogger): Promise<void> {
    const runtime = this.runtimes.get(connectionId)
    if (!runtime) {
      logger.warn('resume chamado para connectionId inexistente', { connectionId })
      return
    }

    this.syncManagedConnection(connectionId, {
      status: runtimeStatusToManagedStatus[runtime.status],
      desiredState: 'running',
      enabled: true,
      webhookSource: 'manager.resume',
    })
    this.recordAdminEvent({
      connectionId,
      eventType: 'connection.resumed',
      source: 'manager.resume',
      oldState: runtime.status,
      newState: 'connecting',
    })
    this.emitStatusChanged(connectionId, runtime.status, 'connecting', 'running', 'resume')
    await this.connect(connectionId, logger)
  }

  async deleteConnection(connectionId: string, logger: AppLogger): Promise<void> {
    await this.disconnect(connectionId, logger)
    this.runtimes.delete(connectionId)

    this.syncManagedConnection(connectionId, {
      status: 'deleted',
      desiredState: 'deleted',
      enabled: false,
      pairingState: 'not_required',
      webhookSource: 'manager.delete',
    })
    this.recordAdminEvent({
      connectionId,
      eventType: 'connection.deleted',
      source: 'manager.delete',
      newState: 'deleted',
    })
    this.emitStatusChanged(connectionId, 'closed', 'deleted', 'deleted', 'delete')
  }

  getOperationalSnapshots() {
    return Array.from(this.runtimes.values()).map((runtime) => ({
      connectionId: runtime.connectionId,
      socketActive: runtime.activeSocket !== null,
      reconnectInFlight: runtime.reconnectPromise !== null,
      socketGeneration: runtime.socketGeneration,
      lastReconnectAtMs: runtime.lastReconnectAt || 0,
    }))
  }

  getAntiBanStats(): unknown {
    for (const runtime of this.runtimes.values()) {
      const stats = (runtime.activeSocket as { antiban?: { getStats?: () => unknown } } | null)?.antiban?.getStats?.()
      if (stats) return stats
    }
    return {}
  }

  private syncManagedConnection(
    connectionId: string,
    patch: Omit<UpsertManagedConnectionInput, 'connectionId'>
  ): void {
    const previous = this.managedSyncByConnection.get(connectionId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.ensureSchemaReady()
        await upsertManagedConnection({ connectionId, ...patch })
      })
      .catch((error) => {
        this.getLogger().debug('falha ao sincronizar managed_connections', {
          err: error,
          connectionId,
          patch,
        })
      })
      .finally(() => {
        if (this.managedSyncByConnection.get(connectionId) === next) {
          this.managedSyncByConnection.delete(connectionId)
        }
      })

    this.managedSyncByConnection.set(connectionId, next)
  }

  private recordAdminEvent(event: CreateConnectionAdminEventInput): void {
    void (async () => {
      await this.ensureSchemaReady()
      await recordConnectionAdminEvent(event)
    })().catch((error) => {
      this.getLogger().debug('falha ao registrar connection_admin_event', {
        err: error,
        connectionId: event.connectionId,
        eventType: event.eventType,
      })
    })
  }

  private emitStatusChanged(
    connectionId: string,
    previous: string | null,
    current: string,
    desired: 'running' | 'stopped' | 'paused' | 'deleted',
    reason: string
  ): void {
    this.emitOutbox(connectionId, 'connection.status.changed', {
      previous,
      current,
      desired,
      reason,
    })
  }

  private emitOutbox(connectionId: string, eventType: string, data: unknown): void {
    void enqueueConnectionOutboxEvent(connectionId, eventType, data).catch((error) => {
      this.getLogger().debug('falha ao enfileirar evento no outbox', {
        err: error,
        connectionId,
        eventType,
      })
    })
  }
}

const managerInstance = new DefaultConnectionManager()

export const connectionManager: ConnectionManager = managerInstance

export const bootstrapConnections = () => connectionManager.bootstrap()

export const getLogger = (): AppLogger => managerInstance.getLogger()

export const resolveStartupConnectionIds = (): Promise<string[]> => connectionManager.resolveStartupConnectionIds()

export const getOrCreateRuntime = (connectionId: string): ConnectionRuntime =>
  connectionManager.getOrCreateRuntime(connectionId)

/** Cria uma entrada de conexão no manager sem iniciar o socket. */
export const createConnection = (connectionId: string): ConnectionInfo =>
  connectionManager.createConnection(connectionId)

/** Retorna informações públicas de todas as conexões registradas. */
export const listConnections = (): ConnectionInfo[] => connectionManager.listConnections()

/** Retorna informações públicas de uma conexão, ou null se não existir. */
export const getConnection = (connectionId: string): ConnectionInfo | null =>
  connectionManager.getConnection(connectionId)

/** Atualiza o rótulo de uma conexão. */
export const setConnectionLabel = (connectionId: string, label: string | null): void =>
  connectionManager.setConnectionLabel(connectionId, label)

/** Armazena o QR code recebido e atualiza o status para 'qr'. */
export const setQrCode = (connectionId: string, qr: string): void => connectionManager.setQrCode(connectionId, qr)

/** Atualiza o status de uma conexão baseado em eventos de conexão do Baileys. */
export const setConnectionStatus = (connectionId: string, status: 'open' | 'close'): void =>
  connectionManager.setConnectionStatus(connectionId, status)

/** Retorna o socket ativo de uma conexão, se disponível. */
export const getActiveSocket = (connectionId: string): WASocket | null =>
  connectionManager.getActiveSocket(connectionId)

/** Substitui o socket ativo de uma conexão por uma nova geração. */
export const replaceSocket = (connectionId: string, reason: string): Promise<void> =>
  connectionManager.replaceSocket(connectionId, reason)

/** Agenda uma reconexão com janela mínima e exclusão mútua por connectionId. */
export const scheduleReconnect = (connectionId: string, reason: string): Promise<void> =>
  connectionManager.scheduleReconnect(connectionId, reason)

/** Inicia a conexão de uma instância existente, disparando criação de socket e QR. */
export const connect = (connectionId: string, logger: AppLogger): Promise<void> =>
  connectionManager.connect(connectionId, logger)

/** Desconecta uma instância, encerrando o socket sem agendar reconexão. */
export const disconnect = (connectionId: string, logger: AppLogger): Promise<void> =>
  connectionManager.disconnect(connectionId, logger)

/** Reinicia uma instância: desconecta e reconecta. */
export const restart = (connectionId: string, logger: AppLogger): Promise<void> =>
  connectionManager.restart(connectionId, logger)

/** Pausa uma instância: encerra socket e marca estado administrativo como paused. */
export const pause = (connectionId: string, logger: AppLogger): Promise<void> =>
  connectionManager.pause(connectionId, logger)

/** Retoma uma instância pausada: define desired_state running e reconecta. */
export const resume = (connectionId: string, logger: AppLogger): Promise<void> =>
  connectionManager.resume(connectionId, logger)

/** Remove uma instância do manager, desconectando-a se ativa. */
export const deleteConnection = (connectionId: string, logger: AppLogger): Promise<void> =>
  connectionManager.deleteConnection(connectionId, logger)

/** Retorna os snapshots operacionais para o servidor de métricas do antiban. */
export const getOperationalSnapshots = () => connectionManager.getOperationalSnapshots()

/** Retorna as estatísticas antiban do primeiro socket ativo disponível. */
export const getAntiBanStats = (): unknown => connectionManager.getAntiBanStats()
