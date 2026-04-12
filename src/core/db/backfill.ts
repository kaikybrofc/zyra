import { randomUUID } from 'node:crypto'
import { type AuthenticationCreds, BufferJSON, type GroupMetadata, type WAMessage } from '@whiskeysockets/baileys'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { loadEnv } from '../../bootstrap/env.js'
import { config } from '../../config/index.js'
import { createLogger } from '../../observability/logger.js'
import { ensureMysqlConnection } from './connection.js'
import { getMysqlPool } from './mysql.js'
import { getMessageText, getNormalizedMessage } from '../../utils/message.js'

loadEnv()
const logger = createLogger()

type NumberEnvOptions = {
  min?: number
  allowZero?: boolean
  integer?: boolean
}

const MAX_LENGTHS = {
  jid: 128,
  messageId: 128,
  lidPn: 64,
  labelId: 64,
  displayName: 255,
  userIdentifier: 255,
  alias: 255,
  role: 32,
  groupRole: 16,
  eventTypeShort: 64,
  eventTypeLong: 128,
  commandName: 64,
  contentType: 64,
  messageType: 64,
  status: 32,
  color: 16,
}

const readNumberEnv = (key: string, fallback: number, options: NumberEnvOptions = {}) => {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  const min = options.min ?? (options.allowZero ? 0 : 1)
  if (!Number.isFinite(parsed) || parsed < min) {
    logger.warn('env invalida, usando fallback', { key, value: raw, fallback })
    return fallback
  }
  return options.integer === false ? parsed : Math.trunc(parsed)
}

const BATCH_SIZE = readNumberEnv('WA_BACKFILL_BATCH_SIZE', 500)
const WORKER_INTERVAL_MS = readNumberEnv('WA_BACKFILL_INTERVAL_MS', 30000, { min: 5000 })

const logAffected = (label: string, result: ResultSetHeader) => {
  if (result.affectedRows) {
    logger.info('backfill atualizado', { item: label, affected: result.affectedRows })
  }
}

const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)
const deserialize = <T>(value: unknown) => {
  if (value === null || value === undefined) return null as T
  if (typeof value === 'string') {
    return JSON.parse(value, BufferJSON.reviver) as T
  }
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T
}

const normalizeString = (value: unknown, options: { maxLength?: number; allowEmpty?: boolean; trim?: boolean; truncate?: boolean } = {}): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = options.trim === false ? value : value.trim()
  if (!trimmed && !options.allowEmpty) return null
  if (options.maxLength && trimmed.length > options.maxLength) {
    if (options.truncate) return trimmed.slice(0, options.maxLength)
    return null
  }
  return trimmed
}

const normalizePnLid = (value: unknown): string | null => normalizeString(value, { maxLength: MAX_LENGTHS.lidPn })

const normalizeDisplayName = (value: unknown): string | null => normalizeString(value, { maxLength: MAX_LENGTHS.displayName, truncate: true })

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (value && typeof value === 'object') {
    const maybeNumber = value as { toNumber?: () => number }
    if (typeof maybeNumber.toNumber === 'function') {
      return maybeNumber.toNumber()
    }
  }
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const toTinyInt = (value: boolean | null | undefined): number | null => {
  if (value === null || value === undefined) return null
  return value ? 1 : 0
}

const normalizeIdentifier = (value: string | null | undefined): string | null => normalizeString(value, { maxLength: MAX_LENGTHS.userIdentifier, truncate: true })

