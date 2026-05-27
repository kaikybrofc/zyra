import type { OkPacket, RowDataPacket } from 'mysql2/promise'
import { ensureMysqlConnection } from '../core/db/connection.js'
import { getMysqlPool } from '../core/db/mysql.js'

export type ManagedConnectionStatus =
  | 'inactive'
  | 'starting'
  | 'connecting'
  | 'open'
  | 'closing'
  | 'closed'
  | 'pairing'
  | 'error'
  | 'paused'
  | 'deleted'

export type ManagedConnectionDesiredState = 'running' | 'stopped' | 'paused' | 'deleted'

export type ManagedConnectionPairingState =
  | 'not_required'
  | 'pending'
  | 'qr_ready'
  | 'paired'
  | 'expired'
  | 'failed'

export type ManagedConnectionRecord = {
  connectionId: string
  displayName: string | null
  status: ManagedConnectionStatus
  desiredState: ManagedConnectionDesiredState
  enabled: boolean
  pairingState: ManagedConnectionPairingState
  pairingCode: string | null
  lastSeenAt: number | null
  lastConnectedAt: number | null
  lastDisconnectedAt: number | null
  lastDisconnectCode: number | null
  lastError: string | null
  webhookSource: string | null
  metadata: unknown
  createdAt: number
  updatedAt: number
}

export type UpsertManagedConnectionInput = {
  connectionId: string
  displayName?: string | null
  status?: ManagedConnectionStatus
  desiredState?: ManagedConnectionDesiredState
  enabled?: boolean
  pairingState?: ManagedConnectionPairingState
  pairingCode?: string | null
  lastSeenAt?: number | null
  lastConnectedAt?: number | null
  lastDisconnectedAt?: number | null
  lastDisconnectCode?: number | null
  lastError?: string | null
  webhookSource?: string | null
  metadata?: unknown
}

export type ConnectionAdminEventRecord = {
  id: number
  connectionId: string
  eventType: string
  actor: string | null
  source: string | null
  oldState: string | null
  newState: string | null
  payload: unknown
  createdAt: number
}

export type CreateConnectionAdminEventInput = {
  connectionId: string
  eventType: string
  actor?: string | null
  source?: string | null
  oldState?: string | null
  newState?: string | null
  payload?: unknown
}

export type WebhookCommandStatus = 'received' | 'accepted' | 'rejected' | 'failed'

export type WebhookCommandRecord = {
  commandId: string
  connectionId: string
  deliveryId: string | null
  actionType: string
  payload: unknown
  status: WebhookCommandStatus
  response: unknown
  receivedAt: number
  processedAt: number | null
}

export type CreateWebhookCommandInput = {
  commandId: string
  connectionId: string
  deliveryId?: string | null
  actionType: string
  payload: unknown
}

type ManagedConnectionRow = RowDataPacket & {
  connection_id: string
  display_name: string | null
  status: ManagedConnectionStatus
  desired_state: ManagedConnectionDesiredState
  enabled: number
  pairing_state: ManagedConnectionPairingState
  pairing_code: string | null
  last_seen_at: Date | string | null
  last_connected_at: Date | string | null
  last_disconnected_at: Date | string | null
  last_disconnect_code: number | null
  last_error: string | null
  webhook_source: string | null
  metadata_json: unknown
  created_at: Date | string
  updated_at: Date | string
}

type ConnectionAdminEventRow = RowDataPacket & {
  id: number
  connection_id: string
  event_type: string
  actor: string | null
  source: string | null
  old_state: string | null
  new_state: string | null
  payload_json: unknown
  created_at: Date | string
}

type WebhookCommandRow = RowDataPacket & {
  command_id: string
  connection_id: string
  delivery_id: string | null
  action_type: string
  payload_json: unknown
  status: WebhookCommandStatus
  response_json: unknown
  received_at: Date | string
  processed_at: Date | string | null
}

const managedConnections = new Map<string, ManagedConnectionRecord>()
const connectionAdminEvents: ConnectionAdminEventRecord[] = []
const webhookCommands = new Map<string, WebhookCommandRecord>()
let nextEventId = 1

const toMillis = (value: Date | string | null): number | null => {
  if (!value) return null
  if (value instanceof Date) return value.getTime()
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

const parseJsonColumn = (value: unknown): unknown => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value ?? null
}

