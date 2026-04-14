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

const isSortMemoryError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: string; errno?: number }
  return candidate.code === 'ER_OUT_OF_SORTMEMORY' || candidate.errno === 1038
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

const isUserJid = (jid: string) =>
  jid.includes('@') &&
  !jid.endsWith('@g.us') &&
  !jid.endsWith('@newsletter') &&
  jid !== 'status@broadcast'

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

  const normalizeUserIdentifier = (entry: { type: UserIdentifierType; value: string }): { type: UserIdentifierType; value: string } | null => {
    switch (entry.type) {
      case 'jid': {
        const jid = normalizeIdentifier(entry.value)
        if (!jid) return null
        if (jid.endsWith('@lid')) {
          return { type: 'lid', value: jid }
        }
        return { type: 'jid', value: jid }
      }
      case 'pn':
      case 'lid': {
        const value = normalizePnLid(entry.value)
        return value ? { type: entry.type, value } : null
      }
      case 'username': {
        const value = normalizeIdentifier(entry.value)
        return value ? { type: 'username', value } : null
      }
      default:
        return null
    }
  }

  const buildUserIdentifierLookupVariants = (entry: { type: UserIdentifierType; value: string }): Array<{ type: UserIdentifierType; value: string }> => {
    if (entry.type === 'lid' && entry.value.endsWith('@lid')) {
      return [entry, { type: 'jid', value: entry.value }]
    }
    return [entry]
  }

  const resolveUserIdentifierEntries = (value: string | null | undefined): Array<{ type: UserIdentifierType; value: string }> => {
    const normalizedJid = normalizeIdentifier(value)
    if (normalizedJid?.includes('@')) {
      const entry = normalizeUserIdentifier({ type: 'jid', value: normalizedJid })
      return entry ? [entry] : []
    }
    const normalizedLid = normalizePnLid(value)
    if (!normalizedLid) return []
    const entry = normalizeUserIdentifier({ type: 'lid', value: normalizedLid })
    return entry ? [entry] : []
  }

  const resolveMessageSenderIdentifierEntries = (message: WAMessage): Array<{ type: UserIdentifierType; value: string }> => {
    const key = message.key
    if (key?.fromMe) {
      return resolveUserIdentifierEntries(selfJid ?? key.participant ?? null)
    }
    if (key?.participant) {
      return resolveUserIdentifierEntries(key.participant)
    }
    const remoteJid = normalizeIdentifier(key?.remoteJid ?? null)
    if (!remoteJid) return []
    if (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid')) {
      return resolveUserIdentifierEntries(remoteJid)
    }
    return []
  }

  const ensureUserByIdentifiers = async (identifiers: Array<{ type: UserIdentifierType; value: string }>, displayName?: string | null) => {
    const clean = identifiers
      .map((entry) => normalizeUserIdentifier(entry))
      .filter((entry): entry is { type: UserIdentifierType; value: string } => Boolean(entry?.value))
    if (!clean.length) return null
    const lookup = clean.flatMap(buildUserIdentifierLookupVariants).filter((entry, index, entries) => entries.findIndex((item) => item.type === entry.type && item.value === entry.value) === index)

    const cachedUserId = lookup.map((entry) => userIdCache.get(cacheKey(entry.type, entry.value))).find((value): value is string => Boolean(value)) ?? null

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
    const whereClauses = lookup.map(() => `(id_type = ? AND id_value = ?)`).join(' OR ')
    const whereParams = lookup.flatMap((entry) => [entry.type, entry.value])
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

  let cachedSelfUserId: string | null | undefined
  const ensureSelfUserId = async (): Promise<string | null> => {
    if (cachedSelfUserId !== undefined) return cachedSelfUserId
    cachedSelfUserId = selfJid ? await ensureUserByIdentifiers([{ type: 'jid', value: selfJid }], null) : null
    return cachedSelfUserId
  }

  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (typeof value !== 'object' || value === null) return null
    return value as Record<string, unknown>
  }

  const getNestedValue = (value: unknown, path: string[]): unknown => {
    let current: unknown = value
    for (const part of path) {
      const record = asRecord(current)
      if (!record || !(part in record)) return null
      current = record[part]
    }
    return current
  }

  const pickNestedString = (value: unknown, paths: string[][]): string | null => {
    for (const path of paths) {
      const candidate = getNestedValue(value, path)
      if (typeof candidate === 'string' && candidate.trim()) return candidate
    }
    return null
  }

  const pickNestedNumber = (value: unknown, paths: string[][]): number | null => {
    for (const path of paths) {
      const candidate = getNestedValue(value, path)
      const number = toNumber(candidate)
      if (number !== null) return number
    }
    return null
  }

  const normalizeUnreadCount = (value: unknown): number | null => {
    const count = toNumber(value)
    if (count === null || !Number.isFinite(count) || count < 0) return null
    return Math.trunc(count)
  }

  const extractChatFallbackDisplayName = (chatData: Record<string, unknown> | null): string | null => {
    if (!chatData) return null
    const direct = pickNestedString(chatData, [
      ['name'],
      ['subject'],
      ['formattedTitle'],
      ['displayName'],
      ['notify'],
      ['pushName'],
    ])
    if (direct) return normalizeDisplayName(direct)
    const messages = Array.isArray(chatData.messages) ? chatData.messages : []
    for (const item of messages) {
      const pushName = pickNestedString(item, [['message', 'pushName']])
      if (pushName) return normalizeDisplayName(pushName)
    }
    return null
  }

  const extractChatFallbackLastMessageTs = (chatData: Record<string, unknown> | null): number | null => {
    if (!chatData) return null
    const direct = pickNestedNumber(chatData, [['conversationTimestamp']])
    if (direct !== null) return direct
    const messages = Array.isArray(chatData.messages) ? chatData.messages : []
    for (const item of messages) {
      const ts = pickNestedNumber(item, [['message', 'messageTimestamp']])
      if (ts !== null) return ts
    }
    return null
  }

  const extractChatFallbackUnreadCount = (chatData: Record<string, unknown> | null): number | null => {
    if (!chatData) return null
    return normalizeUnreadCount(getNestedValue(chatData, ['unreadCount']))
  }

  const resolveMessageDbId = async (chatJid: string | null, messageId: string | null, fromMe?: boolean | null): Promise<number | null> => {
    const normalizedChat = normalizeIdentifier(chatJid)
    const normalizedMessageId = normalizeIdentifier(messageId)
    if (!normalizedChat || !normalizedMessageId) return null
    type MessageIdRow = RowDataPacket & { id: number }
    const params: Array<string | number> = [connectionId, normalizedChat, normalizedMessageId]
    const fromMeClause = typeof fromMe === 'boolean' ? ' AND from_me = ?' : ''
    if (typeof fromMe === 'boolean') {
      params.push(fromMe ? 1 : 0)
    }
    const [rows] = await pool.execute<MessageIdRow[]>(
      `SELECT id
       FROM messages
       WHERE connection_id = ?
         AND chat_jid = ?
         AND message_id = ?${fromMeClause}
       ORDER BY id DESC
       LIMIT 1`,
      params
    )
    return rows[0]?.id ?? null
  }

  const getMessageSenderUserId = async (messageDbId: number | null): Promise<string | null> => {
    if (!messageDbId) return null
    type SenderRow = RowDataPacket & { sender_user_id: string | null }
    const [rows] = await pool.execute<SenderRow[]>(
      `SELECT LOWER(CONCAT(HEX(SUBSTR(sender_user_id, 1, 4)),'-',HEX(SUBSTR(sender_user_id, 5, 2)),'-',HEX(SUBSTR(sender_user_id, 7, 2)),'-',HEX(SUBSTR(sender_user_id, 9, 2)),'-',HEX(SUBSTR(sender_user_id, 11, 6)))) AS sender_user_id
       FROM messages
       WHERE connection_id = ?
         AND id = ?
         AND sender_user_id IS NOT NULL
       LIMIT 1`,
      [connectionId, messageDbId]
    )
    return rows[0]?.sender_user_id ?? null
  }

  const resolveEventActorJid = (record: Record<string, unknown>) =>
    pickNestedString(record, [['actorJid'], ['actor'], ['author'], ['from'], ['sender'], ['receipt', 'userJid'], ['key', 'participant']])

  const dedupeUserIdentifierEntries = (entries: Array<{ type: UserIdentifierType; value: string }>) => {
    const seen = new Set<string>()
    return entries.filter((entry) => {
      const key = `${entry.type}:${entry.value}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  const resolveEventActorIdentifierEntries = (record: Record<string, unknown>) =>
    dedupeUserIdentifierEntries(resolveUserIdentifierEntries(resolveEventActorJid(record)))

  const resolveEventTargetIdentifierEntries = (record: Record<string, unknown>) => {
    const entries: Array<{ type: UserIdentifierType; value: string }> = []
    const paths: string[][] = [
      ['targetJid'],
      ['user'],
      ['participant'],
      ['contactJid'],
      ['receipt', 'userJid'],
      ['reaction', 'participant'],
      ['id'],
      ['pn'],
      ['lid'],
    ]
    for (const path of paths) {
      const candidate = pickNestedString(record, [path])
      if (!candidate) continue
      entries.push(...resolveUserIdentifierEntries(candidate))
    }
    return dedupeUserIdentifierEntries(entries)
  }

  const resolveEventChatJid = (record: Record<string, unknown>) => {
    const candidate = pickNestedString(record, [['chatJid'], ['chatId'], ['jid'], ['id'], ['key', 'remoteJid']])
    return candidate && candidate.includes('@') ? candidate : null
  }

  const resolveEventGroupJid = (record: Record<string, unknown>) => {
    const candidate = pickNestedString(record, [['groupJid'], ['groupId'], ['id'], ['chatId'], ['key', 'remoteJid']])
    return candidate && candidate.endsWith('@g.us') ? candidate : null
  }

  const resolveEventMessageKey = (record: Record<string, unknown>) => {
    const remoteJid = pickNestedString(record, [['key', 'remoteJid'], ['chatJid'], ['chatId'], ['jid']])
    const messageId = pickNestedString(record, [['key', 'id'], ['messageId'], ['stanzaId']])
    if (!remoteJid || !messageId) return null
    const fromMeValue = getNestedValue(record, ['key', 'fromMe'])
    return {
      chatJid: remoteJid,
      messageId,
      fromMe: typeof fromMeValue === 'boolean' ? fromMeValue : null,
    }
  }

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

  const backfillUsersDisplayNames = async () => {
    for (const aliasType of ['display_name', 'notify', 'pushName', 'username'] as const) {
      const [result] = await pool.execute<ResultSetHeader>(
        `UPDATE users u
         INNER JOIN user_aliases ua
           ON ua.connection_id = u.connection_id
          AND ua.user_id = u.id
          AND ua.alias_type = ?
         SET u.display_name = ua.alias_value
         WHERE u.connection_id = ?
           AND (u.display_name IS NULL OR u.display_name = '')`,
        [aliasType, connectionId]
      )
      logAffected(`users.display_name(${aliasType})`, result)
    }
  }

  const backfillContactsDisplayNames = async () => {
    const [fromUsers] = await pool.execute<ResultSetHeader>(
      `UPDATE wa_contacts_cache wc
       INNER JOIN users u
         ON u.connection_id = wc.connection_id
        AND u.id = wc.user_id
       SET wc.display_name = u.display_name
       WHERE wc.connection_id = ?
         AND (wc.display_name IS NULL OR wc.display_name = '')
         AND u.display_name IS NOT NULL
         AND u.display_name <> ''`,
      [connectionId]
    )
    logAffected('wa_contacts_cache.display_name(users)', fromUsers)

    type ContactRow = RowDataPacket & { jid: string; data_json: unknown }
    const [rows] = await pool.execute<ContactRow[]>(
      `SELECT jid, data_json
       FROM wa_contacts_cache
       WHERE connection_id = ?
         AND (display_name IS NULL OR display_name = '')
       LIMIT ${BATCH_SIZE}`,
      [connectionId]
    )

    for (const row of rows) {
      const contactData = deserialize<Record<string, unknown>>(row.data_json)
      const displayName = normalizeDisplayName(
        pickNestedString(contactData, [['name'], ['notify'], ['pushName'], ['verifiedName'], ['fullName']])
      )
      if (!displayName) continue
      await pool.execute(
        `UPDATE wa_contacts_cache
         SET display_name = ?
         WHERE connection_id = ?
           AND jid = ?
           AND (display_name IS NULL OR display_name = '')`,
        [displayName, connectionId, row.jid]
      )
    }
  }

  const backfillChats = async () => {
    const [groupNames] = await pool.execute<ResultSetHeader>(
      `UPDATE chats c
       INNER JOIN \`groups\` g
         ON g.connection_id = c.connection_id
        AND g.jid = c.jid
       SET c.display_name = g.subject
       WHERE c.connection_id = ?
         AND (c.display_name IS NULL OR c.display_name = '')
         AND g.subject IS NOT NULL
         AND g.subject <> ''`,
      [connectionId]
    )
    logAffected('chats.display_name(groups)', groupNames)

    const [newsletterNames] = await pool.execute<ResultSetHeader>(
      `UPDATE chats c
       INNER JOIN newsletters n
         ON n.connection_id = c.connection_id
        AND n.newsletter_id = c.jid
       SET c.display_name = COALESCE(
         JSON_UNQUOTE(JSON_EXTRACT(n.data_json, '$.name.text')),
         JSON_UNQUOTE(JSON_EXTRACT(n.data_json, '$.name'))
       )
       WHERE c.connection_id = ?
         AND (c.display_name IS NULL OR c.display_name = '')
         AND COALESCE(
           JSON_UNQUOTE(JSON_EXTRACT(n.data_json, '$.name.text')),
           JSON_UNQUOTE(JSON_EXTRACT(n.data_json, '$.name'))
         ) IS NOT NULL`,
      [connectionId]
    )
    logAffected('chats.display_name(newsletters)', newsletterNames)

    const [contactNames] = await pool.execute<ResultSetHeader>(
      `UPDATE chats c
       INNER JOIN wa_contacts_cache wc
         ON wc.connection_id = c.connection_id
        AND wc.jid = c.jid
       SET c.display_name = wc.display_name
       WHERE c.connection_id = ?
         AND (c.display_name IS NULL OR c.display_name = '')
         AND wc.display_name IS NOT NULL
         AND wc.display_name <> ''`,
      [connectionId]
    )
    logAffected('chats.display_name(contacts)', contactNames)

    const [messageTs] = await pool.execute<ResultSetHeader>(
      `UPDATE chats c
       INNER JOIN (
         SELECT connection_id, chat_jid, MAX(timestamp) AS last_ts
         FROM messages
         WHERE connection_id = ?
           AND timestamp IS NOT NULL
         GROUP BY connection_id, chat_jid
       ) m
         ON m.connection_id = c.connection_id
        AND m.chat_jid = c.jid
       SET c.last_message_ts = m.last_ts
       WHERE c.connection_id = ?
         AND c.last_message_ts IS NULL`,
      [connectionId, connectionId]
    )
    logAffected('chats.last_message_ts(messages)', messageTs)

    const [unreadCount] = await pool.execute<ResultSetHeader>(
      `UPDATE chats
       SET unread_count = CAST(JSON_UNQUOTE(JSON_EXTRACT(data_json, '$.unreadCount')) AS UNSIGNED)
       WHERE connection_id = ?
         AND unread_count IS NULL
         AND JSON_EXTRACT(data_json, '$.unreadCount') IS NOT NULL`,
      [connectionId]
    )
    logAffected('chats.unread_count(data_json)', unreadCount)

    type ChatRow = RowDataPacket & {
      jid: string
      display_name: string | null
      last_message_ts: number | null
      unread_count: number | null
      data_json: unknown
    }
    const [rows] = await pool.execute<ChatRow[]>(
      `SELECT jid, display_name, last_message_ts, unread_count, data_json
       FROM chats
       WHERE connection_id = ?
         AND (
           display_name IS NULL OR display_name = ''
           OR last_message_ts IS NULL
           OR unread_count IS NULL
         )
       LIMIT ${BATCH_SIZE}`,
      [connectionId]
    )

    for (const row of rows) {
      const chatData = deserialize<Record<string, unknown>>(row.data_json)
      const displayName = row.display_name ?? extractChatFallbackDisplayName(chatData)
      const lastMessageTs = row.last_message_ts ?? extractChatFallbackLastMessageTs(chatData)
      const unread = row.unread_count ?? extractChatFallbackUnreadCount(chatData)
      if (!displayName && lastMessageTs === null && unread === null) continue
      await pool.execute(
        `UPDATE chats
         SET display_name = COALESCE(display_name, ?),
             last_message_ts = COALESCE(last_message_ts, ?),
             unread_count = COALESCE(unread_count, ?)
         WHERE connection_id = ?
           AND jid = ?`,
        [displayName, lastMessageTs, unread, connectionId, row.jid]
      )
    }
  }

  const backfillChatUsersDirect = async () => {
    type ChatRow = RowDataPacket & { jid: string }
    const [chatRows] = await pool.execute<ChatRow[]>(`SELECT jid FROM chats WHERE connection_id = ? AND jid NOT LIKE '%@g.us'`, [connectionId])
    for (const row of chatRows) {
      await setChatUser(row.jid, row.jid, 'member')
    }
  }

  const backfillMessages = async () => {
    type IdRow = RowDataPacket & { id: number }
    let idRows: IdRow[] = []
    try {
      const [rows] = await pool.query<IdRow[]>(
        `SELECT id
         FROM messages
         WHERE connection_id = ?
           AND sender_user_id IS NULL
         ORDER BY id DESC
         LIMIT ${BATCH_SIZE}`,
        [connectionId]
      )
      idRows = rows
    } catch (error) {
      if (!isSortMemoryError(error)) throw error
      const fallbackBatchSize = Math.max(50, Math.min(BATCH_SIZE, 200))
      logger.warn('backfillMessages: sort buffer insuficiente, aplicando fallback sem ORDER BY', {
        connectionId,
        fallbackBatchSize,
      })
      const [rows] = await pool.query<IdRow[]>(
        `SELECT id
         FROM messages
         WHERE connection_id = ?
           AND sender_user_id IS NULL
         LIMIT ${fallbackBatchSize}`,
        [connectionId]
      )
      idRows = rows
    }

    if (!idRows.length) return
    const ids = idRows.map((row) => row.id)

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
    rows.sort((left, right) => right.id - left.id)

    for (const row of rows) {
      const message = deserialize<WAMessage>(row.data_json)
      if (!message?.key) continue
      
      const normalized = getNormalizedMessage(message)
      const messageText = getMessageText(message)
      const timestamp = toNumber(message.messageTimestamp)
      const contentType = normalized.type ? normalizeString(String(normalized.type), { maxLength: MAX_LENGTHS.contentType }) : null
      const messageType =
        message.messageStubType !== undefined && message.messageStubType !== null
          ? normalizeString(String(message.messageStubType), { maxLength: MAX_LENGTHS.messageType })
          : null
      const status = message.status !== undefined && message.status !== null ? normalizeString(String(message.status), { maxLength: MAX_LENGTHS.status }) : null
      const isForwarded = toTinyInt((() => {
        if (!normalized.type || !normalized.content) return null
        const inner = normalized.content[normalized.type]
        if (!inner || typeof inner !== 'object') return null
        const contextInfo = (inner as { contextInfo?: { isForwarded?: boolean; forwardingScore?: number } }).contextInfo
        if (!contextInfo) return null
        if (typeof contextInfo.isForwarded === 'boolean') return contextInfo.isForwarded
        if (typeof contextInfo.forwardingScore === 'number') return contextInfo.forwardingScore > 0
        return null
      })())
      const isEphemeral = toTinyInt(
        Boolean(
          message.message?.ephemeralMessage ||
            message.message?.viewOnceMessage ||
            message.message?.viewOnceMessageV2 ||
            message.message?.viewOnceMessageV2Extension
        )
      )
      const textPreview = normalizeString(messageText, { maxLength: 512, truncate: true, trim: false })

      await pool.execute(
        `UPDATE messages SET 
            timestamp = COALESCE(timestamp, ?),
            content_type = IF(content_type IS NULL OR content_type = '', ?, content_type),
            message_type = IF(message_type IS NULL OR message_type = '', ?, message_type),
            status = IF(status IS NULL OR status = '', ?, status),
            is_forwarded = COALESCE(is_forwarded, ?),
            is_ephemeral = COALESCE(is_ephemeral, ?),
            text_preview = IF(text_preview IS NULL OR text_preview = '', ?, text_preview)
         WHERE connection_id = ? AND id = ?`,
        [timestamp, contentType, messageType, status, isForwarded, isEphemeral, textPreview, connectionId, row.id]
      )

      const senderIdentifierEntries = resolveMessageSenderIdentifierEntries(message)
      if (senderIdentifierEntries.length) {
        const senderUserId = await ensureUserByIdentifiers(senderIdentifierEntries)
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

  const backfillMessageEvents = async () => {
    const [fromMessages] = await pool.execute<ResultSetHeader>(
      `UPDATE message_events me
       INNER JOIN messages m
         ON m.connection_id = me.connection_id
        AND m.chat_jid = me.chat_jid
        AND m.message_id = me.message_id
       SET me.message_db_id = COALESCE(me.message_db_id, m.id),
           me.target_user_id = COALESCE(me.target_user_id, m.sender_user_id)
       WHERE me.connection_id = ?
         AND (me.message_db_id IS NULL OR me.target_user_id IS NULL)`,
      [connectionId]
    )
    logAffected('message_events.refs(messages)', fromMessages)

    type MessageEventRow = RowDataPacket & {
      id: number
      chat_jid: string
      message_id: string
      actor_user_id: Buffer | null
      target_user_id: Buffer | null
      message_db_id: number | null
      data_json: unknown
    }
    const [rows] = await pool.execute<MessageEventRow[]>(
      `SELECT id, chat_jid, message_id, actor_user_id, target_user_id, message_db_id, data_json
       FROM message_events
       WHERE connection_id = ?
         AND (
           actor_user_id IS NULL
           OR target_user_id IS NULL
           OR message_db_id IS NULL
         )
       ORDER BY id DESC
       LIMIT ${BATCH_SIZE}`,
      [connectionId]
    )

    for (const row of rows) {
      const record = deserialize<Record<string, unknown>>(row.data_json)
      const messageKey = record ? resolveEventMessageKey(record) : null
      const messageDbId = row.message_db_id ?? (messageKey ? await resolveMessageDbId(messageKey.chatJid, messageKey.messageId, messageKey.fromMe) : null)
      const senderUserId = await getMessageSenderUserId(messageDbId)
      const actorEntries = record && !row.actor_user_id ? resolveEventActorIdentifierEntries(record) : []
      const targetEntries = record && !row.target_user_id ? resolveEventTargetIdentifierEntries(record) : []
      const actorUserId = actorEntries.length ? await ensureUserByIdentifiers(actorEntries) : null
      const targetUserId =
        targetEntries.length
          ? await ensureUserByIdentifiers(targetEntries)
          : senderUserId
      if (!messageDbId && !actorUserId && !targetUserId) continue
      await pool.execute(
        `UPDATE message_events
         SET message_db_id = COALESCE(message_db_id, ?),
             actor_user_id = COALESCE(actor_user_id, IF(?, UNHEX(REPLACE(?, '-', '')), NULL)),
             target_user_id = COALESCE(target_user_id, IF(?, UNHEX(REPLACE(?, '-', '')), NULL))
         WHERE connection_id = ?
           AND id = ?`,
        [messageDbId, actorUserId ? 1 : 0, actorUserId, targetUserId ? 1 : 0, targetUserId, connectionId, row.id]
      )
    }
  }

  const backfillEventsLog = async () => {
    const [fromMessages] = await pool.execute<ResultSetHeader>(
      `UPDATE events_log e
       INNER JOIN messages m
         ON m.connection_id = e.connection_id
        AND m.id = e.message_db_id
       SET e.target_user_id = COALESCE(e.target_user_id, m.sender_user_id),
           e.chat_jid = COALESCE(e.chat_jid, m.chat_jid),
           e.group_jid = COALESCE(e.group_jid, IF(m.chat_jid LIKE '%@g.us', m.chat_jid, NULL))
       WHERE e.connection_id = ?
         AND (
           e.target_user_id IS NULL
           OR e.chat_jid IS NULL
           OR e.group_jid IS NULL
         )`,
      [connectionId]
    )
    logAffected('events_log.refs(messages)', fromMessages)

    // Two-step fetch for events_log to avoid sort memory issues
    type IdRow = RowDataPacket & { id: number }
    const [idRows] = await pool.execute<IdRow[]>(
      `SELECT id FROM events_log
       WHERE connection_id = ?
         AND (
           actor_user_id IS NULL
           OR target_user_id IS NULL
           OR chat_jid IS NULL
           OR group_jid IS NULL
           OR message_db_id IS NULL
         )
       ORDER BY id DESC LIMIT ${BATCH_SIZE}`,
      [connectionId]
    )

    if (!idRows.length) return
    const ids = idRows.map(r => r.id)

    const [eventRows] = await pool.query<RowDataPacket[]>(
      `SELECT id, actor_user_id, target_user_id, chat_jid, group_jid, message_db_id, data_json FROM events_log WHERE id IN (?)`,
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

      const actorEntries = !row.actor_user_id ? resolveEventActorIdentifierEntries(record) : []
      const targetEntries = !row.target_user_id ? resolveEventTargetIdentifierEntries(record) : []
      const chatJid = !row.chat_jid ? resolveEventChatJid(record) : null
      const groupJid = !row.group_jid ? resolveEventGroupJid(record) : null
      const messageKey = resolveEventMessageKey(record)
      const messageDbId =
        !row.message_db_id && messageKey ? await resolveMessageDbId(messageKey.chatJid, messageKey.messageId, messageKey.fromMe) : null
      const senderUserId = await getMessageSenderUserId((row.message_db_id as number | null) ?? messageDbId)
      const actorUserId = actorEntries.length ? await ensureUserByIdentifiers(actorEntries) : null
      const targetUserId =
        targetEntries.length
          ? await ensureUserByIdentifiers(targetEntries)
          : senderUserId
      if (!actorUserId && !targetUserId && !chatJid && !groupJid && !messageDbId) continue
      await pool.execute(
        `UPDATE events_log
         SET actor_user_id = COALESCE(actor_user_id, IF(?, UNHEX(REPLACE(?, '-', '')), NULL)),
             target_user_id = COALESCE(target_user_id, IF(?, UNHEX(REPLACE(?, '-', '')), NULL)),
             chat_jid = COALESCE(chat_jid, ?),
             group_jid = COALESCE(group_jid, ?),
             message_db_id = COALESCE(message_db_id, ?)
         WHERE connection_id = ?
           AND id = ?`,
        [actorUserId ? 1 : 0, actorUserId, targetUserId ? 1 : 0, targetUserId, chatJid, groupJid ?? (chatJid?.endsWith('@g.us') ? chatJid : null), messageDbId, connectionId, row.id]
      )
    }
  }

  const backfillLabels = async () => {
    const selfUserId = await ensureSelfUserId()
    if (!selfUserId) return
    const [labelsResult] = await pool.execute<ResultSetHeader>(
      `UPDATE labels
       SET actor_user_id = UNHEX(REPLACE(?, '-', ''))
       WHERE connection_id = ?
         AND actor_user_id IS NULL`,
      [selfUserId, connectionId]
    )
    logAffected('labels.actor_user_id', labelsResult)
  }

  const backfillLabelAssociations = async () => {
    const selfUserId = await ensureSelfUserId()
    if (selfUserId) {
      const [actorResult] = await pool.execute<ResultSetHeader>(
        `UPDATE label_associations
         SET actor_user_id = UNHEX(REPLACE(?, '-', ''))
         WHERE connection_id = ?
           AND actor_user_id IS NULL`,
        [selfUserId, connectionId]
      )
      logAffected('label_associations.actor_user_id', actorResult)
    }

    type AssocRow = RowDataPacket & {
      label_id: string
      association_type: 'chat' | 'message' | 'contact' | 'group'
      chat_jid: string | null
      message_db_id: number | null
      target_jid: string | null
      data_json: unknown
    }
    const [rows] = await pool.execute<AssocRow[]>(
      `SELECT label_id, association_type, chat_jid, message_db_id, target_jid, data_json
       FROM label_associations
       WHERE connection_id = ?
         AND (
           message_db_id IS NULL
           OR target_jid IS NULL
         )
       LIMIT ${BATCH_SIZE}`,
      [connectionId]
    )

    for (const row of rows) {
      const record = deserialize<Record<string, unknown>>(row.data_json)
      if (!record) continue
      const chatJid = row.chat_jid ?? pickNestedString(record, [['chatId'], ['chatJid']])
      const messageId = pickNestedString(record, [['messageId'], ['messageKey', 'messageId']])
      const fromMeValue = getNestedValue(record, ['messageKey', 'fromMe'])
      const messageDbId =
        row.message_db_id ?? (chatJid && messageId ? await resolveMessageDbId(chatJid, messageId, typeof fromMeValue === 'boolean' ? fromMeValue : null) : null)
      const targetJid =
        row.target_jid ??
        (row.association_type === 'contact'
          ? pickNestedString(record, [['contactJid'], ['targetJid'], ['chatId']])
          : row.association_type === 'group'
            ? pickNestedString(record, [['groupJid'], ['groupId'], ['chatId']])
            : null)
      if (!messageDbId && !targetJid) continue
      await pool.execute(
        `UPDATE label_associations
         SET message_db_id = COALESCE(message_db_id, ?),
             target_jid = COALESCE(target_jid, ?)
         WHERE connection_id = ?
           AND label_id = ?
           AND association_type = ?
           AND (chat_jid <=> ?)
           AND (target_jid <=> ?)`,
        [messageDbId, targetJid, connectionId, row.label_id, row.association_type, row.chat_jid, row.target_jid]
      )
    }
  }

  const backfillBlocklist = async () => {
    const selfUserId = await ensureSelfUserId()
    if (selfUserId) {
      const [actorResult] = await pool.execute<ResultSetHeader>(
        `UPDATE blocklist
         SET actor_user_id = UNHEX(REPLACE(?, '-', ''))
         WHERE connection_id = ?
           AND actor_user_id IS NULL`,
        [selfUserId, connectionId]
      )
      logAffected('blocklist.actor_user_id', actorResult)
    }
    const [reasonResult] = await pool.execute<ResultSetHeader>(
      `UPDATE blocklist
       SET reason = 'sync:blocklist'
       WHERE connection_id = ?
         AND reason IS NULL`,
      [connectionId]
    )
    logAffected('blocklist.reason', reasonResult)
  }

  const backfillNewsletterEvents = async () => {
    type NewsletterEventRow = RowDataPacket & {
      id: number
      actor_user_id: Buffer | null
      target_user_id: Buffer | null
      data_json: unknown
    }
    const [rows] = await pool.execute<NewsletterEventRow[]>(
      `SELECT id, actor_user_id, target_user_id, data_json
       FROM newsletter_events
       WHERE connection_id = ?
         AND (actor_user_id IS NULL OR target_user_id IS NULL)
       LIMIT ${BATCH_SIZE}`,
      [connectionId]
    )

    for (const row of rows) {
      const record = deserialize<Record<string, unknown>>(row.data_json)
      if (!record) continue
      const actorEntries = !row.actor_user_id ? resolveEventActorIdentifierEntries(record) : []
      const targetEntries = !row.target_user_id ? resolveEventTargetIdentifierEntries(record) : []
      const actorUserId = actorEntries.length ? await ensureUserByIdentifiers(actorEntries) : null
      const targetUserId = targetEntries.length ? await ensureUserByIdentifiers(targetEntries) : null
      if (!actorUserId && !targetUserId) continue
      await pool.execute(
        `UPDATE newsletter_events
         SET actor_user_id = COALESCE(actor_user_id, IF(?, UNHEX(REPLACE(?, '-', '')), NULL)),
             target_user_id = COALESCE(target_user_id, IF(?, UNHEX(REPLACE(?, '-', '')), NULL))
         WHERE connection_id = ?
           AND id = ?`,
        [actorUserId ? 1 : 0, actorUserId, targetUserId ? 1 : 0, targetUserId, connectionId, row.id]
      )
    }
  }

  async function runCycle() {
    try {
      await backfillUsersDisplayNames()
      await backfillContactsDisplayNames()
      await backfillLidMappings()
      await backfillContactsUserId()
      await backfillChats()
      await backfillMessages()
      await backfillMessageEvents()
      await backfillGroupsAndParticipants()
      await backfillChatUsersDirect()
      await backfillLabels()
      await backfillLabelAssociations()
      await backfillBlocklist()
      await backfillNewsletterEvents()
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

  if (process.env.WA_BACKFILL_ONCE === 'true') {
    await runCycle()
    await pool.end()
    return
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
