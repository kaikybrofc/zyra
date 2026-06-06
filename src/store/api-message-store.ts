import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import { config } from '../config/index.js'
import { ensureMysqlConnection } from '../core/db/connection.js'
import { getMysqlPool } from '../core/db/mysql.js'

const serialize = (value: unknown) => JSON.stringify(value)
const deserialize = <T>(value: unknown): T | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return JSON.parse(value) as T
  return JSON.parse(JSON.stringify(value)) as T
}

export type ApiSendStatus = 'pending' | 'sent' | 'failed'

export type ApiSentMessageRecord = {
  id: string
  connectionId: string
  clientMessageId: string | null
  idempotencyKey: string | null
  to: string
  type: string
  requestHash: string
  messageId: string | null
  status: ApiSendStatus
  messageStatus: string | null
  derivedStatus: string
  errorMessage: string | null
  request: unknown
  response: unknown
  createdAt: number
  sentAt: number | null
  failedAt: number | null
  updatedAt: number
  events?: ApiMessageEvent[]
}

export type ApiMessageEvent = {
  eventType: string
  data: unknown
  createdAt: number
}

export type ApiMediaUploadRecord = {
  id: string
  fileName: string | null
  mimeType: string
  fileLength: number
  sha256: string
  localPath: string
  createdAt: number
}

type BeginApiSendInput = {
  connectionId: string
  clientMessageId?: string | null
  idempotencyKey?: string | null
  to: string
  type: string
  requestHash: string
  request: unknown
}

type FinishApiSendInput = {
  id: string
  connectionId: string
  messageId?: string | null
  status: 'sent' | 'failed'
  response?: unknown
  errorMessage?: string | null
}

type ListApiSentMessagesInput = {
  connectionId: string
  to?: string | null
  status?: string | null
  limit?: number
}

type SaveApiMediaUploadInput = {
  fileName?: string | null
  mimeType: string
  data: Buffer
}

type BeginApiSendResult =
  | { status: 'created'; record: ApiSentMessageRecord }
  | { status: 'existing'; record: ApiSentMessageRecord }
  | { status: 'conflict'; reason: string; record?: ApiSentMessageRecord }

type ApiSentMessageRow = RowDataPacket & {
  id: string
  connection_id: string
  client_message_id: string | null
  idempotency_key: string | null
  to_jid: string
  message_type: string
  request_hash: string
  message_id: string | null
  status: ApiSendStatus
  persisted_message_status?: string | null
  error_message: string | null
  request_json: unknown
  response_json: unknown
  created_at: Date | string | number
  sent_at: Date | string | number | null
  failed_at: Date | string | number | null
  updated_at: Date | string | number
}

type ApiMessageEventRow = RowDataPacket & {
  event_type: string
  data_json: unknown
  created_at: Date | string | number
}

type ApiMediaUploadRow = RowDataPacket & {
  id: string
  file_name: string | null
  mime_type: string
  file_length: number
  sha256: string
  local_path: string
  created_at: Date | string | number
}

const sentMessagesMemory = new Map<string, ApiSentMessageRecord>()
const mediaUploadsMemory = new Map<string, ApiMediaUploadRecord>()

const toMs = (value: Date | string | number | null | undefined): number | null => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

const nowIso = () => new Date().toISOString()
const nowMs = () => Date.now()

const normalizeOptionalId = (value: string | null | undefined, max = 128): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

const normalizeSendType = (value: string): string => value.trim().slice(0, 64)

export const hashApiMessageRequest = (rawBody: string): string => createHash('sha256').update(rawBody).digest('hex')

const deriveStatus = (sendStatus: ApiSendStatus, messageStatus: string | null): string => {
  if (sendStatus === 'failed') return 'failed'
  if (sendStatus === 'pending') return 'pending'
  const normalized = (messageStatus ?? '').trim().toLowerCase()
  if (!normalized) return 'sent'
  if (normalized === '4' || normalized.includes('read')) return 'read'
  if (normalized === '5' || normalized.includes('played')) return 'played'
  if (normalized === '3' || normalized.includes('delivery')) return 'delivered'
  if (normalized === '2' || normalized.includes('server')) return 'sent'
  if (normalized === '1' || normalized.includes('pending')) return 'pending'
  if (normalized === '0' || normalized.includes('error')) return 'failed'
  return sendStatus
}