const toManagedConnectionRecord = (row: ManagedConnectionRow): ManagedConnectionRecord => ({
  connectionId: row.connection_id,
  displayName: row.display_name,
  status: row.status,
  desiredState: row.desired_state,
  enabled: row.enabled === 1,
  pairingState: row.pairing_state,
  pairingCode: row.pairing_code,
  lastSeenAt: toMillis(row.last_seen_at),
  lastConnectedAt: toMillis(row.last_connected_at),
  lastDisconnectedAt: toMillis(row.last_disconnected_at),
  lastDisconnectCode: row.last_disconnect_code,
  lastError: row.last_error,
  webhookSource: row.webhook_source,
  metadata: parseJsonColumn(row.metadata_json),
  createdAt: toMillis(row.created_at) ?? Date.now(),
  updatedAt: toMillis(row.updated_at) ?? Date.now(),
})

const toConnectionAdminEventRecord = (row: ConnectionAdminEventRow): ConnectionAdminEventRecord => ({
  id: row.id,
  connectionId: row.connection_id,
  eventType: row.event_type,
  actor: row.actor,
  source: row.source,
  oldState: row.old_state,
  newState: row.new_state,
  payload: parseJsonColumn(row.payload_json),
  createdAt: toMillis(row.created_at) ?? Date.now(),
})

const toWebhookCommandRecord = (row: WebhookCommandRow): WebhookCommandRecord => ({
  commandId: row.command_id,
  connectionId: row.connection_id,
  deliveryId: row.delivery_id,
  actionType: row.action_type,
  payload: parseJsonColumn(row.payload_json),
  status: row.status,
  response: parseJsonColumn(row.response_json),
  receivedAt: toMillis(row.received_at) ?? Date.now(),
  processedAt: toMillis(row.processed_at),
})

const asSqlDate = (value: number | null): Date | null => {
  if (value === null) return null
  return new Date(value)
}

