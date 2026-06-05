import { createHmac, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { config } from '../../config/index.js'
import type { AppLogger } from '../../observability/logger.js'
import { type ConnectionInfo, createConnection, listConnections, getConnection, setConnectionLabel, connect, disconnect, restart, deleteConnection, pause, resume, hardDeleteConnection } from '../../core/connection/manager.js'
import { startPairing, getPairingState, cancelPairing } from '../../core/connection/pairing-service.js'
import { getManagedConnection, listManagedConnections, upsertManagedConnection, listConnectionAdminEvents, listWebhookCommands, getWebhookCommand, type ManagedConnectionRecord, type ManagedConnectionPairingState, type ManagedConnectionStatus } from '../../store/connection-admin-store.js'
import { validateConnectionId } from '../../core/connection/connection-id.js'
import { readBody, parseJson, sendJson, sendError, matchRoute, parseUrl } from '../http.js'

const MANAGER_DISABLED_ERROR = 'operação indisponível neste processo (WA_BOOTSTRAP_CONNECTIONS_ENABLED=false)'
const DEFAULT_AUDIT_LIMIT = 100
const MAX_AUDIT_LIMIT = 500

type WebhookCommandResponse = {
  ok?: boolean
  command_id?: string
  connection_id?: string
  accepted?: boolean
  action?: string
  current_state?: string | null
  desired_state?: 'running' | 'stopped' | 'paused' | 'deleted'
  reason?: string
}

type ConnectionAdminStatusView = {
  connection_id: string
  display_name: string | null
  enabled: boolean
  desired_state: 'running' | 'stopped' | 'paused' | 'deleted'
  status: ManagedConnectionStatus
  pairing_state: ManagedConnectionPairingState
  socket_generation: number
  reconnect_in_flight: boolean
  socket_active: boolean
  last_connected_at: string | null
  last_disconnected_at: string | null
  last_disconnect_code: number | null
  last_error: string | null
}

type ConnectionWithAdmin = ConnectionInfo & {
  admin: ConnectionAdminStatusView
}

type HardDeleteGuardResult = { ok: true } | { ok: false; httpStatus: number; reason: string }

const signWebhookCommand = (secret: string, timestamp: string, body: string): string => {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `sha256=${digest}`
}

const resolveLocalWebhookIngressUrl = (): string => {
  const rawHost = config.apiHost.trim()
  const host = rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost
  return `http://${host}:${config.apiPort}/webhooks/connections`
}

const dispatchStartCommandViaWebhook = async (connectionId: string, label: string | null): Promise<{ status: number; payload: WebhookCommandResponse | { error: string } }> => {
  const sharedSecret = config.webhookSharedSecret?.trim() ?? ''
  if (!sharedSecret) {
    return {
      status: 503,
      payload: { error: 'webhook de conexões indisponível: WA_WEBHOOK_SHARED_SECRET não configurado' },
    }
  }

  const command: {
    event: 'connection.command'
    version: string
    command_id: string
    sent_at: string
    connection: {
      id: string
      display_name?: string | null
    }
    action: {
      type: 'start'
      reason: string
    }
    metadata: {
      source: string
      issued_at: number
    }
  } = {
    event: 'connection.command',
    version: '2026-05-27',
    command_id: randomUUID(),
    sent_at: new Date().toISOString(),
    connection: {
      id: connectionId,
      ...(label !== null ? { display_name: label } : {}),
    },
    action: {
      type: 'start',
      reason: 'dashboard.qr',
    },
    metadata: {
      source: 'dashboard.connection.create',
      issued_at: Date.now(),
    },
  }

  const body = JSON.stringify(command)
  const timestamp = String(Date.now())
  const signature = signWebhookCommand(sharedSecret, timestamp, body)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.webhookTimeoutMs)

  try {
    const response = await fetch(resolveLocalWebhookIngressUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zyra-timestamp': timestamp,
        'x-zyra-signature': signature,
        'x-zyra-delivery-id': randomUUID(),
      },
      body,
      signal: controller.signal,
    })

    const rawResponse = await response.text()
    let payload: WebhookCommandResponse | { error: string }
    try {
      payload = rawResponse ? JSON.parse(rawResponse) : {}
    } catch {
      payload = { error: rawResponse || `erro HTTP ${response.status}` }
    }
    return {
      status: response.status,
      payload,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: 502,
      payload: { error: `falha ao acionar webhook de conexão: ${message}` },
    }
  } finally {
    clearTimeout(timer)
  }
}

