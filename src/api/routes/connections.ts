import { createHmac, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { config } from '../../config/index.js'
import type { AppLogger } from '../../observability/logger.js'
import {
  type ConnectionInfo,
  createConnection,
  listConnections,
  getConnection,
  setConnectionLabel,
  connect,
  disconnect,
  restart,
  deleteConnection,
} from '../../core/connection/manager.js'
import { startPairing, getPairingState, cancelPairing } from '../../core/connection/pairing-service.js'
import {
  getManagedConnection,
  listManagedConnections,
  upsertManagedConnection,
  type ManagedConnectionRecord,
  type ManagedConnectionPairingState,
  type ManagedConnectionStatus,
} from '../../store/connection-admin-store.js'
import { readBody, parseJson, sendJson, sendError, matchRoute } from '../http.js'

const MANAGER_DISABLED_ERROR = 'operação indisponível neste processo (WA_BOOTSTRAP_CONNECTIONS_ENABLED=false)'

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

const signWebhookCommand = (secret: string, timestamp: string, body: string): string => {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')
  return `sha256=${digest}`
}

const resolveLocalWebhookIngressUrl = (): string => {
  const rawHost = config.apiHost.trim()
  const host = rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost
  return `http://${host}:${config.apiPort}/webhooks/connections`
}

const dispatchStartCommandViaWebhook = async (
  connectionId: string,
  label: string | null
): Promise<{ status: number; payload: WebhookCommandResponse | { error: string } }> => {
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

const mapRuntimeStatusToManaged = (
  status: ConnectionInfo['status'],
  desiredState: ConnectionAdminStatusView['desired_state']
): ManagedConnectionStatus => {
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

const buildAdminStatus = (
  runtime: ConnectionInfo | null,
  managed: ManagedConnectionRecord | null
): ConnectionAdminStatusView => {
  const connectionId = runtime?.connectionId ?? managed?.connectionId ?? ''
  const desiredState = managed?.desiredState ?? 'running'
  const runtimeStatus = runtime?.status ?? null
  const resolvedStatus = runtimeStatus
    ? mapRuntimeStatusToManaged(runtimeStatus, desiredState)
    : (managed?.status ?? 'closed')
  const pairingState =
    runtimeStatus === 'qr'
      ? 'qr_ready'
      : (managed?.pairingState ?? 'not_required')
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

const buildConnectionWithAdmin = (
  runtime: ConnectionInfo | null,
  managed: ManagedConnectionRecord | null
): ConnectionWithAdmin | null => {
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

const getConnectionWithManagedFallback = async (
  connectionId: string,
  logger: AppLogger
): Promise<ConnectionWithAdmin | null> => {
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

/**
 * Trata requisições HTTP para os endpoints de gerenciamento de conexões.
 * Retorna `true` se a rota foi reconhecida e tratada, `false` caso contrário.
 */
export async function handleConnectionsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  logger: AppLogger
): Promise<boolean> {
  const method = req.method ?? 'GET'

  // GET /connections
  if (method === 'GET' && pathname === '/connections') {
    sendJson(res, 200, await listConnectionsWithManagedFallback(logger))
    return true
  }

  // POST /connections — cria entrada sem conectar
  if (method === 'POST' && pathname === '/connections') {
    const body = parseJson<{ connectionId?: string; label?: string | null }>(await readBody(req))
    const id = body?.connectionId?.trim()
    if (!id) {
      sendError(res, 400, 'connectionId é obrigatório')
      return true
    }
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
    const info = await getConnectionWithManagedFallback(single.params['id'] ?? '', logger)
    if (!info) { sendError(res, 404, 'conexão não encontrada'); return true }
    sendJson(res, 200, info)
    return true
  }

  // PATCH /connections/:id — atualiza label
  if (method === 'PATCH' && single) {
    const id = single.params['id'] ?? ''
    const body = parseJson<{ label?: string | null }>(await readBody(req))
    const label = body && 'label' in body ? body.label ?? null : null

    if (!managerCanExecuteRuntimeActions()) {
      const existing = await getManagedConnection(id)
      if (!existing) { sendError(res, 404, 'conexão não encontrada'); return true }
      const updated = await upsertManagedConnection({
        connectionId: id,
        displayName: label,
      })
      sendJson(res, 200, buildConnectionWithAdmin(null, updated))
      return true
    }

    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    if (body && 'label' in body) setConnectionLabel(id, label)
    sendJson(res, 200, await getConnectionWithManagedFallback(id, logger))
    return true
  }

  // DELETE /connections/:id
  if (method === 'DELETE' && single) {
    const id = single.params['id'] ?? ''

    if (!managerCanExecuteRuntimeActions()) {
      const existing = await getManagedConnection(id)
      if (!existing) { sendError(res, 404, 'conexão não encontrada'); return true }
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

    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    await deleteConnection(id, logger)
    res.statusCode = 204
    res.end()
    return true
  }

  // POST /connections/:id/connect || /connections/:id/start
  const connectMatch = matchRoute('/connections/:id/connect', pathname) ?? matchRoute('/connections/:id/start', pathname)
  if (method === 'POST' && connectMatch) {
    const id = connectMatch.params['id'] ?? ''
    if (!managerCanExecuteRuntimeActions()) { sendError(res, 409, MANAGER_DISABLED_ERROR); return true }
    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    await connect(id, logger)
    sendJson(res, 200, await getConnectionWithManagedFallback(id, logger))
    return true
  }

  // POST /connections/:id/webhook/start
  const webhookStartMatch = matchRoute('/connections/:id/webhook/start', pathname)
  if (method === 'POST' && webhookStartMatch) {
    const id = webhookStartMatch.params['id'] ?? ''
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
    const id = disconnectMatch.params['id'] ?? ''
    if (!managerCanExecuteRuntimeActions()) { sendError(res, 409, MANAGER_DISABLED_ERROR); return true }
    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    await disconnect(id, logger)
    sendJson(res, 200, getConnection(id))
    return true
  }

  // POST /connections/:id/restart || /connections/:id/reconnect
  const restartMatch = matchRoute('/connections/:id/restart', pathname) ?? matchRoute('/connections/:id/reconnect', pathname)
  if (method === 'POST' && restartMatch) {
    const id = restartMatch.params['id'] ?? ''
    if (!managerCanExecuteRuntimeActions()) { sendError(res, 409, MANAGER_DISABLED_ERROR); return true }
    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    await restart(id, logger)
    sendJson(res, 200, await getConnectionWithManagedFallback(id, logger))
    return true
  }

  // POST /connections/:id/pairing/start
  const pairingStartMatch = matchRoute('/connections/:id/pairing/start', pathname)
  if (method === 'POST' && pairingStartMatch) {
    const id = pairingStartMatch.params['id'] ?? ''
    if (!managerCanExecuteRuntimeActions()) { sendError(res, 409, MANAGER_DISABLED_ERROR); return true }
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
    const id = pairingCancelMatch.params['id'] ?? ''
    if (!managerCanExecuteRuntimeActions()) { sendError(res, 409, MANAGER_DISABLED_ERROR); return true }
    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    const state = await cancelPairing(id)
    sendJson(res, 200, state)
    return true
  }

  // GET /connections/:id/pairing
  const pairingGetMatch = matchRoute('/connections/:id/pairing', pathname)
  if (method === 'GET' && pairingGetMatch) {
    const id = pairingGetMatch.params['id'] ?? ''
    if (!managerCanExecuteRuntimeActions()) { sendError(res, 409, MANAGER_DISABLED_ERROR); return true }
    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    const state = await getPairingState(id)
    sendJson(res, 200, state)
    return true
  }

  // GET /connections/:id/status
  const statusMatch = matchRoute('/connections/:id/status', pathname)
  if (method === 'GET' && statusMatch) {
    const info = await getConnectionWithManagedFallback(statusMatch.params['id'] ?? '', logger)
    if (!info) { sendError(res, 404, 'conexão não encontrada'); return true }
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

  // GET /connections/:id/qr
  const qrMatch = matchRoute('/connections/:id/qr', pathname)
  if (method === 'GET' && qrMatch) {
    const info = getConnection(qrMatch.params['id'] ?? '')
    if (!info) { sendError(res, 404, 'conexão não encontrada'); return true }
    if (!info.qrCode) { sendError(res, 404, 'QR code não disponível'); return true }
    sendJson(res, 200, { connectionId: info.connectionId, qrCode: info.qrCode, qrCodeAt: info.qrCodeAt })
    return true
  }

  return false
}
