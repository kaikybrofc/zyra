import { DisconnectReason } from 'baileys'
import { Boom } from '@hapi/boom'
import { createLogger, type AppLogger } from '../../observability/logger.js'
import { createSocket, flushSocketCredsNow, unregisterShutdownTarget, type SocketWithCredsFlush } from './socket.js'
import { connect, createConnection, disconnect, getConnection, getLogger as getManagerLogger } from './manager.js'
import { recordConnectionAdminEvent, upsertManagedConnection } from '../../store/connection-admin-store.js'
import { enqueueConnectionOutboxEvent } from '../webhooks/outbox-dispatcher.js'

type PairingStateStatus = 'idle' | 'pending' | 'qr_ready' | 'paired' | 'failed' | 'cancelled'

export type PairingStateView = {
  connectionId: string
  status: PairingStateStatus
  qrCode: string | null
  qrUpdatedAt: number | null
  qrExpiresAt: number | null
  startedAt: number | null
  finishedAt: number | null
  error: string | null
}

type PairingRuntime = {
  connectionId: string
  status: PairingStateStatus
  socket: SocketWithCredsFlush | null
  startedAt: number
  finishedAt: number | null
  qrCode: string | null
  qrUpdatedAt: number | null
  qrExpiresAt: number | null
  error: string | null
  sawNewLogin: boolean
  timeoutTimer: NodeJS.Timeout | null
}

const PAIRING_TIMEOUT_MS = Math.max(60_000, Number(process.env.WA_PAIR_TIMEOUT_MS ?? 10 * 60_000))
const QR_TTL_MS = Math.max(10_000, Number(process.env.WA_PAIRING_QR_TTL_MS ?? 60_000))
const EXPECTED_POST_LOGIN_CLOSE_CODES = new Set<number>([DisconnectReason.restartRequired, 408, 428, 440])

const formatErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

const extractDisconnectStatusCode = (update: { lastDisconnect?: { error?: unknown } }): number | null => {
  const error = update.lastDisconnect?.error as (Boom & { output?: { statusCode?: number } }) | (Error & { output?: { statusCode?: number } }) | undefined
  const explicitStatus = error?.output?.statusCode
  if (typeof explicitStatus === 'number') return explicitStatus
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/\b515\b/.test(message)) return DisconnectReason.restartRequired
  if (/\b401\b/.test(message)) return DisconnectReason.loggedOut
  return null
}

const shouldTreatCloseAsSuccess = (runtime: PairingRuntime, statusCode: number | null): boolean => {
  if (!runtime.sawNewLogin) return false
  return statusCode === null || EXPECTED_POST_LOGIN_CLOSE_CODES.has(statusCode)
}

const toView = (runtime: PairingRuntime): PairingStateView => ({
  connectionId: runtime.connectionId,
  status: runtime.status,
  qrCode: runtime.qrExpiresAt && runtime.qrExpiresAt > Date.now() ? runtime.qrCode : null,
  qrUpdatedAt: runtime.qrUpdatedAt,
  qrExpiresAt: runtime.qrExpiresAt,
  startedAt: runtime.startedAt,
  finishedAt: runtime.finishedAt,
  error: runtime.error,
})

class DefaultPairingService {
  private loggerRef: AppLogger | null = null

  private readonly runtimes = new Map<string, PairingRuntime>()

  private readonly operationLocks = new Map<string, Promise<void>>()

  private get logger(): AppLogger {
    if (!this.loggerRef) this.loggerRef = createLogger()
    return this.loggerRef
  }

  private getOrCreateRuntime(connectionId: string): PairingRuntime {
    const existing = this.runtimes.get(connectionId)
    if (existing) return existing
    const created: PairingRuntime = {
      connectionId,
      status: 'idle',
      socket: null,
      startedAt: 0,
      finishedAt: null,
      qrCode: null,
      qrUpdatedAt: null,
      qrExpiresAt: null,
      error: null,
      sawNewLogin: false,
      timeoutTimer: null,
    }
    this.runtimes.set(connectionId, created)
    return created
  }

  private async withPairingLock<T>(connectionId: string, operation: 'pairing_start' | 'pairing_cancel', task: () => Promise<T>): Promise<T> {
    const previous = this.operationLocks.get(connectionId) ?? Promise.resolve()
    let release: () => void = () => undefined
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const chain = previous.catch(() => undefined).then(() => current)
    this.operationLocks.set(connectionId, chain)

    await previous.catch(() => undefined)

    try {
      return await task()
    } finally {
      release()
      if (this.operationLocks.get(connectionId) === chain) {
        this.operationLocks.delete(connectionId)
      }
      this.logger.debug('pairing lock liberado', { connectionId, operation })
    }
  }

