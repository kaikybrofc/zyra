import { randomUUID } from 'node:crypto'
import type { RowDataPacket, OkPacket } from 'mysql2/promise'
import { getMysqlPool } from '../core/db/mysql.js'
import type { WebhookRecord, DeliveryRecord, DeliveryStatus } from './types.js'

export const GLOBAL_WEBHOOK_CONNECTION_ID = '__global__'

const webhooks = new Map<string, WebhookRecord>()
const deliveries = new Map<string, DeliveryRecord>()

/** connectionIds already loaded from MySQL into memory */
const loadedConnections = new Set<string>()

// ─── MySQL row types ───────────────────────────────────────────────────────

type WebhookRow = RowDataPacket & {
  id: string
  connection_id: string
  url: string
  events_filter: string
  active: number
  secret: string | null
  created_at: Date
  updated_at: Date
}

type DeliveryRow = RowDataPacket & {
  id: string
  webhook_id: string
  connection_id: string
  event_type: string
  payload: string
  status: DeliveryStatus
  attempts: number
  last_attempt_at: Date | null
  next_retry_at: Date | null
  response_status: number | null
  response_body: string | null
  created_at: Date
}

// ─── Converters ────────────────────────────────────────────────────────────

const rowToWebhook = (row: WebhookRow): WebhookRecord => ({
  id: row.id,
  connectionId: row.connection_id,
  url: row.url,
  eventsFilter: (typeof row.events_filter === 'string' ? JSON.parse(row.events_filter) : row.events_filter) as string[],
  active: row.active === 1,
  secret: row.secret,
  createdAt: row.created_at.getTime(),
  updatedAt: row.updated_at.getTime(),
})

const rowToDelivery = (row: DeliveryRow): DeliveryRecord => ({
  id: row.id,
  webhookId: row.webhook_id,
  connectionId: row.connection_id,
  eventType: row.event_type,
  payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  status: row.status,
  attempts: row.attempts,
  lastAttemptAt: row.last_attempt_at ? row.last_attempt_at.getTime() : null,
  nextRetryAt: row.next_retry_at ? row.next_retry_at.getTime() : null,
  responseStatus: row.response_status,
  responseBody: row.response_body,
  createdAt: row.created_at.getTime(),
})

// ─── Lazy load ─────────────────────────────────────────────────────────────

const loadWebhooksForConnection = async (connectionId: string): Promise<void> => {
  if (loadedConnections.has(connectionId)) return
  const pool = getMysqlPool()
  if (!pool) {
    loadedConnections.add(connectionId)
    return
  }
  const [rows] = await pool.execute<WebhookRow[]>(
    `SELECT id, connection_id, url, events_filter, active, secret, created_at, updated_at
     FROM webhooks WHERE connection_id = ?`,
    [connectionId]
  )
  for (const row of rows) {
    const wh = rowToWebhook(row)
    webhooks.set(wh.id, wh)
  }
  loadedConnections.add(connectionId)
}

// ─── Webhook CRUD ──────────────────────────────────────────────────────────

export const createWebhook = async (connectionId: string, data: { url: string; eventsFilter: string[]; secret?: string | null }): Promise<WebhookRecord> => {
  await loadWebhooksForConnection(connectionId)
  const id = randomUUID()
  const now = Date.now()
  const record: WebhookRecord = {
    id,
    connectionId,
    url: data.url,
    eventsFilter: data.eventsFilter,
    active: true,
    secret: data.secret ?? null,
    createdAt: now,
    updatedAt: now,
  }
  webhooks.set(id, record)

  const pool = getMysqlPool()
  if (pool) {
    await pool.execute(
      `INSERT INTO webhooks (id, connection_id, url, events_filter, active, secret, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, NOW(), NOW())`,
      [id, connectionId, data.url, JSON.stringify(data.eventsFilter), data.secret ?? null]
    )
  }

  return record
}