const mapSentRow = (row: ApiSentMessageRow): ApiSentMessageRecord => {
  const messageStatus = row.persisted_message_status ?? null
  return {
    id: row.id,
    connectionId: row.connection_id,
    clientMessageId: row.client_message_id,
    idempotencyKey: row.idempotency_key,
    to: row.to_jid,
    type: row.message_type,
    requestHash: row.request_hash,
    messageId: row.message_id,
    status: row.status,
    messageStatus,
    derivedStatus: deriveStatus(row.status, messageStatus),
    errorMessage: row.error_message,
    request: deserialize(row.request_json),
    response: deserialize(row.response_json),
    createdAt: toMs(row.created_at) ?? 0,
    sentAt: toMs(row.sent_at),
    failedAt: toMs(row.failed_at),
    updatedAt: toMs(row.updated_at) ?? 0,
  }
}

const mapMediaRow = (row: ApiMediaUploadRow): ApiMediaUploadRecord => ({
  id: row.id,
  fileName: row.file_name,
  mimeType: row.mime_type,
  fileLength: Number(row.file_length),
  sha256: row.sha256,
  localPath: row.local_path,
  createdAt: toMs(row.created_at) ?? 0,
})

const mysqlEnabled = () => Boolean(config.mysqlUrl)

const getMemoryByIdempotency = (connectionId: string, clientMessageId: string | null, idempotencyKey: string | null): ApiSentMessageRecord | null => {
  for (const record of sentMessagesMemory.values()) {
    if (record.connectionId !== connectionId) continue
    if (clientMessageId && record.clientMessageId === clientMessageId) return record
    if (idempotencyKey && record.idempotencyKey === idempotencyKey) return record
  }
  return null
}

const compareExisting = (record: ApiSentMessageRecord, requestHash: string): BeginApiSendResult => {
  if (record.requestHash !== requestHash) {
    return { status: 'conflict', reason: 'clientMessageId ou Idempotency-Key já usado com outro payload', record }
  }
  return { status: 'existing', record }
}

const findMysqlExistingSend = async (connectionId: string, clientMessageId: string | null, idempotencyKey: string | null): Promise<ApiSentMessageRecord | null> => {
  const pool = getMysqlPool()
  if (!pool || (!clientMessageId && !idempotencyKey)) return null
  const clauses: string[] = []
  const params: Array<string | number | null> = [connectionId]
  if (clientMessageId) {
    clauses.push('asm.client_message_id = ?')
    params.push(clientMessageId)
  }
  if (idempotencyKey) {
    clauses.push('asm.idempotency_key = ?')
    params.push(idempotencyKey)
  }
  const [rows] = await pool.execute<ApiSentMessageRow[]>(
    `SELECT asm.*, m.status AS persisted_message_status
     FROM api_sent_messages asm
     LEFT JOIN messages m
       ON m.connection_id = asm.connection_id
      AND m.chat_jid = asm.to_jid
      AND m.message_id = asm.message_id
      AND m.from_me = 1
      AND m.deleted_at IS NULL
     WHERE asm.connection_id = ?
       AND (${clauses.join(' OR ')})
     ORDER BY asm.created_at DESC
     LIMIT 1`,
    params
  )
  return rows[0] ? mapSentRow(rows[0]) : null
}