  async startPairing(connectionId: string): Promise<PairingStateView> {
    return this.withPairingLock(connectionId, 'pairing_start', () => this.startPairingUnsafe(connectionId))
  }

  private async startPairingUnsafe(connectionId: string): Promise<PairingStateView> {
    const runtime = this.getOrCreateRuntime(connectionId)
    if (runtime.socket && (runtime.status === 'pending' || runtime.status === 'qr_ready')) {
      return toView(runtime)
    }

    if (!getConnection(connectionId)) {
      createConnection(connectionId)
    }

    await disconnect(connectionId, getManagerLogger())

    runtime.status = 'pending'
    runtime.startedAt = Date.now()
    runtime.finishedAt = null
    runtime.qrCode = null
    runtime.qrUpdatedAt = null
    runtime.qrExpiresAt = null
    runtime.error = null
    runtime.sawNewLogin = false

    await upsertManagedConnection({
      connectionId,
      status: 'pairing',
      pairingState: 'pending',
      desiredState: 'running',
      webhookSource: 'pairing.service.start',
      lastError: null,
    })
    await recordConnectionAdminEvent({
      connectionId,
      eventType: 'pairing.started',
      source: 'pairing.service',
      newState: 'pending',
    })

    void enqueueConnectionOutboxEvent(connectionId, 'connection.status.changed', {
      previous: 'closed',
      current: 'pairing',
      desired: 'running',
      reason: 'pairing_start',
    })

    const sock = (await createSocket(connectionId, this.logger)) as SocketWithCredsFlush
    runtime.socket = sock

    const eventBus = sock.ev as {
      on: (event: 'connection.update', listener: (update: { connection?: string; qr?: string; isNewLogin?: boolean; lastDisconnect?: { error?: unknown } }) => void) => unknown
      off?: (event: 'connection.update', listener: (update: { connection?: string; qr?: string; isNewLogin?: boolean; lastDisconnect?: { error?: unknown } }) => unknown) => unknown
      removeListener?: (event: 'connection.update', listener: (update: { connection?: string; qr?: string; isNewLogin?: boolean; lastDisconnect?: { error?: unknown } }) => unknown) => unknown
    }

    const onUpdate = (update: { connection?: string; qr?: string; isNewLogin?: boolean; lastDisconnect?: { error?: unknown } }) => {
      if (!this.runtimes.has(connectionId)) return
      if (update.qr) {
        const now = Date.now()
        runtime.status = 'qr_ready'
        runtime.qrCode = update.qr
        runtime.qrUpdatedAt = now
        runtime.qrExpiresAt = now + QR_TTL_MS
        runtime.error = null
        void upsertManagedConnection({
          connectionId,
          status: 'pairing',
          pairingState: 'qr_ready',
          pairingCode: update.qr,
          webhookSource: 'pairing.service.qr',
          lastSeenAt: now,
        })
        void recordConnectionAdminEvent({
          connectionId,
          eventType: 'pairing.qr_ready',
          source: 'pairing.service',
          newState: 'qr_ready',
        })
        void enqueueConnectionOutboxEvent(connectionId, 'connection.qr.updated', {
          qrCode: update.qr,
          qrUpdatedAt: runtime.qrUpdatedAt,
          qrExpiresAt: runtime.qrExpiresAt,
        })
      }

      if (update.isNewLogin) {
        runtime.sawNewLogin = true
      }

      if (update.connection === 'open') {
        void this.finishSuccess(runtime, 'connection_open')
        return
      }

      if (update.connection === 'close') {
        const statusCode = extractDisconnectStatusCode(update)
        if (shouldTreatCloseAsSuccess(runtime, statusCode)) {
          void this.finishSuccess(runtime, 'connection_close_after_login')
        } else if (statusCode !== DisconnectReason.restartRequired || runtime.sawNewLogin) {
          void this.finishFailure(runtime, `conexao fechada durante pairing${statusCode ? ` (status ${statusCode})` : ''}`)
        }
      }
    }

    eventBus.on('connection.update', onUpdate)

    runtime.timeoutTimer = setTimeout(() => {
      void this.finishFailure(runtime, `timeout no pairing da conexão ${connectionId}`)
    }, PAIRING_TIMEOUT_MS)

    return toView(runtime)
  }

  async getPairingState(connectionId: string): Promise<PairingStateView> {
    const runtime = this.getOrCreateRuntime(connectionId)
    return toView(runtime)
  }

  async cancelPairing(connectionId: string): Promise<PairingStateView> {
    return this.withPairingLock(connectionId, 'pairing_cancel', () => this.cancelPairingUnsafe(connectionId))
  }

  private async cancelPairingUnsafe(connectionId: string): Promise<PairingStateView> {
    const runtime = this.getOrCreateRuntime(connectionId)
    if (!runtime.socket && (runtime.status === 'idle' || runtime.status === 'paired')) {
      return toView(runtime)
    }
    await this.finishCancelled(runtime)
    return toView(runtime)
  }