export const listWebhooks = async (connectionId: string): Promise<WebhookRecord[]> => {
  await loadWebhooksForConnection(connectionId)
  return Array.from(webhooks.values()).filter((wh) => wh.connectionId === connectionId)
}

export const getWebhook = async (id: string, connectionId: string): Promise<WebhookRecord | null> => {
  await loadWebhooksForConnection(connectionId)
  const wh = webhooks.get(id)
  return wh && wh.connectionId === connectionId ? wh : null
}

export const updateWebhook = async (id: string, connectionId: string, patch: Partial<Pick<WebhookRecord, 'url' | 'eventsFilter' | 'active' | 'secret'>>): Promise<WebhookRecord | null> => {
  await loadWebhooksForConnection(connectionId)
  const existing = webhooks.get(id)
  if (!existing || existing.connectionId !== connectionId) return null

  const updated: WebhookRecord = {
    ...existing,
    ...(patch.url !== undefined && { url: patch.url }),
    ...(patch.eventsFilter !== undefined && { eventsFilter: patch.eventsFilter }),
    ...(patch.active !== undefined && { active: patch.active }),
    ...(patch.secret !== undefined && { secret: patch.secret }),
    updatedAt: Date.now(),
  }
  webhooks.set(id, updated)

  const pool = getMysqlPool()
  if (pool) {
    const setClauses: string[] = ['updated_at = NOW()']
    const params: Array<string | number | null> = []
    if (patch.url !== undefined) {
      setClauses.push('url = ?')
      params.push(patch.url)
    }
    if (patch.eventsFilter !== undefined) {
      setClauses.push('events_filter = ?')
      params.push(JSON.stringify(patch.eventsFilter))
    }
    if (patch.active !== undefined) {
      setClauses.push('active = ?')
      params.push(patch.active ? 1 : 0)
    }
    if (patch.secret !== undefined) {
      setClauses.push('secret = ?')
      params.push(patch.secret)
    }
    params.push(id)
    await pool.execute(`UPDATE webhooks SET ${setClauses.join(', ')} WHERE id = ?`, params)
  }

  return updated
}

export const deleteWebhook = async (id: string, connectionId: string): Promise<boolean> => {
  await loadWebhooksForConnection(connectionId)
  const existing = webhooks.get(id)
  if (!existing || existing.connectionId !== connectionId) return false
  webhooks.delete(id)

  const pool = getMysqlPool()
  if (pool) {
    const [result] = await pool.execute<OkPacket>(`DELETE FROM webhooks WHERE id = ? AND connection_id = ?`, [id, connectionId])
    return result.affectedRows > 0
  }
  return true
}

export const getActiveWebhooksForEvent = async (connectionId: string, event: string): Promise<WebhookRecord[]> => {
  const { webhookMatchesEvent } = await import('./events.js')
  await loadWebhooksForConnection(connectionId)
  await loadWebhooksForConnection(GLOBAL_WEBHOOK_CONNECTION_ID)
  return Array.from(webhooks.values()).filter((wh) => (wh.connectionId === connectionId || wh.connectionId === GLOBAL_WEBHOOK_CONNECTION_ID) && wh.active && webhookMatchesEvent(wh.eventsFilter, event))
}

// ─── Delivery CRUD ─────────────────────────────────────────────────────────

export const createDelivery = async (data: { webhookId: string; connectionId: string; eventType: string; payload: unknown }): Promise<DeliveryRecord> => {
  const id = randomUUID()
  const now = Date.now()
  const record: DeliveryRecord = {
    id,
    webhookId: data.webhookId,
    connectionId: data.connectionId,
    eventType: data.eventType,
    payload: data.payload,
    status: 'pending',
    attempts: 0,
    lastAttemptAt: null,
    nextRetryAt: null,
    responseStatus: null,
    responseBody: null,
    createdAt: now,
  }
  deliveries.set(id, record)

  const pool = getMysqlPool()
  if (pool) {
    await pool.execute(
      `INSERT INTO webhook_deliveries
         (id, webhook_id, connection_id, event_type, payload, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, NOW())`,
      [id, data.webhookId, data.connectionId, data.eventType, JSON.stringify(data.payload)]
    )
  }

  return record
}