const mapManagedStatusToRuntime = (record: ManagedConnectionRecord): ConnectionInfo['status'] => {
  if (record.pairingState === 'pending' || record.pairingState === 'qr_ready') return 'qr'
  if (record.status === 'open') return 'open'
  if (record.status === 'connecting' || record.status === 'starting' || record.status === 'closing') return 'connecting'
  if (record.status === 'error') return 'error'
  return 'closed'
}

const toIso = (value: number | null | undefined): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return new Date(value).toISOString()
}

const mapRuntimeStatusToManaged = (status: ConnectionInfo['status'], desiredState: ConnectionAdminStatusView['desired_state']): ManagedConnectionStatus => {
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

const buildAdminStatus = (runtime: ConnectionInfo | null, managed: ManagedConnectionRecord | null): ConnectionAdminStatusView => {
  const connectionId = runtime?.connectionId ?? managed?.connectionId ?? ''
  const desiredState = managed?.desiredState ?? 'running'
  const runtimeStatus = runtime?.status ?? null
  const resolvedStatus = runtimeStatus ? mapRuntimeStatusToManaged(runtimeStatus, desiredState) : (managed?.status ?? 'closed')
  const pairingState = runtimeStatus === 'qr' ? 'qr_ready' : (managed?.pairingState ?? 'not_required')
  const socketActive = runtime?.socketActive ?? managed?.status === 'open'

  return {
    connection_id: connectionId,
    display_name: runtime?.label ?? managed?.displayName ?? null,
    enabled: managed?.enabled ?? true,
    desired_state: desiredState,
    status: resolvedStatus,
    pairing_state: pairingState,
    socket_generation: runtime?.socketGeneration ?? 0,
    reconnect_in_flight: runtime?.reconnectInFlight ?? false,
    socket_active: socketActive,
    last_connected_at: toIso(managed?.lastConnectedAt ?? runtime?.lastReconnectAt ?? null),
    last_disconnected_at: toIso(managed?.lastDisconnectedAt ?? null),
    last_disconnect_code: managed?.lastDisconnectCode ?? null,
    last_error: managed?.lastError ?? null,
  }
}

const buildConnectionWithAdmin = (runtime: ConnectionInfo | null, managed: ManagedConnectionRecord | null): ConnectionWithAdmin | null => {
  const base = runtime ?? (managed ? managedRecordToConnectionInfo(managed) : null)
  if (!base) return null
  return {
    ...base,
    admin: buildAdminStatus(runtime, managed),
  }
}

const managedRecordToConnectionInfo = (record: ManagedConnectionRecord): ConnectionInfo => ({
  connectionId: record.connectionId,
  label: record.displayName,
  status: mapManagedStatusToRuntime(record),
  socketGeneration: 0,
  lastReconnectAt: record.lastConnectedAt ?? 0,
  reconnectInFlight: record.status === 'connecting' || record.status === 'starting',
  socketActive: record.status === 'open',
  qrCode: null,
  qrCodeAt: null,
})

const listConnectionsWithManagedFallback = async (logger: AppLogger): Promise<ConnectionWithAdmin[]> => {
  const runtimeMap = new Map<string, ConnectionInfo>()
  for (const info of listConnections()) runtimeMap.set(info.connectionId, info)

  const managedMap = new Map<string, ManagedConnectionRecord>()
  try {
    const managed = await listManagedConnections()
    for (const record of managed) managedMap.set(record.connectionId, record)
  } catch (error) {
    logger.warn('falha ao listar conexões managed para fallback da API', { err: error })
  }

  const connectionIds = new Set<string>([...runtimeMap.keys(), ...managedMap.keys()])
  const merged: ConnectionWithAdmin[] = []
  for (const connectionId of connectionIds) {
    const entry = buildConnectionWithAdmin(runtimeMap.get(connectionId) ?? null, managedMap.get(connectionId) ?? null)
    if (entry) merged.push(entry)
  }

  return merged.sort((a, b) => a.connectionId.localeCompare(b.connectionId))
}

const getConnectionWithManagedFallback = async (connectionId: string, logger: AppLogger): Promise<ConnectionWithAdmin | null> => {
  const runtime = getConnection(connectionId)
  if (runtime) {
    let managed: ManagedConnectionRecord | null = null
    try {
      managed = await getManagedConnection(connectionId)
    } catch (error) {
      logger.warn('falha ao consultar conexão managed para enriquecer resposta da API', {
        err: error,
        connectionId,
      })
    }
    return buildConnectionWithAdmin(runtime, managed)
  }
  try {
    const managed = await getManagedConnection(connectionId)
    if (!managed) return null
    return buildConnectionWithAdmin(null, managed)
  } catch (error) {
    logger.warn('falha ao consultar conexão managed para fallback da API', {
      err: error,
      connectionId,
    })
    return null
  }
}

const managerCanExecuteRuntimeActions = () => config.bootstrapConnectionsEnabled

const parseConnectionIdOrReply = (res: ServerResponse, rawConnectionId: string | null | undefined): string | null => {
  const parsed = validateConnectionId(rawConnectionId)
  if (!parsed.ok) {
    sendError(res, 400, parsed.reason)
    return null
  }
  return parsed.value
}

const parsePositiveLimit = (req: IncomingMessage, fallback = DEFAULT_AUDIT_LIMIT): number => {
  const raw = parseUrl(req).searchParams.get('limit')
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(MAX_AUDIT_LIMIT, Math.max(1, Math.trunc(parsed)))
}

const validateHardDeleteGuard = (req: IncomingMessage): HardDeleteGuardResult => {
  const url = parseUrl(req)
  const forceFlag = ['1', 'true', 'yes'].includes((url.searchParams.get('force') ?? '').trim().toLowerCase())
  const hardDeleteConfirmHeader = String(req.headers['x-zyra-hard-delete-confirm'] ?? '').trim().toLowerCase()
  const hardDeleteTokenHeader = String(req.headers['x-zyra-hard-delete-token'] ?? '').trim()

  if (!forceFlag) {
    return { ok: false, httpStatus: 422, reason: 'hard delete requer ?force=true' }
  }

  const configuredToken = config.webhookHardDeleteToken?.trim() ?? ''
  if (configuredToken) {
    if (hardDeleteTokenHeader !== configuredToken) {
      return { ok: false, httpStatus: 403, reason: 'token adicional de hard delete inválido' }
    }
    return { ok: true }
  }

  if (hardDeleteConfirmHeader !== 'true') {
    return { ok: false, httpStatus: 422, reason: 'hard delete requer header x-zyra-hard-delete-confirm=true' }
  }
  return { ok: true }
}

const buildDiagnosticsPayload = (info: ConnectionWithAdmin) => ({
  connectionId: info.connectionId,
  label: info.label,
  status: info.status,
  runtime: {
    socketGeneration: info.socketGeneration,
    socketActive: info.socketActive,
    reconnectInFlight: info.reconnectInFlight,
    qrCodeAvailable: Boolean(info.qrCode),
    qrCodeAt: info.qrCodeAt,
    lastReconnectAt: toIso(info.lastReconnectAt),
  },
  admin: info.admin,
  capabilities: {
    managerCanExecuteRuntimeActions: managerCanExecuteRuntimeActions(),
    webhookIngressConfigured: Boolean(config.webhookSharedSecret?.trim()),
  },
})

/**
 * Trata requisições HTTP para os endpoints de gerenciamento de conexões.
 * Retorna `true` se a rota foi reconhecida e tratada, `false` caso contrário.
 */
export async function handleConnectionsRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, logger: AppLogger): Promise<boolean> {
  const method = req.method ?? 'GET'

  // GET /connections
  if (method === 'GET' && pathname === '/connections') {
    sendJson(res, 200, await listConnectionsWithManagedFallback(logger))
    return true
  }

  // POST /connections — cria entrada sem conectar
  if (method === 'POST' && pathname === '/connections') {
    const body = parseJson<{ connectionId?: string; label?: string | null }>(await readBody(req))
    const id = parseConnectionIdOrReply(res, body?.connectionId)
    if (!id) return true
    const label = typeof body?.label === 'string' ? body.label : null

    if (!managerCanExecuteRuntimeActions()) {
      const existingManaged = await getManagedConnection(id)
      if (existingManaged && existingManaged.status !== 'deleted') {
        sendError(res, 409, 'connectionId já existe')
        return true
      }
      const created = await upsertManagedConnection({
        connectionId: id,
        displayName: label,
        status: 'inactive',
        desiredState: 'running',
        enabled: true,
        pairingState: 'not_required',
        webhookSource: 'api.dashboard',
      })
      sendJson(res, 201, buildConnectionWithAdmin(null, created))
      return true
    }

    if (getConnection(id)) {
      sendError(res, 409, 'connectionId já existe')
      return true
    }
    createConnection(id)
    if (label !== null) setConnectionLabel(id, label)
    sendJson(res, 201, await getConnectionWithManagedFallback(id, logger))
    return true
  }

  // GET /connections/:id
  const single = matchRoute('/connections/:id', pathname)
  if (method === 'GET' && single) {
    const id = parseConnectionIdOrReply(res, single.params['id'])
    if (!id) return true
    const info = await getConnectionWithManagedFallback(id, logger)
    if (!info) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    sendJson(res, 200, info)
    return true
  }

  // PATCH /connections/:id — atualiza label
  if (method === 'PATCH' && single) {
    const id = parseConnectionIdOrReply(res, single.params['id'])
    if (!id) return true
    const body = parseJson<{ label?: string | null }>(await readBody(req))
    const label = body && 'label' in body ? (body.label ?? null) : null

    if (!managerCanExecuteRuntimeActions()) {
      const existing = await getManagedConnection(id)
      if (!existing) {
        sendError(res, 404, 'conexão não encontrada')
        return true
      }
      const updated = await upsertManagedConnection({
        connectionId: id,
        displayName: label,
      })
      sendJson(res, 200, buildConnectionWithAdmin(null, updated))
      return true
    }

    if (!getConnection(id)) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    if (body && 'label' in body) setConnectionLabel(id, label)
    sendJson(res, 200, await getConnectionWithManagedFallback(id, logger))
    return true
  }

  // DELETE /connections/:id
  if (method === 'DELETE' && single) {
    const id = parseConnectionIdOrReply(res, single.params['id'])
    if (!id) return true

    if (!managerCanExecuteRuntimeActions()) {
      const existing = await getManagedConnection(id)
      if (!existing) {
        sendError(res, 404, 'conexão não encontrada')
        return true
      }
      await upsertManagedConnection({
        connectionId: id,
        status: 'deleted',
        desiredState: 'deleted',
        enabled: false,
        pairingState: 'not_required',
      })
      res.statusCode = 204
      res.end()
      return true
    }

    if (!getConnection(id)) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    await deleteConnection(id, logger)
    res.statusCode = 204
    res.end()
    return true
  }

  // DELETE /connections/:id/hard?force=true
  const hardDeleteMatch = matchRoute('/connections/:id/hard', pathname)
  if (method === 'DELETE' && hardDeleteMatch) {
    const id = parseConnectionIdOrReply(res, hardDeleteMatch.params['id'])
    if (!id) return true
    if (!managerCanExecuteRuntimeActions()) {
      sendError(res, 409, MANAGER_DISABLED_ERROR)
      return true
    }

    const guard = validateHardDeleteGuard(req)
    if (!guard.ok) {
      sendError(res, guard.httpStatus, guard.reason)
      return true
    }

    const info = await getConnectionWithManagedFallback(id, logger)
    if (!info) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }

    await hardDeleteConnection(id, logger)
    res.statusCode = 204
    res.end()
    return true
  }

  // POST /connections/:id/connect || /connections/:id/start
  const connectMatch = matchRoute('/connections/:id/connect', pathname) ?? matchRoute('/connections/:id/start', pathname)
  if (method === 'POST' && connectMatch) {
    const id = parseConnectionIdOrReply(res, connectMatch.params['id'])
    if (!id) return true
    if (!managerCanExecuteRuntimeActions()) {
      sendError(res, 409, MANAGER_DISABLED_ERROR)
      return true
    }
    if (!getConnection(id)) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    await connect(id, logger)
    sendJson(res, 200, await getConnectionWithManagedFallback(id, logger))
    return true
  }

  // POST /connections/:id/webhook/start
  const webhookStartMatch = matchRoute('/connections/:id/webhook/start', pathname)
  if (method === 'POST' && webhookStartMatch) {
    const id = parseConnectionIdOrReply(res, webhookStartMatch.params['id'])
    if (!id) return true
    const body = parseJson<{ label?: string | null }>(await readBody(req))
    const label = typeof body?.label === 'string' ? body.label.trim() || null : null

    if (managerCanExecuteRuntimeActions()) {
      if (!getConnection(id)) {
        createConnection(id)
      }
      if (label !== null) {
        setConnectionLabel(id, label)
      }
    } else {
      const existing = await getManagedConnection(id)
      await upsertManagedConnection({
        connectionId: id,
        displayName: label ?? existing?.displayName ?? null,
        status: existing?.status ?? 'inactive',
        desiredState: 'running',
        enabled: true,
        pairingState: existing?.pairingState ?? 'not_required',
        webhookSource: 'api.dashboard.webhook-start',
      })
    }

    const dispatched = await dispatchStartCommandViaWebhook(id, label)
    sendJson(res, dispatched.status, dispatched.payload)
    return true
  }

  // POST /connections/:id/disconnect
  const disconnectMatch = matchRoute('/connections/:id/disconnect', pathname)
  if (method === 'POST' && disconnectMatch) {
    const id = parseConnectionIdOrReply(res, disconnectMatch.params['id'])
    if (!id) return true
    if (!managerCanExecuteRuntimeActions()) {
      sendError(res, 409, MANAGER_DISABLED_ERROR)
      return true
    }
    if (!getConnection(id)) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    await disconnect(id, logger)
    sendJson(res, 200, getConnection(id))
    return true
  }

  // POST /connections/:id/pause
  const pauseMatch = matchRoute('/connections/:id/pause', pathname)
  if (method === 'POST' && pauseMatch) {
    const id = parseConnectionIdOrReply(res, pauseMatch.params['id'])
    if (!id) return true
    if (!managerCanExecuteRuntimeActions()) {
      sendError(res, 409, MANAGER_DISABLED_ERROR)
      return true
    }
    if (!getConnection(id)) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    await pause(id, logger)
    sendJson(res, 200, await getConnectionWithManagedFallback(id, logger))
    return true
  }

  // POST /connections/:id/resume
  const resumeMatch = matchRoute('/connections/:id/resume', pathname)
  if (method === 'POST' && resumeMatch) {
    const id = parseConnectionIdOrReply(res, resumeMatch.params['id'])
    if (!id) return true
    if (!managerCanExecuteRuntimeActions()) {
      sendError(res, 409, MANAGER_DISABLED_ERROR)
      return true
    }
    if (!getConnection(id)) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    await resume(id, logger)
    sendJson(res, 200, await getConnectionWithManagedFallback(id, logger))
    return true
  }

  // POST /connections/:id/restart || /connections/:id/reconnect
  const restartMatch = matchRoute('/connections/:id/restart', pathname) ?? matchRoute('/connections/:id/reconnect', pathname)
  if (method === 'POST' && restartMatch) {
    const id = parseConnectionIdOrReply(res, restartMatch.params['id'])
    if (!id) return true
    if (!managerCanExecuteRuntimeActions()) {
      sendError(res, 409, MANAGER_DISABLED_ERROR)
      return true
    }
    if (!getConnection(id)) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    await restart(id, logger)
    sendJson(res, 200, await getConnectionWithManagedFallback(id, logger))
    return true
  }

  // POST /connections/:id/pairing/start
  const pairingStartMatch = matchRoute('/connections/:id/pairing/start', pathname)
  if (method === 'POST' && pairingStartMatch) {
    const id = parseConnectionIdOrReply(res, pairingStartMatch.params['id'])
    if (!id) return true
    if (!managerCanExecuteRuntimeActions()) {
      sendError(res, 409, MANAGER_DISABLED_ERROR)
      return true
    }
    if (!getConnection(id)) {
      createConnection(id)
    }
    const state = await startPairing(id)
    sendJson(res, 202, state)
    return true
  }

  // POST /connections/:id/pairing/cancel
  const pairingCancelMatch = matchRoute('/connections/:id/pairing/cancel', pathname)
  if (method === 'POST' && pairingCancelMatch) {
    const id = parseConnectionIdOrReply(res, pairingCancelMatch.params['id'])
    if (!id) return true
    if (!managerCanExecuteRuntimeActions()) {
      sendError(res, 409, MANAGER_DISABLED_ERROR)
      return true
    }
    if (!getConnection(id)) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    const state = await cancelPairing(id)
    sendJson(res, 200, state)
    return true
  }

  // GET /connections/:id/pairing
  const pairingGetMatch = matchRoute('/connections/:id/pairing', pathname)
  if (method === 'GET' && pairingGetMatch) {
    const id = parseConnectionIdOrReply(res, pairingGetMatch.params['id'])
    if (!id) return true
    if (!managerCanExecuteRuntimeActions()) {
      sendError(res, 409, MANAGER_DISABLED_ERROR)
      return true
    }
    if (!getConnection(id)) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    const state = await getPairingState(id)
    sendJson(res, 200, state)
    return true
  }

  // GET /connections/:id/status
  const statusMatch = matchRoute('/connections/:id/status', pathname)
  if (method === 'GET' && statusMatch) {
    const id = parseConnectionIdOrReply(res, statusMatch.params['id'])
    if (!id) return true
    const info = await getConnectionWithManagedFallback(id, logger)
    if (!info) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    sendJson(res, 200, {
      ...info.admin,
      connectionId: info.connectionId,
      status: info.status,
      socketActive: info.socketActive,
      reconnectInFlight: info.reconnectInFlight,
      admin: info.admin,
    })
    return true
  }

  // GET /connections/:id/events
  const eventsMatch = matchRoute('/connections/:id/events', pathname)
  if (method === 'GET' && eventsMatch) {
    const id = parseConnectionIdOrReply(res, eventsMatch.params['id'])
    if (!id) return true
    const info = await getConnectionWithManagedFallback(id, logger)
    if (!info) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    const limit = parsePositiveLimit(req)
    const events = await listConnectionAdminEvents(id, limit)
    sendJson(res, 200, {
      connectionId: id,
      count: events.length,
      limit,
      events,
    })
    return true
  }

  // GET /connections/:id/commands
  const commandsMatch = matchRoute('/connections/:id/commands', pathname)
  if (method === 'GET' && commandsMatch) {
    const id = parseConnectionIdOrReply(res, commandsMatch.params['id'])
    if (!id) return true
    const info = await getConnectionWithManagedFallback(id, logger)
    if (!info) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    const limit = parsePositiveLimit(req)
    const commands = await listWebhookCommands(id, limit)
    sendJson(res, 200, {
      connectionId: id,
      count: commands.length,
      limit,
      commands,
    })
    return true
  }

  // GET /connections/commands/:commandId
  const commandByIdMatch = matchRoute('/connections/commands/:commandId', pathname)
  if (method === 'GET' && commandByIdMatch) {
    const commandId = String(commandByIdMatch.params['commandId'] ?? '').trim()
    if (!commandId) {
      sendError(res, 400, 'commandId é obrigatório')
      return true
    }
    const command = await getWebhookCommand(commandId)
    if (!command) {
      sendError(res, 404, 'comando não encontrado')
      return true
    }
    sendJson(res, 200, command)
    return true
  }

  // GET /connections/:id/diagnostics
  const diagnosticsMatch = matchRoute('/connections/:id/diagnostics', pathname)
  if (method === 'GET' && diagnosticsMatch) {
    const id = parseConnectionIdOrReply(res, diagnosticsMatch.params['id'])
    if (!id) return true
    const info = await getConnectionWithManagedFallback(id, logger)
    if (!info) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    sendJson(res, 200, buildDiagnosticsPayload(info))
    return true
  }

  // GET /connections/:id/qr
  const qrMatch = matchRoute('/connections/:id/qr', pathname)
  if (method === 'GET' && qrMatch) {
    const id = parseConnectionIdOrReply(res, qrMatch.params['id'])
    if (!id) return true
    const info = getConnection(id)
    if (!info) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    if (!info.qrCode) {
      sendError(res, 404, 'QR code não disponível')
      return true
    }
    sendJson(res, 200, { connectionId: info.connectionId, qrCode: info.qrCode, qrCodeAt: info.qrCodeAt })
    return true
  }

  return false
}