const pickString = (obj: Record<string, unknown> | null, keys: string[]) => {
  if (!obj) return null
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

const pickFrom = (obj: Record<string, unknown> | null, keys: string[]) => {
  const direct = pickString(obj, keys)
  if (direct) return direct
  const nested = obj?.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : null
  return pickString(nested, keys)
}

const isUserJid = (jid: string) => jid.includes('@') && !jid.endsWith('@g.us')

const userIdCache = new Map<string, string>()
const cacheKey = (type: string, value: string) => `${type}:${value}`
const cacheUserId = (userId: string, identifiers: Array<{ type: string; value: string }>) => {
  if (userIdCache.size > 10000) userIdCache.clear() // Prevent memory leak
  for (const ident of identifiers) {
    userIdCache.set(cacheKey(ident.type, ident.value), userId)
  }
}

async function main() {
  if (!config.mysqlUrl) {
    logger.error('MYSQL_URL nao configurada')
    process.exitCode = 1
    return
  }

  const pool = getMysqlPool()
  if (!pool) {
    logger.error('Pool MySQL nao iniciado')
    process.exitCode = 1
    return
  }

  await ensureMysqlConnection(pool)

  const connectionId = config.connectionId ?? 'default'
  logger.info('iniciando backfill worker', { connectionId, interval: WORKER_INTERVAL_MS })

  const resolveSelfJid = async (): Promise<string | null> => {
    type CredsRow = RowDataPacket & { creds_json: unknown }
    const [rows] = await pool.execute<CredsRow[]>(
      `SELECT creds_json
       FROM auth_creds
       WHERE connection_id = ?
       LIMIT 1`,
      [connectionId]
    )
    const creds = rows[0]?.creds_json ? deserialize<AuthenticationCreds>(rows[0].creds_json) : null
    const jid = normalizeIdentifier((creds as { me?: { id?: string | null } } | null)?.me?.id ?? null)
    return jid
  }

  const selfJid = await resolveSelfJid()

  type UserIdentifierType = 'jid' | 'pn' | 'lid' | 'username'

  const ensureUserByIdentifiers = async (identifiers: Array<{ type: UserIdentifierType; value: string }>, displayName?: string | null) => {
    const clean = identifiers
      .map((entry) => {
        const normalized = entry.type === 'pn' || entry.type === 'lid' ? normalizePnLid(entry.value) : normalizeIdentifier(entry.value)
        return { type: entry.type, value: normalized }
      })
      .filter((entry): entry is { type: UserIdentifierType; value: string } => Boolean(entry.value))
    if (!clean.length) return null

    const cachedUserId = clean.map((entry) => userIdCache.get(cacheKey(entry.type, entry.value))).find((value): value is string => Boolean(value)) ?? null

    if (cachedUserId) {
      if (displayName) {
        await pool.execute(
          `UPDATE users
           SET display_name = ?
           WHERE connection_id = ?
             AND id = UNHEX(REPLACE(?, '-', ''))
             AND (display_name IS NULL OR display_name = '')`,
          [displayName, connectionId, cachedUserId]
        )
      }
      return cachedUserId
    }

    type UserRow = RowDataPacket & { user_id: string; id_type: string; id_value: string }
    const whereClauses = clean.map(() => `(id_type = ? AND id_value = ?)`).join(' OR ')
    const whereParams = clean.flatMap((entry) => [entry.type, entry.value])
    const [rows] = await pool.execute<UserRow[]>(
      `SELECT LOWER(CONCAT(HEX(SUBSTR(user_id, 1, 4)),'-',HEX(SUBSTR(user_id, 5, 2)),'-',HEX(SUBSTR(user_id, 7, 2)),'-',HEX(SUBSTR(user_id, 9, 2)),'-',HEX(SUBSTR(user_id, 11, 6)))) AS user_id, id_type, id_value
       FROM user_identifiers
       WHERE connection_id = ?
         AND (${whereClauses})`,
      [connectionId, ...whereParams]
    )
    const existing = rows[0]?.user_id
    if (existing) {
      if (displayName) {
        await pool.execute(
          `UPDATE users
           SET display_name = ?
           WHERE connection_id = ?
             AND id = UNHEX(REPLACE(?, '-', ''))
             AND (display_name IS NULL OR display_name = '')`,
          [displayName, connectionId, existing]
        )
      }
      cacheUserId(
        existing,
        rows.map((row) => ({ type: row.id_type, value: row.id_value }))
      )
      cacheUserId(existing, clean)
      return existing
    }

    const userId = randomUUID()
    await pool.execute(
      `INSERT INTO users (id, connection_id, display_name)
       VALUES (UNHEX(REPLACE(?, '-', '')), ?, ?)`,
      [userId, connectionId, displayName ?? null]
    )
    for (const ident of clean) {
      await pool.execute(
        `INSERT INTO user_identifiers (connection_id, user_id, id_type, id_value)
         VALUES (?, UNHEX(REPLACE(?, '-', '')), ?, ?)
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
        [connectionId, userId, ident.type, ident.value]
      )
    }
    cacheUserId(userId, clean)
    return userId
  }

  const ensureUserByJid = async (jid: string, displayName?: string | null) => ensureUserByIdentifiers([{ type: 'jid', value: jid }], displayName)

  const setChatUser = async (chatJid: string, userJid: string, role?: string | null) => {
    const normalizedChat = normalizeIdentifier(chatJid)
    const normalizedUser = normalizeIdentifier(userJid)
    if (!normalizedChat || !normalizedUser) return
    const userId = await ensureUserByJid(normalizedUser)
    if (!userId) return
    const resolvedRole = role ?? 'member'
    await pool.execute(
      `INSERT INTO chat_users (
         connection_id,
         chat_jid,
         user_id,
         role
       )
       VALUES (?, ?, UNHEX(REPLACE(?, '-', '')), ?)
       ON DUPLICATE KEY UPDATE
         role = VALUES(role)`,
      [connectionId, normalizedChat, userId, resolvedRole]
    )
  }

  const backfillGroupsAndParticipants = async () => {
    type GroupRow = RowDataPacket & { jid: string; data_json: unknown }
    const [groupRows] = await pool.execute<GroupRow[]>(`SELECT jid, data_json FROM \`groups\` WHERE connection_id = ?`, [connectionId])
    for (const row of groupRows) {
      const group = deserialize<GroupMetadata>(row.data_json)
      if (!group) continue
      const ownerCandidates: Array<{ type: UserIdentifierType; value: string }> = []
      const pushOwnerCandidate = (type: UserIdentifierType, value: string | null | undefined) => {
        const normalized = type === 'jid' ? normalizeIdentifier(value ?? null) : normalizePnLid(value ?? null)
        if (normalized) ownerCandidates.push({ type, value: normalized })
      }
      pushOwnerCandidate('jid', group.owner)
      const ownerMeta = group as {
        ownerPn?: string | null
        subjectOwner?: string | null
        subjectOwnerPn?: string | null
        descOwner?: string | null
        descOwnerPn?: string | null
        author?: string | null
        authorPn?: string | null
      }
      pushOwnerCandidate('pn', ownerMeta.ownerPn)
      pushOwnerCandidate('jid', ownerMeta.subjectOwner)
      pushOwnerCandidate('pn', ownerMeta.subjectOwnerPn)
      pushOwnerCandidate('jid', ownerMeta.descOwner)
      pushOwnerCandidate('pn', ownerMeta.descOwnerPn)
      pushOwnerCandidate('jid', ownerMeta.author)
      pushOwnerCandidate('pn', ownerMeta.authorPn)

      const subject = normalizeDisplayName(group.subject ?? null)
      const announce = toTinyInt(group.announce ?? null)
      const restrict = toTinyInt(group.restrict ?? null)
      const size = typeof group.size === 'number' && Number.isFinite(group.size) ? group.size : null

      let ownerUserId: string | null = null
      if (ownerCandidates.length) {
        ownerUserId = await ensureUserByIdentifiers(ownerCandidates, null)
      }

      if (ownerUserId || subject !== null || announce !== null || restrict !== null || size !== null) {
        await pool.execute(
          `UPDATE \`groups\`
           SET owner_user_id = COALESCE(owner_user_id, IF(?, UNHEX(REPLACE(?, '-', '')), NULL)),
               subject = IF(subject IS NULL OR subject = '', ?, subject),
               announce = COALESCE(announce, ?),
               \`restrict\` = COALESCE(\`restrict\`, ?),
               size = COALESCE(size, ?)
           WHERE connection_id = ?
             AND jid = ?`,
          [ownerUserId ? 1 : 0, ownerUserId, subject, announce, restrict, size, connectionId, row.jid]
        )
      }
      if (group?.participants?.length) {
        for (const participant of group.participants) {
          const jid = normalizeIdentifier(participant.id)
          if (!jid) continue
          const userId = await ensureUserByJid(jid)
          if (!userId) continue
          const role = participant.admin ?? 'member'
          const isSuper = role === 'superadmin'
          const isAdmin = role === 'admin' || isSuper
          await pool.execute(
            `INSERT INTO group_participants (
               connection_id,
               group_jid,
               user_id,
               participant_jid,
               role,
               is_admin,
               is_superadmin,
               data_json
             )
             VALUES (?, ?, UNHEX(REPLACE(?, '-', '')), ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               participant_jid = VALUES(participant_jid),
               role = VALUES(role),
               is_admin = VALUES(is_admin),
               is_superadmin = VALUES(is_superadmin),
               data_json = VALUES(data_json)`,
            [connectionId, row.jid, userId, jid, role, isAdmin ? 1 : 0, isSuper ? 1 : 0, serialize(participant)]
          )
          await setChatUser(row.jid, jid, role)
        }
      }
    }
  }

  const backfillContactsUserId = async () => {
    const [contactsResult] = await pool.execute<ResultSetHeader>(
      `UPDATE wa_contacts_cache wc
       INNER JOIN user_identifiers ui
         ON ui.connection_id = wc.connection_id
        AND ui.id_type = 'jid'
        AND ui.id_value = wc.jid
       SET wc.user_id = ui.user_id
       WHERE wc.connection_id = ?
         AND wc.user_id IS NULL`,
      [connectionId]
    )
    logAffected('wa_contacts_cache.user_id', contactsResult)
  }

  const backfillLidMappings = async () => {
    const [lidPnResult] = await pool.execute<ResultSetHeader>(
      `UPDATE lid_mappings lm
       INNER JOIN user_identifiers ui
         ON ui.connection_id = lm.connection_id
        AND ui.id_type = 'pn'
        AND ui.id_value = lm.pn
       SET lm.user_id = ui.user_id
       WHERE lm.connection_id = ?
         AND lm.user_id IS NULL`,
      [connectionId]
    )
    logAffected('lid_mappings.user_id(pn)', lidPnResult)

    const [lidResult] = await pool.execute<ResultSetHeader>(
      `UPDATE lid_mappings lm
       INNER JOIN user_identifiers ui
         ON ui.connection_id = lm.connection_id
        AND ui.id_type = 'lid'
        AND ui.id_value = lm.lid
       SET lm.user_id = ui.user_id
       WHERE lm.connection_id = ?
         AND lm.user_id IS NULL`,
      [connectionId]
    )
    logAffected('lid_mappings.user_id(lid)', lidResult)
  }

  const backfillChatUsersDirect = async () => {
    type ChatRow = RowDataPacket & { jid: string }
    const [chatRows] = await pool.execute<ChatRow[]>(`SELECT jid FROM chats WHERE connection_id = ? AND jid NOT LIKE '%@g.us'`, [connectionId])
    for (const row of chatRows) {
      await setChatUser(row.jid, row.jid, 'member')
    }
  }

  const backfillMessages = async () => {
    // Priority 1: Recent messages with NULL sender_user_id (Gap Scan)
    type IdRow = RowDataPacket & { id: number }
    
    // Step 1: Fetch only IDs (Very light on memory/sort buffer)
    const [idRows] = await pool.query<IdRow[]>(
      `SELECT id FROM messages
       WHERE connection_id = ? AND sender_user_id IS NULL
       ORDER BY id DESC LIMIT ${BATCH_SIZE}`,
      [connectionId]
    )
    
    if (!idRows.length) return

    const ids = idRows.map(r => r.id)

    // Step 2: Fetch full data only for those IDs
    type MessageRow = RowDataPacket & {
      id: number
      chat_jid: string
      message_id: string
      from_me: number
      data_json: unknown
    }
    
    const [rows] = await pool.query<MessageRow[]>(
      `SELECT id, chat_jid, message_id, from_me, data_json
       FROM messages
       WHERE id IN (?)`,
      [ids]
    )

    for (const row of rows) {
      const message = deserialize<WAMessage>(row.data_json)
      if (!message?.key) continue
      
      const normalized = getNormalizedMessage(message)
      const messageText = getMessageText(message)
      const timestamp = toNumber(message.messageTimestamp)
      const contentType = normalized.type ? normalizeString(String(normalized.type), { maxLength: MAX_LENGTHS.contentType }) : null
      const textPreview = normalizeString(messageText, { maxLength: 512, truncate: true, trim: false })

      await pool.execute(
        `UPDATE messages SET 
            timestamp = COALESCE(timestamp, ?),
            content_type = IF(content_type IS NULL OR content_type = '', ?, content_type),
            text_preview = IF(text_preview IS NULL OR text_preview = '', ?, text_preview)
         WHERE connection_id = ? AND id = ?`,
        [timestamp, contentType, textPreview, connectionId, row.id]
      )

      const senderJid = message.key.fromMe ? (selfJid ?? message.key.participant ?? null) : (message.key.participant ?? message.key.remoteJid ?? null)
      if (senderJid) {
        const senderUserId = await ensureUserByJid(senderJid)
        if (senderUserId) {
          await pool.execute(
            `UPDATE messages SET sender_user_id = UNHEX(REPLACE(?, '-', ''))
             WHERE connection_id = ? AND id = ? AND sender_user_id IS NULL`,
            [senderUserId, connectionId, row.id]
          )
        }
      }
    }
  }

  const backfillEventsLog = async () => {
    // Two-step fetch for events_log to avoid sort memory issues
    type IdRow = RowDataPacket & { id: number }
    const [idRows] = await pool.execute<IdRow[]>(
      `SELECT id FROM events_log
       WHERE connection_id = ? AND (actor_user_id IS NULL OR target_user_id IS NULL)
       ORDER BY id DESC LIMIT ${BATCH_SIZE}`,
      [connectionId]
    )

    if (!idRows.length) return
    const ids = idRows.map(r => r.id)

    const [eventRows] = await pool.query<RowDataPacket[]>(
      `SELECT id, actor_user_id, target_user_id, data_json FROM events_log WHERE id IN (?)`,
      [ids]
    )
    
    for (const row of eventRows) {
      let record: Record<string, unknown> | null = null
      try { record = deserialize<Record<string, unknown>>(row.data_json) } catch { continue }
      if (!record) continue

      if (!row.actor_user_id) {
        const actorJid = pickFrom(record, ['actorJid', 'actor', 'author', 'from', 'sender'])
        if (actorJid && isUserJid(actorJid)) {
          const actorUserId = await ensureUserByJid(actorJid)
          if (actorUserId) {
            await pool.execute(
              `UPDATE events_log SET actor_user_id = UNHEX(REPLACE(?, '-', ''))
               WHERE connection_id = ? AND id = ? AND actor_user_id IS NULL`,
              [actorUserId, connectionId, row.id]
            )
          }
        }
      }
    }
  }

  async function runCycle() {
    try {
      await backfillLidMappings()
      await backfillContactsUserId()
      await backfillMessages()
      await backfillGroupsAndParticipants()
      await backfillChatUsersDirect()
      await backfillEventsLog()
      
      // Bulk Updates
      const [msgUpdate] = await pool!.execute<ResultSetHeader>(
        `UPDATE messages m 
         INNER JOIN user_identifiers ui ON ui.id_value = m.chat_jid AND ui.connection_id = m.connection_id
         SET m.sender_user_id = ui.user_id
         WHERE m.connection_id = ? AND m.sender_user_id IS NULL AND m.from_me = 0 AND ui.id_type = 'jid'`,
        [connectionId]
      )
      if (msgUpdate.affectedRows) logger.info('batch: sender_user_id atualizado', { affected: msgUpdate.affectedRows })

    } catch (error) {
      logger.error('erro no ciclo de backfill', { err: error })
    }
  }

  // Worker Loop
  while (true) {
    const start = Date.now()
    await runCycle()
    const duration = Date.now() - start
    const wait = Math.max(1000, WORKER_INTERVAL_MS - duration)
    await new Promise(resolve => setTimeout(resolve, wait))
  }
}

main().catch((error) => {
  logger.error('falha fatal no backfill', { err: error })
  process.exitCode = 1
})