export const updateDelivery = async (
  id: string,
  patch: {
    status: DeliveryStatus
    attempts: number
    lastAttemptAt: number
    nextRetryAt: number | null
    responseStatus: number | null
    responseBody: string | null
  }
): Promise<void> => {
  const existing = deliveries.get(id)
  if (existing) {
    deliveries.set(id, {
      ...existing,
      status: patch.status,
      attempts: patch.attempts,
      lastAttemptAt: patch.lastAttemptAt,
      nextRetryAt: patch.nextRetryAt,
      responseStatus: patch.responseStatus,
      responseBody: patch.responseBody,
    })
  }

  const pool = getMysqlPool()
  if (pool) {
    await pool.execute(
      `UPDATE webhook_deliveries
       SET status = ?, attempts = ?, last_attempt_at = FROM_UNIXTIME(?),
           next_retry_at = IF(? IS NULL, NULL, FROM_UNIXTIME(?)),
           response_status = ?, response_body = ?
       WHERE id = ?`,
      [patch.status, patch.attempts, Math.floor(patch.lastAttemptAt / 1000), patch.nextRetryAt, patch.nextRetryAt !== null ? Math.floor(patch.nextRetryAt / 1000) : null, patch.responseStatus, patch.responseBody, id]
    )
  }
}

export const getDelivery = (id: string): DeliveryRecord | null => deliveries.get(id) ?? null

export const listDeliveries = async (webhookId: string): Promise<DeliveryRecord[]> => {
  const inMemory = Array.from(deliveries.values()).filter((d) => d.webhookId === webhookId)
  if (inMemory.length > 0) return inMemory

  const pool = getMysqlPool()
  if (!pool) return []
  const [rows] = await pool.execute<DeliveryRow[]>(
    `SELECT id, webhook_id, connection_id, event_type, payload, status, attempts,
            last_attempt_at, next_retry_at, response_status, response_body, created_at
     FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 100`,
    [webhookId]
  )
  return rows.map(rowToDelivery)
}

export const getPendingRetries = async (): Promise<DeliveryRecord[]> => {
  const now = Date.now()
  const inMemory = Array.from(deliveries.values()).filter((d) => d.status === 'failed' && d.nextRetryAt !== null && d.nextRetryAt <= now)
  if (inMemory.length > 0) return inMemory

  const pool = getMysqlPool()
  if (!pool) return []
  const [rows] = await pool.execute<DeliveryRow[]>(
    `SELECT id, webhook_id, connection_id, event_type, payload, status, attempts,
            last_attempt_at, next_retry_at, response_status, response_body, created_at
     FROM webhook_deliveries
     WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()
     LIMIT 50`,
    []
  )
  const records = rows.map(rowToDelivery)
  for (const r of records) deliveries.set(r.id, r)
  return records
}

export const retryDelivery = async (id: string): Promise<DeliveryRecord | null> => {
  const pool = getMysqlPool()
  if (pool) {
    const [rows] = await pool.execute<DeliveryRow[]>(
      `SELECT id, webhook_id, connection_id, event_type, payload, status, attempts,
              last_attempt_at, next_retry_at, response_status, response_body, created_at
       FROM webhook_deliveries WHERE id = ?`,
      [id]
    )
    if (!rows.length) return null
    const record = rowToDelivery(rows[0]!)
    deliveries.set(record.id, record)
    return record
  }
  return deliveries.get(id) ?? null
}

/** Exposed for testing — reset in-memory state */
export const _resetStore = () => {
  webhooks.clear()
  deliveries.clear()
  loadedConnections.clear()
}