  private async finishSuccess(runtime: PairingRuntime, reason: string): Promise<void> {
    if (!runtime.socket) return
    const connectionId = runtime.connectionId
    const sock = runtime.socket
    runtime.socket = null
    if (runtime.timeoutTimer) {
      clearTimeout(runtime.timeoutTimer)
      runtime.timeoutTimer = null
    }
    runtime.status = 'paired'
    runtime.finishedAt = Date.now()
    runtime.error = null

    await flushSocketCredsNow(sock, `pairing_success_${reason}`).catch(() => undefined)
    await this.shutdownPairingSocket(connectionId, sock)

    await upsertManagedConnection({
      connectionId,
      status: 'connecting',
      pairingState: 'paired',
      pairingCode: null,
      lastError: null,
      lastSeenAt: Date.now(),
      webhookSource: 'pairing.service.success',
    })
    await recordConnectionAdminEvent({
      connectionId,
      eventType: 'pairing.completed',
      source: 'pairing.service',
      oldState: 'pairing',
      newState: 'paired',
    })
    void enqueueConnectionOutboxEvent(connectionId, 'connection.pairing.completed', {
      reason,
      pairedAt: runtime.finishedAt,
    })

    await connect(connectionId, getManagerLogger())
  }

  private async finishFailure(runtime: PairingRuntime, errorMessage: string): Promise<void> {
    if (!runtime.socket && runtime.status === 'failed') return
    const connectionId = runtime.connectionId
    const sock = runtime.socket
    runtime.socket = null
    if (runtime.timeoutTimer) {
      clearTimeout(runtime.timeoutTimer)
      runtime.timeoutTimer = null
    }
    runtime.status = 'failed'
    runtime.finishedAt = Date.now()
    runtime.error = errorMessage

    if (sock) {
      await this.shutdownPairingSocket(connectionId, sock)
    }

    await upsertManagedConnection({
      connectionId,
      status: 'inactive',
      pairingState: 'failed',
      pairingCode: null,
      lastError: errorMessage,
      webhookSource: 'pairing.service.failure',
    })
    await recordConnectionAdminEvent({
      connectionId,
      eventType: 'pairing.failed',
      source: 'pairing.service',
      oldState: 'pairing',
      newState: 'failed',
      payload: { error: errorMessage },
    })
    void enqueueConnectionOutboxEvent(connectionId, 'connection.pairing.failed', {
      error: errorMessage,
      failedAt: runtime.finishedAt,
    })
  }

  private async finishCancelled(runtime: PairingRuntime): Promise<void> {
    const connectionId = runtime.connectionId
    const sock = runtime.socket
    runtime.socket = null
    if (runtime.timeoutTimer) {
      clearTimeout(runtime.timeoutTimer)
      runtime.timeoutTimer = null
    }
    runtime.status = 'cancelled'
    runtime.finishedAt = Date.now()
    runtime.error = 'pairing cancelado'
    if (sock) {
      await this.shutdownPairingSocket(connectionId, sock)
    }
    await upsertManagedConnection({
      connectionId,
      status: 'inactive',
      pairingState: 'failed',
      pairingCode: null,
      lastError: runtime.error,
      webhookSource: 'pairing.service.cancel',
    })
    await recordConnectionAdminEvent({
      connectionId,
      eventType: 'pairing.cancelled',
      source: 'pairing.service',
      oldState: 'pairing',
      newState: 'cancelled',
    })
    void enqueueConnectionOutboxEvent(connectionId, 'connection.pairing.failed', {
      error: runtime.error,
      failedAt: runtime.finishedAt,
      cancelled: true,
    })
  }

  private async shutdownPairingSocket(connectionId: string, sock: SocketWithCredsFlush): Promise<void> {
    try {
      ;(sock.ev as { removeAllListeners?: (...args: unknown[]) => unknown }).removeAllListeners?.()
    } catch (error) {
      this.logger.debug('pairing: falha ao remover listeners no teardown', { connectionId, err: error })
    }

    try {
      await sock.end(undefined)
    } catch (error) {
      this.logger.debug('pairing: falha ao encerrar socket no teardown', { connectionId, err: error })
    }
    unregisterShutdownTarget(connectionId, sock)
  }
}

const service = new DefaultPairingService()

export const startPairing = async (connectionId: string): Promise<PairingStateView> => service.startPairing(connectionId)
export const getPairingState = async (connectionId: string): Promise<PairingStateView> => service.getPairingState(connectionId)
export const cancelPairing = async (connectionId: string): Promise<PairingStateView> => service.cancelPairing(connectionId)

export const _formatPairingErrorMessage = formatErrorMessage