const buildManagedRecord = (
  existing: ManagedConnectionRecord | null,
  input: UpsertManagedConnectionInput
): ManagedConnectionRecord => {
  const now = Date.now()
  return {
    connectionId: input.connectionId,
    displayName: input.displayName !== undefined ? input.displayName : (existing?.displayName ?? null),
    status: input.status ?? existing?.status ?? 'inactive',
    desiredState: input.desiredState ?? existing?.desiredState ?? 'running',
    enabled: input.enabled ?? existing?.enabled ?? true,
    pairingState: input.pairingState ?? existing?.pairingState ?? 'not_required',
    pairingCode: input.pairingCode !== undefined ? input.pairingCode : (existing?.pairingCode ?? null),
    lastSeenAt: input.lastSeenAt !== undefined ? input.lastSeenAt : (existing?.lastSeenAt ?? null),
    lastConnectedAt: input.lastConnectedAt !== undefined ? input.lastConnectedAt : (existing?.lastConnectedAt ?? null),
    lastDisconnectedAt:
      input.lastDisconnectedAt !== undefined
        ? input.lastDisconnectedAt
        : (existing?.lastDisconnectedAt ?? null),
    lastDisconnectCode:
      input.lastDisconnectCode !== undefined
        ? input.lastDisconnectCode
        : (existing?.lastDisconnectCode ?? null),
    lastError: input.lastError !== undefined ? input.lastError : (existing?.lastError ?? null),
    webhookSource: input.webhookSource !== undefined ? input.webhookSource : (existing?.webhookSource ?? null),
    metadata: input.metadata !== undefined ? input.metadata : (existing?.metadata ?? null),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export const getManagedConnection = async (connectionId: string): Promise<ManagedConnectionRecord | null> => {
  const pool = getMysqlPool()
  if (!pool) {
    return managedConnections.get(connectionId) ?? null
  }
  const [rows] = await pool.execute<ManagedConnectionRow[]>(
    `SELECT connection_id, display_name, status, desired_state, enabled,
            pairing_state, pairing_code, last_seen_at, last_connected_at,
            last_disconnected_at, last_disconnect_code, last_error, webhook_source,
            metadata_json, created_at, updated_at
     FROM managed_connections
     WHERE connection_id = ?
     LIMIT 1`,
    [connectionId]
  )
  const row = rows[0]
  if (!row) return null
  const record = toManagedConnectionRecord(row)
  managedConnections.set(record.connectionId, record)
  return record
}

export const listManagedConnections = async (): Promise<ManagedConnectionRecord[]> => {
  const pool = getMysqlPool()
  if (!pool) {
    return Array.from(managedConnections.values())
  }
  const [rows] = await pool.execute<ManagedConnectionRow[]>(
    `SELECT connection_id, display_name, status, desired_state, enabled,
            pairing_state, pairing_code, last_seen_at, last_connected_at,
            last_disconnected_at, last_disconnect_code, last_error, webhook_source,
            metadata_json, created_at, updated_at
     FROM managed_connections
     ORDER BY updated_at DESC, connection_id ASC`
  )
  const records = rows.map(toManagedConnectionRecord)
  for (const record of records) {
    managedConnections.set(record.connectionId, record)
  }
  return records
}

export const upsertManagedConnection = async (
  input: UpsertManagedConnectionInput
): Promise<ManagedConnectionRecord> => {
  const existing = await getManagedConnection(input.connectionId)
  const record = buildManagedRecord(existing, input)
  managedConnections.set(record.connectionId, record)

  const pool = getMysqlPool()
  if (!pool) {
    return record
  }

  await ensureMysqlConnection(pool, record.connectionId)
  await pool.execute(
    `INSERT INTO managed_connections (
        connection_id, display_name, status, desired_state, enabled,
        pairing_state, pairing_code, last_seen_at, last_connected_at,
        last_disconnected_at, last_disconnect_code, last_error, webhook_source,
        metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        display_name = VALUES(display_name),
        status = VALUES(status),
        desired_state = VALUES(desired_state),
        enabled = VALUES(enabled),
        pairing_state = VALUES(pairing_state),
        pairing_code = VALUES(pairing_code),
        last_seen_at = VALUES(last_seen_at),
        last_connected_at = VALUES(last_connected_at),
        last_disconnected_at = VALUES(last_disconnected_at),
        last_disconnect_code = VALUES(last_disconnect_code),
        last_error = VALUES(last_error),
        webhook_source = VALUES(webhook_source),
        metadata_json = VALUES(metadata_json),
        updated_at = NOW()`,
    [
      record.connectionId,
      record.displayName,
      record.status,
      record.desiredState,
      record.enabled ? 1 : 0,
      record.pairingState,
      record.pairingCode,
      asSqlDate(record.lastSeenAt),
      asSqlDate(record.lastConnectedAt),
      asSqlDate(record.lastDisconnectedAt),
      record.lastDisconnectCode,
      record.lastError,
      record.webhookSource,
      JSON.stringify(record.metadata ?? null),
    ]
  )
  return record
}

export const recordConnectionAdminEvent = async (
  input: CreateConnectionAdminEventInput
): Promise<ConnectionAdminEventRecord> => {
  const record: ConnectionAdminEventRecord = {
    id: nextEventId++,
    connectionId: input.connectionId,
    eventType: input.eventType,
    actor: input.actor ?? null,
    source: input.source ?? null,
    oldState: input.oldState ?? null,
    newState: input.newState ?? null,
    payload: input.payload ?? null,
    createdAt: Date.now(),
  }
  connectionAdminEvents.push(record)

  const pool = getMysqlPool()
  if (!pool) {
    return record
  }

  await ensureMysqlConnection(pool, record.connectionId)
  const [result] = await pool.execute<OkPacket>(
    `INSERT INTO connection_admin_events (
       connection_id, event_type, actor, source, old_state, new_state, payload_json, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      record.connectionId,
      record.eventType,
      record.actor,
      record.source,
      record.oldState,
      record.newState,
      JSON.stringify(record.payload ?? null),
    ]
  )
  if (typeof result.insertId === 'number' && result.insertId > 0) {
    record.id = result.insertId
  }
  return record
}

export const listConnectionAdminEvents = async (
  connectionId: string,
  limit = 100
): Promise<ConnectionAdminEventRecord[]> => {
  const pool = getMysqlPool()
  if (!pool) {
    return connectionAdminEvents
      .filter((event) => event.connectionId === connectionId)
      .slice(-limit)
      .reverse()
  }
  const [rows] = await pool.execute<ConnectionAdminEventRow[]>(
    `SELECT id, connection_id, event_type, actor, source, old_state, new_state, payload_json, created_at
     FROM connection_admin_events
     WHERE connection_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [connectionId, Math.max(1, Math.trunc(limit))]
  )
  return rows.map(toConnectionAdminEventRecord)
}

export const getWebhookCommand = async (commandId: string): Promise<WebhookCommandRecord | null> => {
  const pool = getMysqlPool()
  if (!pool) {
    return webhookCommands.get(commandId) ?? null
  }
  const [rows] = await pool.execute<WebhookCommandRow[]>(
    `SELECT command_id, connection_id, delivery_id, action_type, payload_json, status, response_json, received_at, processed_at
     FROM webhook_commands
     WHERE command_id = ?
     LIMIT 1`,
    [commandId]
  )
  const row = rows[0]
  if (!row) return null
  const record = toWebhookCommandRecord(row)
  webhookCommands.set(record.commandId, record)
  return record
}

export const getWebhookCommandByDeliveryId = async (
  deliveryId: string
): Promise<WebhookCommandRecord | null> => {
  if (!deliveryId) return null
  const pool = getMysqlPool()
  if (!pool) {
    for (const record of webhookCommands.values()) {
      if (record.deliveryId === deliveryId) return record
    }
    return null
  }
  const [rows] = await pool.execute<WebhookCommandRow[]>(
    `SELECT command_id, connection_id, delivery_id, action_type, payload_json, status, response_json, received_at, processed_at
     FROM webhook_commands
     WHERE delivery_id = ?
     LIMIT 1`,
    [deliveryId]
  )
  const row = rows[0]
  if (!row) return null
  const record = toWebhookCommandRecord(row)
  webhookCommands.set(record.commandId, record)
  return record
}

export const saveWebhookCommandReceived = async (
  input: CreateWebhookCommandInput
): Promise<{ created: boolean; record: WebhookCommandRecord }> => {
  const now = Date.now()
  const existing = await getWebhookCommand(input.commandId)
  if (existing) {
    return { created: false, record: existing }
  }

  const record: WebhookCommandRecord = {
    commandId: input.commandId,
    connectionId: input.connectionId,
    deliveryId: input.deliveryId ?? null,
    actionType: input.actionType,
    payload: input.payload,
    status: 'received',
    response: null,
    receivedAt: now,
    processedAt: null,
  }
  webhookCommands.set(record.commandId, record)

  const pool = getMysqlPool()
  if (!pool) {
    return { created: true, record }
  }

  const [insertResult] = await pool.execute<OkPacket>(
    `INSERT IGNORE INTO webhook_commands (
       command_id, connection_id, delivery_id, action_type, payload_json, status, response_json, received_at, processed_at
     )
     VALUES (?, ?, ?, ?, ?, 'received', NULL, NOW(), NULL)`,
    [
      input.commandId,
      input.connectionId,
      input.deliveryId ?? null,
      input.actionType,
      JSON.stringify(input.payload ?? null),
    ]
  )

  if ((insertResult.affectedRows ?? 0) === 0) {
    const loaded = await getWebhookCommand(input.commandId)
    if (loaded) return { created: false, record: loaded }
    if (input.deliveryId) {
      const existingByDeliveryId = await getWebhookCommandByDeliveryId(input.deliveryId)
      if (existingByDeliveryId) return { created: false, record: existingByDeliveryId }
    }
    return { created: false, record }
  }

  return { created: true, record }
}

export const finishWebhookCommand = async (
  commandId: string,
  patch: { status: Exclude<WebhookCommandStatus, 'received'>; response: unknown }
): Promise<WebhookCommandRecord | null> => {
  const existing = await getWebhookCommand(commandId)
  if (!existing) return null

  const updated: WebhookCommandRecord = {
    ...existing,
    status: patch.status,
    response: patch.response,
    processedAt: Date.now(),
  }
  webhookCommands.set(commandId, updated)

  const pool = getMysqlPool()
  if (!pool) {
    return updated
  }

  await pool.execute(
    `UPDATE webhook_commands
     SET status = ?, response_json = ?, processed_at = NOW()
     WHERE command_id = ?`,
    [patch.status, JSON.stringify(patch.response ?? null), commandId]
  )
  return updated
}

export const _resetConnectionAdminStore = () => {
  managedConnections.clear()
  connectionAdminEvents.length = 0
  webhookCommands.clear()
  nextEventId = 1
}