export const beginApiMessageSend = async (input: BeginApiSendInput): Promise<BeginApiSendResult> => {
  const clientMessageId = normalizeOptionalId(input.clientMessageId)
  const idempotencyKey = normalizeOptionalId(input.idempotencyKey, 255)
  const type = normalizeSendType(input.type)

  if (mysqlEnabled()) {
    const pool = getMysqlPool()
    if (pool) {
      await ensureMysqlConnection(pool, input.connectionId)
      const existing = await findMysqlExistingSend(input.connectionId, clientMessageId, idempotencyKey)
      if (existing) return compareExisting(existing, input.requestHash)

      const id = `api_msg_${randomUUID()}`
      try {
        await pool.execute(
          `INSERT INTO api_sent_messages (
             id,
             connection_id,
             client_message_id,
             idempotency_key,
             to_jid,
             message_type,
             request_hash,
             status,
             request_json
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          [id, input.connectionId, clientMessageId, idempotencyKey, input.to, type, input.requestHash, serialize(input.request)]
        )
      } catch (error) {
        const maybeDuplicate = error as { code?: string }
        if (maybeDuplicate.code === 'ER_DUP_ENTRY') {
          const duplicate = await findMysqlExistingSend(input.connectionId, clientMessageId, idempotencyKey)
          if (duplicate) return compareExisting(duplicate, input.requestHash)
        }
        throw error
      }

      const created = await getApiSentMessage(input.connectionId, id)
      if (created) return { status: 'created', record: created }
    }
  }

  const existing = getMemoryByIdempotency(input.connectionId, clientMessageId, idempotencyKey)
  if (existing) return compareExisting(existing, input.requestHash)

  const createdAt = nowMs()
  const record: ApiSentMessageRecord = {
    id: `api_msg_${randomUUID()}`,
    connectionId: input.connectionId,
    clientMessageId,
    idempotencyKey,
    to: input.to,
    type,
    requestHash: input.requestHash,
    messageId: null,
    status: 'pending',
    messageStatus: null,
    derivedStatus: 'pending',
    errorMessage: null,
    request: input.request,
    response: null,
    createdAt,
    sentAt: null,
    failedAt: null,
    updatedAt: createdAt,
  }
  sentMessagesMemory.set(record.id, record)
  return { status: 'created', record }
}

export const finishApiMessageSend = async (input: FinishApiSendInput): Promise<ApiSentMessageRecord | null> => {
  if (mysqlEnabled()) {
    const pool = getMysqlPool()
    if (pool) {
      const isSent = input.status === 'sent'
      await pool.execute(
        `UPDATE api_sent_messages
         SET status = ?,
             message_id = COALESCE(?, message_id),
             response_json = ?,
             error_message = ?,
             sent_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE sent_at END,
             failed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE failed_at END
         WHERE id = ?
           AND connection_id = ?`,
        [input.status, input.messageId ?? null, input.response !== undefined ? serialize(input.response) : null, input.errorMessage ?? null, isSent ? 1 : 0, isSent ? 0 : 1, input.id, input.connectionId]
      )
      return getApiSentMessage(input.connectionId, input.id)
    }
  }

  const existing = sentMessagesMemory.get(input.id)
  if (!existing || existing.connectionId !== input.connectionId) return null
  const updatedAt = nowMs()
  const updated: ApiSentMessageRecord = {
    ...existing,
    status: input.status,
    derivedStatus: deriveStatus(input.status, existing.messageStatus),
    messageId: input.messageId ?? existing.messageId,
    response: input.response ?? null,
    errorMessage: input.errorMessage ?? null,
    sentAt: input.status === 'sent' ? updatedAt : existing.sentAt,
    failedAt: input.status === 'failed' ? updatedAt : existing.failedAt,
    updatedAt,
  }
  sentMessagesMemory.set(updated.id, updated)
  return updated
}

export const getApiSentMessage = async (connectionId: string, messageId: string): Promise<ApiSentMessageRecord | null> => {
  const lookup = normalizeOptionalId(messageId, 255)
  if (!lookup) return null

  if (mysqlEnabled()) {
    const pool = getMysqlPool()
    if (pool) {
      const [rows] = await pool.execute<ApiSentMessageRow[]>(
        `SELECT asm.*, m.status AS persisted_message_status
         FROM api_sent_messages asm
         LEFT JOIN messages m
           ON m.connection_id = asm.connection_id
          AND m.chat_jid = asm.to_jid
          AND m.message_id = asm.message_id
          AND m.from_me = 1
          AND m.deleted_at IS NULL
         WHERE asm.connection_id = ?
           AND (asm.id = ? OR asm.message_id = ? OR asm.client_message_id = ? OR asm.idempotency_key = ?)
         ORDER BY asm.created_at DESC
         LIMIT 1`,
        [connectionId, lookup, lookup, lookup, lookup]
      )
      const record = rows[0] ? mapSentRow(rows[0]) : null
      if (!record) return null
      record.events = await listApiMessageEvents(connectionId, record.to, record.messageId)
      return record
    }
  }

  for (const record of sentMessagesMemory.values()) {
    if (record.connectionId !== connectionId) continue
    if ([record.id, record.messageId, record.clientMessageId, record.idempotencyKey].includes(lookup)) {
      return record
    }
  }
  return null
}

const listApiMessageEvents = async (connectionId: string, to: string, messageId: string | null): Promise<ApiMessageEvent[]> => {
  if (!messageId) return []
  const pool = getMysqlPool()
  if (!pool) return []
  const [rows] = await pool.execute<ApiMessageEventRow[]>(
    `SELECT event_type, data_json, created_at
     FROM message_events
     WHERE connection_id = ?
       AND chat_jid = ?
       AND message_id = ?
     ORDER BY created_at DESC
     LIMIT 20`,
    [connectionId, to, messageId]
  )
  return rows.map((row) => ({
    eventType: row.event_type,
    data: deserialize(row.data_json),
    createdAt: toMs(row.created_at) ?? 0,
  }))
}

export const listApiSentMessages = async (input: ListApiSentMessagesInput): Promise<ApiSentMessageRecord[]> => {
  const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 50)))
  const status = normalizeOptionalId(input.status, 32)
  const to = normalizeOptionalId(input.to, 128)

  if (mysqlEnabled()) {
    const pool = getMysqlPool()
    if (pool) {
      const clauses = ['asm.connection_id = ?']
      const params: Array<string | number | null> = [input.connectionId]
      if (to) {
        clauses.push('asm.to_jid = ?')
        params.push(to)
      }
      if (status && ['pending', 'sent', 'failed'].includes(status)) {
        clauses.push('asm.status = ?')
        params.push(status)
      }
      params.push(status && !['pending', 'sent', 'failed'].includes(status) ? Math.min(500, limit * 3) : limit)
      const [rows] = await pool.execute<ApiSentMessageRow[]>(
        `SELECT asm.*, m.status AS persisted_message_status
         FROM api_sent_messages asm
         LEFT JOIN messages m
           ON m.connection_id = asm.connection_id
          AND m.chat_jid = asm.to_jid
          AND m.message_id = asm.message_id
          AND m.from_me = 1
          AND m.deleted_at IS NULL
         WHERE ${clauses.join(' AND ')}
         ORDER BY asm.created_at DESC
         LIMIT ?`,
        params
      )
      const mapped = rows.map(mapSentRow)
      return status && !['pending', 'sent', 'failed'].includes(status) ? mapped.filter((record) => record.derivedStatus === status).slice(0, limit) : mapped
    }
  }

  let records = Array.from(sentMessagesMemory.values()).filter((record) => record.connectionId === input.connectionId)
  if (to) records = records.filter((record) => record.to === to)
  if (status) records = records.filter((record) => record.status === status || record.derivedStatus === status)
  return records.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

const extensionForMime = (mimeType: string): string => {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('jpeg')) return '.jpg'
  if (normalized.includes('png')) return '.png'
  if (normalized.includes('webp')) return '.webp'
  if (normalized.includes('gif')) return '.gif'
  if (normalized.includes('mp4')) return '.mp4'
  if (normalized.includes('mpeg')) return '.mp3'
  if (normalized.includes('ogg')) return '.ogg'
  if (normalized.includes('pdf')) return '.pdf'
  return '.bin'
}

export const saveApiMediaUpload = async (input: SaveApiMediaUploadInput): Promise<ApiMediaUploadRecord> => {
  const id = `media_${randomUUID()}`
  const originalName = normalizeOptionalId(input.fileName, 255)
  const safeName = originalName ? basename(originalName) : null
  const explicitExt = safeName ? extname(safeName).slice(0, 16) : ''
  const ext = explicitExt || extensionForMime(input.mimeType)
  const dir = config.apiMediaDir
  await mkdir(dir, { recursive: true })
  const localPath = join(dir, `${id}${ext}`)
  await writeFile(localPath, input.data)
  const sha256 = createHash('sha256').update(input.data).digest('hex')
  const createdAt = nowMs()

  if (mysqlEnabled()) {
    const pool = getMysqlPool()
    if (pool) {
      await pool.execute(
        `INSERT INTO api_media_uploads (
           id,
           file_name,
           mime_type,
           file_length,
           sha256,
           local_path,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, safeName, input.mimeType, input.data.byteLength, sha256, localPath, nowIso()]
      )
    }
  }

  const record: ApiMediaUploadRecord = {
    id,
    fileName: safeName,
    mimeType: input.mimeType,
    fileLength: input.data.byteLength,
    sha256,
    localPath,
    createdAt,
  }
  mediaUploadsMemory.set(id, record)
  return record
}

export const getApiMediaUpload = async (mediaId: string): Promise<ApiMediaUploadRecord | null> => {
  const id = normalizeOptionalId(mediaId, 80)
  if (!id) return null

  if (mysqlEnabled()) {
    const pool = getMysqlPool()
    if (pool) {
      const [rows] = await pool.execute<ApiMediaUploadRow[]>(
        `SELECT id, file_name, mime_type, file_length, sha256, local_path, created_at
         FROM api_media_uploads
         WHERE id = ?
         LIMIT 1`,
        [id]
      )
      if (rows[0]) return mapMediaRow(rows[0])
    }
  }

  return mediaUploadsMemory.get(id) ?? null
}
