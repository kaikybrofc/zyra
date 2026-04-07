import { randomUUID } from 'node:crypto'
import { type AuthenticationCreds, BufferJSON, type Chat, type Contact, type GroupMetadata, type WAMessage, type proto } from '@whiskeysockets/baileys'
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

const LOG_SAMPLE_LIMIT = readNumberEnv('WA_BACKFILL_LOG_SAMPLE', 20, { min: 0, allowZero: true })
const BATCH_SIZE = readNumberEnv('WA_BACKFILL_BATCH_SIZE', 500)
const GROUP_LOG_EVERY = readNumberEnv('WA_BACKFILL_GROUP_LOG_EVERY', 25, {
  min: 0,
  allowZero: true,
})
const PARTICIPANT_LOG_EVERY = readNumberEnv('WA_BACKFILL_PARTICIPANT_LOG_EVERY', 200, {
  min: 0,
  allowZero: true,
})
const MESSAGE_LOG_EVERY = readNumberEnv('WA_BACKFILL_MESSAGE_LOG_EVERY', 1000, {
  min: 0,
  allowZero: true,
})

const logAffected = (label: string, result: ResultSetHeader) => {
  if (result.affectedRows) {
    logger.info('backfill atualizado', { item: label, affected: result.affectedRows })
  }
}

const shouldLogProgress = (every: number, count: number) => Number.isFinite(every) && every > 0 && count % every === 0

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

const normalizeJid = (value: unknown): string | null => {
  const jid = normalizeString(value, { maxLength: MAX_LENGTHS.jid })
  if (!jid || !jid.includes('@')) return null
  return jid
}

const normalizeMessageId = (value: unknown): string | null => normalizeString(value, { maxLength: MAX_LENGTHS.messageId })

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

const extractForwardedFlag = (content: proto.IMessage | undefined, type: keyof proto.IMessage | null): boolean | null => {
  if (!content || !type) return null
  const inner = content[type]
  if (!inner || typeof inner !== 'object') return null
  const contextInfo = (inner as { contextInfo?: { isForwarded?: boolean; forwardingScore?: number } }).contextInfo
  if (!contextInfo) return null
  if (typeof contextInfo.isForwarded === 'boolean') return contextInfo.isForwarded
  if (typeof contextInfo.forwardingScore === 'number') {
    return contextInfo.forwardingScore > 0
  }
  return null
}

const extractEphemeralFlag = (message: WAMessage): boolean | null => {
  const content = message.message
  if (!content) return null
  return Boolean(content.ephemeralMessage || content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension)
}

const toBase64 = (value: unknown): string | null => {
  if (!value) return null
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return value.toString('base64')
  }
  return null
}

const extractMediaInfo = (
  content: proto.IMessage | undefined,
  type: keyof proto.IMessage | null
): {
  mediaType: string
  mimeType: string | null
  fileSha256: string | null
  fileLength: number | null
  fileName: string | null
  url: string | null
  data: unknown
} | null => {
  if (!content || !type) return null
  const mediaTypes = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage'])
  if (!mediaTypes.has(type)) return null
  const inner = (content as proto.IMessage)[type] as
    | {
        mimetype?: string | null
        fileSha256?: Uint8Array | null
        fileLength?: number | null
        fileName?: string | null
        url?: string | null
        directPath?: string | null
      }
    | null
    | undefined
  if (!inner) return null
  return {
    mediaType: String(type),
    mimeType: inner.mimetype ?? null,
    fileSha256: toBase64(inner.fileSha256),
    fileLength: typeof inner.fileLength === 'number' ? inner.fileLength : null,
    fileName: inner.fileName ?? null,
    url: inner.url ?? inner.directPath ?? null,
    data: inner,
  }
}

const getContextInfo = (content: proto.IMessage | undefined, type: keyof proto.IMessage | null): proto.IContextInfo | null => {
  if (!content || !type) return null
  const inner = (content as proto.IMessage)[type] as { contextInfo?: proto.IContextInfo } | null
  return inner?.contextInfo ?? null
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

const isGroupJid = (jid: string) => jid.endsWith('@g.us')
const isUserJid = (jid: string) => jid.includes('@') && !jid.endsWith('@g.us')

const userIdCache = new Map<string, string>()
const cacheKey = (type: string, value: string) => `${type}:${value}`
const cacheUserId = (userId: string, identifiers: Array<{ type: string; value: string }>) => {
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
  logger.info('iniciando backfill', { connectionId })

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
    if (!jid) {
      logger.warn('nao foi possivel resolver o JID da conta para backfill')
    }
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
             AND id = UNHEX(REPLACE(?, '-', ''))`,
          [displayName, connectionId, cachedUserId]
        )
      }
      for (const ident of clean) {
        await pool.execute(
          `INSERT INTO user_identifiers (connection_id, user_id, id_type, id_value)
           VALUES (?, UNHEX(REPLACE(?, '-', '')), ?, ?)
           ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
          [connectionId, cachedUserId, ident.type, ident.value]
        )
      }
      cacheUserId(cachedUserId, clean)
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
             AND id = UNHEX(REPLACE(?, '-', ''))`,
          [displayName, connectionId, existing]
        )
      }
      for (const ident of clean) {
        await pool.execute(
          `INSERT INTO user_identifiers (connection_id, user_id, id_type, id_value)
           VALUES (?, UNHEX(REPLACE(?, '-', '')), ?, ?)
           ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
          [connectionId, existing, ident.type, ident.value]
        )
      }
      if (rows.length) {
        cacheUserId(
          existing,
          rows.map((row) => ({ type: row.id_type, value: row.id_value }))
        )
      }
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

  const ensureUserByPn = async (pn: string, displayName?: string | null) => ensureUserByIdentifiers([{ type: 'pn', value: pn }], displayName)

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

  const setUserAlias = async (jid: string, type: 'pushName' | 'notify' | 'username' | 'display_name', value: string) => {
    const normalized = normalizeString(value, { maxLength: MAX_LENGTHS.alias, truncate: true })
    if (!normalized) return
    const userId = await ensureUserByJid(jid)
    if (!userId) return
    await pool.execute(
      `INSERT INTO user_aliases (connection_id, user_id, alias_type, alias_value)
       VALUES (?, UNHEX(REPLACE(?, '-', '')), ?, ?)
       ON DUPLICATE KEY UPDATE last_seen = CURRENT_TIMESTAMP`,
      [connectionId, userId, type, normalized]
    )
  }

  const backfillGroupsAndParticipants = async () => {
    // Backfill groups owner_user_id
    // Backfill groups and participants
    type GroupRow = RowDataPacket & { jid: string; data_json: unknown }
    const [groupRows] = await pool.execute<GroupRow[]>(`SELECT jid, data_json FROM \`groups\` WHERE connection_id = ?`, [connectionId])
    let groupIndex = 0
    let participantsProcessed = 0
    for (const row of groupRows) {
      groupIndex += 1
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
        const [result] = await pool.execute<ResultSetHeader>(
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
        if (ownerUserId && result.affectedRows) {
          logger.info('backfill groups.owner_user_id atualizado', { groupJid: row.jid })
        }
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
          participantsProcessed += 1
          if (shouldLogProgress(PARTICIPANT_LOG_EVERY, participantsProcessed)) {
            logger.info('backfill participantes progresso', {
              processed: participantsProcessed,
              totalGroups: groupRows.length,
            })
          }
        }
      }
      if (shouldLogProgress(GROUP_LOG_EVERY, groupIndex)) {
        logger.info('backfill grupos progresso', { processed: groupIndex, total: groupRows.length })
      }
    }

    logger.info('backfill groups.owner_user_id concluido', { total: groupRows.length })
  }

  const backfillContactsUserId = async () => {
    // Backfill wa_contacts_cache.user_id
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

    type LidRow = RowDataPacket & { pn: string; lid: string }
    const [lidRows] = await pool.execute<LidRow[]>(
      `SELECT pn, lid
       FROM lid_mappings
       WHERE connection_id = ?
         AND user_id IS NULL`,
      [connectionId]
    )
    for (const row of lidRows) {
      const pn = normalizePnLid(row.pn)
      const lid = normalizePnLid(row.lid)
      const identifiers: Array<{ type: UserIdentifierType; value: string }> = []
      if (pn) identifiers.push({ type: 'pn', value: pn })
      if (lid) identifiers.push({ type: 'lid', value: lid })
      if (!identifiers.length) continue
      const userId = await ensureUserByIdentifiers(identifiers, null)
      if (!userId) continue
      await pool.execute(
        `UPDATE lid_mappings
         SET user_id = UNHEX(REPLACE(?, '-', ''))
         WHERE connection_id = ?
           AND pn = ?
           AND user_id IS NULL`,
        [userId, connectionId, row.pn]
      )
    }
  }

  const backfillChatUsersDirect = async () => {
    // Backfill chat_users for direct chats
    type ChatRow = RowDataPacket & { jid: string; data_json: unknown }
    const [chatRows] = await pool.execute<ChatRow[]>(`SELECT jid, data_json FROM chats WHERE connection_id = ?`, [connectionId])
    for (const row of chatRows) {
      if (!row.jid.endsWith('@g.us')) {
        await setChatUser(row.jid, row.jid, 'member')
      }
    }
  }

  const backfillChatsFromJson = async () => {
    type ChatRow = RowDataPacket & { jid: string; data_json: unknown }
    const [chatRows] = await pool.execute<ChatRow[]>(`SELECT jid, data_json FROM chats WHERE connection_id = ?`, [connectionId])
    for (const row of chatRows) {
      const chat = deserialize<Chat>(row.data_json)
      if (!chat) continue
      const displayName = normalizeDisplayName(chat.name ?? (chat as { subject?: string | null }).subject ?? null)
      const lastMessageTs = toNumber((chat as { conversationTimestamp?: unknown }).conversationTimestamp)
      const rawUnreadCount = (chat as { unreadCount?: number }).unreadCount
      const unreadCount = typeof rawUnreadCount === 'number' && Number.isFinite(rawUnreadCount) && rawUnreadCount >= 0 ? rawUnreadCount : null
      if (displayName || lastMessageTs !== null || unreadCount !== null) {
        await pool.execute(
          `UPDATE chats
           SET display_name = IF(display_name IS NULL OR display_name = '', ?, display_name),
               last_message_ts = COALESCE(last_message_ts, ?),
               unread_count = COALESCE(unread_count, ?)
           WHERE connection_id = ?
             AND jid = ?`,
          [displayName, lastMessageTs, unreadCount, connectionId, row.jid]
        )
      }
    }
  }

  const backfillContactAliases = async () => {
    // Backfill contacts aliases
    type ContactRow = RowDataPacket & { jid: string; data_json: unknown }
    const [contactRows] = await pool.execute<ContactRow[]>(`SELECT jid, data_json FROM wa_contacts_cache WHERE connection_id = ?`, [connectionId])
    for (const row of contactRows) {
      const contact = deserialize<Contact>(row.data_json)
      if (!contact) continue
      const contactUserId = await ensureUserByJid(row.jid)
      if (contactUserId) {
        await pool.execute(
          `UPDATE wa_contacts_cache
           SET user_id = IF(user_id IS NULL, UNHEX(REPLACE(?, '-', '')), user_id)
           WHERE connection_id = ?
             AND jid = ?`,
          [contactUserId, connectionId, row.jid]
        )
      }
      const displayName = normalizeDisplayName(contact.name ?? contact.notify ?? null)
      if (displayName) {
        await pool.execute(
          `UPDATE wa_contacts_cache
           SET display_name = IF(display_name IS NULL OR display_name = '', ?, display_name)
           WHERE connection_id = ?
             AND jid = ?`,
          [displayName, connectionId, row.jid]
        )
      }
      if (contact.notify) await setUserAlias(row.jid, 'notify', contact.notify)
      if (contact.name) await setUserAlias(row.jid, 'display_name', contact.name)
      const pushName = (contact as { pushName?: string }).pushName
      if (pushName) await setUserAlias(row.jid, 'pushName', pushName)
    }
  }

  const backfillChatsDisplayName = async () => {
    // Backfill chats.display_name from groups/contacts/aliases
    const [chatGroupResult] = await pool.execute<ResultSetHeader>(
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
    logAffected('chats.display_name(groups)', chatGroupResult)

    const [chatContactResult] = await pool.execute<ResultSetHeader>(
      `UPDATE chats c
       INNER JOIN wa_contacts_cache w
         ON w.connection_id = c.connection_id
       AND w.jid = c.jid
       SET c.display_name = w.display_name
       WHERE c.connection_id = ?
         AND (c.display_name IS NULL OR c.display_name = '')
         AND c.jid NOT LIKE '%@g.us'
         AND w.display_name IS NOT NULL
         AND w.display_name <> ''`,
      [connectionId]
    )
    logAffected('chats.display_name(contacts)', chatContactResult)

    const [chatAliasResult] = await pool.execute<ResultSetHeader>(
      `UPDATE chats c
       INNER JOIN user_identifiers ui
         ON ui.connection_id = c.connection_id
        AND ui.id_type = 'jid'
        AND ui.id_value = c.jid
       INNER JOIN (
         SELECT ua.user_id, ua.alias_value, ua.last_seen
         FROM user_aliases ua
         INNER JOIN (
           SELECT user_id, MAX(last_seen) AS last_seen
           FROM user_aliases
           WHERE connection_id = ?
           GROUP BY user_id
         ) latest ON latest.user_id = ua.user_id AND latest.last_seen = ua.last_seen
         WHERE ua.connection_id = ?
       ) ua ON ua.user_id = ui.user_id
       SET c.display_name = ua.alias_value
       WHERE c.connection_id = ?
         AND (c.display_name IS NULL OR c.display_name = '')
         AND c.jid NOT LIKE '%@g.us'
         AND ua.alias_value IS NOT NULL
         AND ua.alias_value <> ''`,
      [connectionId, connectionId, connectionId]
    )
    logAffected('chats.display_name(aliases)', chatAliasResult)
  }

  const backfillUsersDisplayName = async () => {
    // Backfill users.display_name from contacts/aliases
    const [userContactResult] = await pool.execute<ResultSetHeader>(
      `UPDATE users u
       INNER JOIN wa_contacts_cache w
         ON w.connection_id = u.connection_id
       AND w.user_id = u.id
      SET u.display_name = w.display_name
      WHERE u.connection_id = ?
        AND (u.display_name IS NULL OR u.display_name = '')
        AND w.display_name IS NOT NULL
        AND w.display_name <> ''`,
      [connectionId]
    )
    logAffected('users.display_name(contacts)', userContactResult)

    const [userAliasResult] = await pool.execute<ResultSetHeader>(
      `UPDATE users u
       INNER JOIN (
         SELECT ua.user_id, ua.alias_value, ua.last_seen
         FROM user_aliases ua
         INNER JOIN (
           SELECT user_id, MAX(last_seen) AS last_seen
           FROM user_aliases
           WHERE connection_id = ?
           GROUP BY user_id
         ) latest ON latest.user_id = ua.user_id AND latest.last_seen = ua.last_seen
         WHERE ua.connection_id = ?
      ) ua ON ua.user_id = u.id
      SET u.display_name = ua.alias_value
      WHERE u.connection_id = ?
        AND (u.display_name IS NULL OR u.display_name = '')
        AND ua.alias_value IS NOT NULL
        AND ua.alias_value <> ''`,
      [connectionId, connectionId, connectionId]
    )
    logAffected('users.display_name(aliases)', userAliasResult)
  }

  const backfillCommandsLogActors = async () => {
    // Backfill commands_log.actor_user_id for chats diretos
    const [commandsResult] = await pool.execute<ResultSetHeader>(
      `UPDATE commands_log cl
       INNER JOIN user_identifiers ui
         ON ui.connection_id = cl.connection_id
        AND ui.id_type = 'jid'
        AND ui.id_value = cl.chat_jid
       SET cl.actor_user_id = ui.user_id
       WHERE cl.connection_id = ?
         AND cl.actor_user_id IS NULL
         AND cl.chat_jid NOT LIKE '%@g.us'`,
      [connectionId]
    )
    logAffected('commands_log.actor_user_id', commandsResult)

    type CommandRow = RowDataPacket & { id: number; chat_jid: string }
    const [commandRows] = await pool.execute<CommandRow[]>(
      `SELECT id, chat_jid
       FROM commands_log
       WHERE connection_id = ?
         AND actor_user_id IS NULL
         AND chat_jid NOT LIKE '%@g.us'`,
      [connectionId]
    )
    for (const row of commandRows) {
      const jid = normalizeIdentifier(row.chat_jid)
      if (!jid) continue
      const userId = await ensureUserByJid(jid)
      if (!userId) continue
      await pool.execute(
        `UPDATE commands_log
         SET actor_user_id = UNHEX(REPLACE(?, '-', ''))
         WHERE connection_id = ?
           AND id = ?
           AND actor_user_id IS NULL`,
        [userId, connectionId, row.id]
      )
    }
  }

  const backfillMessages = async () => {
    // Backfill messages in batches
    let lastId = 0
    let senderUserUpdated = 0
    let senderUserLogged = 0
    let messagesProcessed = 0
    while (true) {
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
         WHERE connection_id = ?
           AND id > ?
         ORDER BY id ASC
         LIMIT ${BATCH_SIZE}`,
        [connectionId, lastId]
      )
      if (!rows.length) break

      for (const row of rows) {
        lastId = row.id
        messagesProcessed += 1
        const message = deserialize<WAMessage>(row.data_json)
        if (!message?.key) continue

        const normalized = getNormalizedMessage(message)
        const messageText = getMessageText(message)
        const mediaInfo = extractMediaInfo(normalized.content, normalized.type)
        const timestamp = toNumber(message.messageTimestamp)
        const contentType = normalized.type ? normalizeString(String(normalized.type), { maxLength: MAX_LENGTHS.contentType }) : null
        const messageType = message.messageStubType !== undefined && message.messageStubType !== null ? normalizeString(String(message.messageStubType), { maxLength: MAX_LENGTHS.messageType }) : null
        const status = message.status !== undefined && message.status !== null ? normalizeString(String(message.status), { maxLength: MAX_LENGTHS.status }) : null
        const isForwarded = toTinyInt(extractForwardedFlag(normalized.content, normalized.type))
        const isEphemeral = toTinyInt(extractEphemeralFlag(message))
        const textPreview = normalizeString(messageText, {
          maxLength: 512,
          truncate: true,
          trim: false,
        })

        if (timestamp !== null || contentType || messageType || status || isForwarded !== null || isEphemeral !== null || textPreview) {
          await pool.execute(
            `UPDATE messages
             SET timestamp = COALESCE(timestamp, ?),
                 content_type = IF(content_type IS NULL OR content_type = '', ?, content_type),
                 message_type = IF(message_type IS NULL OR message_type = '', ?, message_type),
                 status = IF(status IS NULL OR status = '', ?, status),
                 is_forwarded = COALESCE(is_forwarded, ?),
                 is_ephemeral = COALESCE(is_ephemeral, ?),
                 text_preview = IF(text_preview IS NULL OR text_preview = '', ?, text_preview)
             WHERE connection_id = ?
               AND id = ?`,
            [timestamp, contentType, messageType, status, isForwarded, isEphemeral, textPreview, connectionId, row.id]
          )
        }

        if (messageText && messageText.trim().length) {
          await pool.execute(
            `INSERT INTO message_text_index (
               connection_id,
               message_db_id,
               text_content
             )
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE
               text_content = VALUES(text_content)`,
            [connectionId, row.id, messageText]
          )
        }

        if (mediaInfo) {
          await pool.execute(
            `DELETE FROM message_media
             WHERE connection_id = ?
               AND message_db_id = ?`,
            [connectionId, row.id]
          )
          await pool.execute(
            `INSERT INTO message_media (
               connection_id,
               message_db_id,
               media_type,
               mime_type,
               file_sha256,
               file_length,
               file_name,
               url,
               local_path,
               data_json
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
            [connectionId, row.id, mediaInfo.mediaType, mediaInfo.mimeType, mediaInfo.fileSha256, mediaInfo.fileLength, mediaInfo.fileName, mediaInfo.url, serialize(mediaInfo.data)]
          )
        }

        const contextInfo = getContextInfo(normalized.content, normalized.type)
        const mentionedJids = contextInfo?.mentionedJid?.filter((jid): jid is string => typeof jid === 'string') ?? []
        const quotedJid = typeof contextInfo?.participant === 'string' ? contextInfo.participant : null

        const senderJid = message.key.fromMe ? (selfJid ?? message.key.participant ?? null) : (message.key.participant ?? message.key.remoteJid ?? null)
        if (senderJid) {
          const senderUserId = await ensureUserByJid(senderJid)
          if (senderUserId) {
            const [updateResult] = await pool.execute<ResultSetHeader>(
              `UPDATE messages
               SET sender_user_id = UNHEX(REPLACE(?, '-', ''))
               WHERE connection_id = ?
                 AND id = ?
                 AND sender_user_id IS NULL`,
              [senderUserId, connectionId, row.id]
            )
            if (updateResult.affectedRows) {
              senderUserUpdated += updateResult.affectedRows
              if (senderUserLogged < LOG_SAMPLE_LIMIT) {
                logger.info('backfill messages.sender_user_id atualizado', {
                  chatJid: row.chat_jid,
                  messageId: row.message_id,
                  fromMe: Boolean(row.from_me),
                })
                senderUserLogged += 1
              }
            }
            await pool.execute(
              `INSERT IGNORE INTO message_users (
                 connection_id,
                 message_db_id,
                 user_id,
                 relation_type
               )
               VALUES (?, ?, UNHEX(REPLACE(?, '-', '')), 'sender')`,
              [connectionId, row.id, senderUserId]
            )
          }
        }

        for (const jid of mentionedJids) {
          const userId = await ensureUserByJid(jid)
          if (userId) {
            await pool.execute(
              `INSERT IGNORE INTO message_users (
                 connection_id,
                 message_db_id,
                 user_id,
                 relation_type
               )
               VALUES (?, ?, UNHEX(REPLACE(?, '-', '')), 'mentioned')`,
              [connectionId, row.id, userId]
            )
          }
        }

        if (quotedJid) {
          const userId = await ensureUserByJid(quotedJid)
          if (userId) {
            await pool.execute(
              `INSERT IGNORE INTO message_users (
               connection_id,
               message_db_id,
               user_id,
               relation_type
             )
             VALUES (?, ?, UNHEX(REPLACE(?, '-', '')), 'quoted')`,
              [connectionId, row.id, userId]
            )
          }
        }

        if (contextInfo?.participant) {
          const userId = await ensureUserByJid(contextInfo.participant)
          if (userId) {
            await pool.execute(
              `INSERT IGNORE INTO message_users (
               connection_id,
               message_db_id,
               user_id,
               relation_type
             )
             VALUES (?, ?, UNHEX(REPLACE(?, '-', '')), 'participant')`,
              [connectionId, row.id, userId]
            )
          }
        }

        if (shouldLogProgress(MESSAGE_LOG_EVERY, messagesProcessed)) {
          logger.info('backfill mensagens progresso', {
            processed: messagesProcessed,
            lastId,
          })
        }
      }

      logger.info('backfill mensagens', { lastId })
    }

    if (senderUserUpdated) {
      logger.info('backfill messages.sender_user_id total', { updated: senderUserUpdated })
    }

    if (selfJid) {
      const selfUserId = await ensureUserByIdentifiers([{ type: 'jid', value: selfJid }], null)
      if (selfUserId) {
        const [selfResult] = await pool.execute<ResultSetHeader>(
          `UPDATE messages
           SET sender_user_id = UNHEX(REPLACE(?, '-', ''))
           WHERE connection_id = ?
             AND from_me = 1
             AND sender_user_id IS NULL`,
          [selfUserId, connectionId]
        )
        logAffected('messages.sender_user_id(from_me)', selfResult)
      }
    }

    const [senderJoinResult] = await pool.execute<ResultSetHeader>(
      `UPDATE messages m
       INNER JOIN message_users mu
         ON mu.connection_id = m.connection_id
        AND mu.message_db_id = m.id
        AND mu.relation_type = 'sender'
       SET m.sender_user_id = mu.user_id
       WHERE m.connection_id = ?
         AND m.sender_user_id IS NULL`,
      [connectionId]
    )
    logAffected('messages.sender_user_id(message_users)', senderJoinResult)
  }

  const backfillMessageEvents = async () => {
    // Backfill message_events.message_db_id
    const [messageEventDbResult] = await pool.execute<ResultSetHeader>(
      `UPDATE message_events me
       INNER JOIN messages m
         ON m.connection_id = me.connection_id
        AND m.chat_jid = me.chat_jid
        AND m.message_id = me.message_id
       SET me.message_db_id = m.id
       WHERE me.connection_id = ?
         AND me.message_db_id IS NULL`,
      [connectionId]
    )
    logAffected('message_events.message_db_id', messageEventDbResult)

    const [messageEventTargetResult] = await pool.execute<ResultSetHeader>(
      `UPDATE message_events me
       INNER JOIN messages m
         ON m.connection_id = me.connection_id
        AND m.id = me.message_db_id
       SET me.target_user_id = m.sender_user_id
       WHERE me.connection_id = ?
         AND me.target_user_id IS NULL
         AND m.sender_user_id IS NOT NULL`,
      [connectionId]
    )
    logAffected('message_events.target_user_id', messageEventTargetResult)

    type MessageEventRow = RowDataPacket & {
      id: number
      actor_user_id: Buffer | null
      target_user_id: Buffer | null
      data_json: unknown
    }
    const [messageEventRows] = await pool.execute<MessageEventRow[]>(
      `SELECT id, actor_user_id, target_user_id, data_json
       FROM message_events
       WHERE connection_id = ?
         AND data_json IS NOT NULL
         AND (actor_user_id IS NULL OR target_user_id IS NULL)`,
      [connectionId]
    )
    let messageEventsActorLogged = 0
    let messageEventsTargetLogged = 0
    for (const row of messageEventRows) {
      let parsed: unknown = null
      try {
        parsed = deserialize<unknown>(row.data_json)
      } catch {
        parsed = null
      }
      const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
      if (!record) continue

      if (!row.actor_user_id) {
        const actorJid = pickFrom(record, ['actorJid', 'actor', 'author', 'creator', 'from', 'sender']) ?? null
        const actorPn = pickFrom(record, ['actorPn', 'authorPn', 'senderPn', 'participantPn', 'pn']) ?? null
        let actorUserId: string | null = null
        if (actorJid && isUserJid(actorJid)) {
          actorUserId = await ensureUserByIdentifiers([{ type: 'jid', value: actorJid }], null)
        } else if (actorPn) {
          actorUserId = await ensureUserByPn(actorPn)
        }
        if (actorUserId) {
          const [actorResult] = await pool.execute<ResultSetHeader>(
            `UPDATE message_events
             SET actor_user_id = UNHEX(REPLACE(?, '-', ''))
             WHERE connection_id = ?
               AND id = ?
               AND actor_user_id IS NULL`,
            [actorUserId, connectionId, row.id]
          )
          if (actorResult.affectedRows && messageEventsActorLogged < LOG_SAMPLE_LIMIT) {
            logger.info('backfill message_events.actor_user_id atualizado', { eventId: row.id })
            messageEventsActorLogged += 1
          }
        }
      }

      if (!row.target_user_id) {
        const targetJid = pickFrom(record, ['targetJid', 'target', 'participant', 'user']) ?? null
        const targetPn = pickFrom(record, ['targetPn', 'participantPn', 'userPn', 'pn']) ?? null
        let targetUserId: string | null = null
        if (targetJid && isUserJid(targetJid)) {
          targetUserId = await ensureUserByIdentifiers([{ type: 'jid', value: targetJid }], null)
        } else if (targetPn) {
          targetUserId = await ensureUserByPn(targetPn)
        }
        if (targetUserId) {
          const [targetResult] = await pool.execute<ResultSetHeader>(
            `UPDATE message_events
             SET target_user_id = UNHEX(REPLACE(?, '-', ''))
             WHERE connection_id = ?
               AND id = ?
               AND target_user_id IS NULL`,
            [targetUserId, connectionId, row.id]
          )
          if (targetResult.affectedRows && messageEventsTargetLogged < LOG_SAMPLE_LIMIT) {
            logger.info('backfill message_events.target_user_id(data)', { eventId: row.id })
            messageEventsTargetLogged += 1
          }
        }
      }
    }
  }

  const backfillLabels = async () => {
    type LabelRow = RowDataPacket & {
      label_id: string
      actor_user_id: Buffer | null
      name: string | null
      color: string | null
      data_json: unknown
    }
    const [labelRows] = await pool.execute<LabelRow[]>(
      `SELECT label_id, actor_user_id, name, color, data_json
       FROM labels
       WHERE connection_id = ?
         AND data_json IS NOT NULL
         AND (
           actor_user_id IS NULL
           OR name IS NULL
           OR name = ''
           OR color IS NULL
           OR color = ''
         )`,
      [connectionId]
    )
    for (const row of labelRows) {
      let parsed: unknown = null
      try {
        parsed = deserialize<unknown>(row.data_json)
      } catch {
        parsed = null
      }
      const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
      if (!record) continue
      const actorJid = pickFrom(record, ['actorJid', 'actor', 'author', 'creator']) ?? null
      const actorUserId = actorJid && isUserJid(actorJid) ? await ensureUserByIdentifiers([{ type: 'jid', value: actorJid }], null) : null
      const name = normalizeDisplayName(record.name ?? null)
      const colorRaw = record.color ?? null
      const color = colorRaw !== null && colorRaw !== undefined ? normalizeString(String(colorRaw), { maxLength: MAX_LENGTHS.color }) : null
      if (!actorUserId && !name && !color) continue
      await pool.execute(
        `UPDATE labels
         SET actor_user_id = COALESCE(actor_user_id, IF(?, UNHEX(REPLACE(?, '-', '')), NULL)),
             name = IF(name IS NULL OR name = '', ?, name),
             color = IF(color IS NULL OR color = '', ?, color)
         WHERE connection_id = ?
           AND label_id = ?`,
        [actorUserId ? 1 : 0, actorUserId, name, color, connectionId, row.label_id]
      )
    }
  }

  const backfillLabelAssociations = async () => {
    type AssocRow = RowDataPacket & {
      label_id: string
      association_type: 'chat' | 'message' | 'contact' | 'group'
      actor_user_id: Buffer | null
      chat_jid: string | null
      message_db_id: number | null
      target_jid: string | null
      data_json: unknown
    }
    const [assocRows] = await pool.execute<AssocRow[]>(
      `SELECT label_id, association_type, actor_user_id, chat_jid, message_db_id, target_jid, data_json
       FROM label_associations
       WHERE connection_id = ?
         AND data_json IS NOT NULL
         AND (
           actor_user_id IS NULL
           OR (association_type = 'message' AND message_db_id IS NULL)
           OR (association_type = 'chat' AND (chat_jid IS NULL OR chat_jid = ''))
           OR (association_type IN ('contact', 'group') AND (target_jid IS NULL OR target_jid = ''))
         )`,
      [connectionId]
    )
    for (const row of assocRows) {
      let parsed: unknown = null
      try {
        parsed = deserialize<unknown>(row.data_json)
      } catch {
        parsed = null
      }
      const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
      if (!record) continue

      const actorJid = pickFrom(record, ['actorJid', 'actor', 'author', 'creator']) ?? null
      const actorUserId = actorJid && isUserJid(actorJid) ? await ensureUserByIdentifiers([{ type: 'jid', value: actorJid }], null) : null

      const messageId = normalizeMessageId((record.messageId as string | undefined) ?? (record.message_id as string | undefined) ?? null)
      const chatJid = normalizeJid((record.chatId as string | undefined) ?? (record.chat_id as string | undefined) ?? null)
      const contactJid = normalizeJid((record.contactJid as string | undefined) ?? (record.contact_jid as string | undefined) ?? null)
      const groupJid = normalizeJid((record.groupJid as string | undefined) ?? (record.group_jid as string | undefined) ?? null)

      let messageDbId: number | null = null
      let resolvedChatJid: string | null = null
      let resolvedTargetJid: string | null = null

      const associationType = row.association_type || (messageId && chatJid ? 'message' : groupJid ? 'group' : contactJid ? 'contact' : 'chat')

      if (associationType === 'message' && messageId && chatJid) {
        type MessageRow = RowDataPacket & { id: number }
        const [msgRows] = await pool.execute<MessageRow[]>(
          `SELECT id
           FROM messages
           WHERE connection_id = ?
             AND chat_jid = ?
             AND message_id = ?
           LIMIT 1`,
          [connectionId, chatJid, messageId]
        )
        messageDbId = msgRows[0]?.id ?? null
      } else if (associationType === 'chat') {
        resolvedChatJid = chatJid
      } else if (associationType === 'contact') {
        resolvedTargetJid = contactJid
      } else if (associationType === 'group') {
        resolvedTargetJid = groupJid
      }

      if (!actorUserId && !messageDbId && !resolvedChatJid && !resolvedTargetJid) continue
      await pool.execute(
        `UPDATE label_associations
         SET actor_user_id = COALESCE(actor_user_id, IF(?, UNHEX(REPLACE(?, '-', '')), NULL)),
             chat_jid = IF(chat_jid IS NULL OR chat_jid = '', ?, chat_jid),
             message_db_id = COALESCE(message_db_id, ?),
             target_jid = IF(target_jid IS NULL OR target_jid = '', ?, target_jid)
         WHERE connection_id = ?
           AND label_id = ?
           AND association_type = ?
           AND chat_jid <=> ?
           AND message_db_id <=> ?
           AND target_jid <=> ?`,
        [actorUserId ? 1 : 0, actorUserId, resolvedChatJid, messageDbId, resolvedTargetJid, connectionId, row.label_id, associationType, row.chat_jid, row.message_db_id, row.target_jid]
      )
    }
  }

  const backfillBlocklist = async () => {
    const [blocklistResult] = await pool.execute<ResultSetHeader>(
      `UPDATE blocklist b
       INNER JOIN user_identifiers ui
         ON ui.connection_id = b.connection_id
        AND ui.id_type = 'jid'
        AND ui.id_value = b.jid
       SET b.user_id = ui.user_id
       WHERE b.connection_id = ?
         AND b.user_id IS NULL`,
      [connectionId]
    )
    logAffected('blocklist.user_id', blocklistResult)

    type BlockRow = RowDataPacket & { jid: string }
    const [blockRows] = await pool.execute<BlockRow[]>(
      `SELECT jid
       FROM blocklist
       WHERE connection_id = ?
         AND user_id IS NULL`,
      [connectionId]
    )
    for (const row of blockRows) {
      const jid = normalizeJid(row.jid) ?? normalizeIdentifier(row.jid)
      if (!jid) continue
      const userId = await ensureUserByJid(jid)
      if (!userId) continue
      await pool.execute(
        `UPDATE blocklist
         SET user_id = UNHEX(REPLACE(?, '-', ''))
         WHERE connection_id = ?
           AND jid = ?
           AND user_id IS NULL`,
        [userId, connectionId, row.jid]
      )
    }
  }

  const backfillEventsLog = async () => {
    // Backfill events_log (best effort from data_json)
    type EventRow = RowDataPacket & {
      id: number
      chat_jid: string | null
      group_jid: string | null
      message_db_id: number | null
      actor_user_id: Buffer | null
      target_user_id: Buffer | null
      data_json: unknown
    }
    const [eventRows] = await pool.execute<EventRow[]>(
      `SELECT id, chat_jid, group_jid, message_db_id, actor_user_id, target_user_id, data_json
     FROM events_log
     WHERE connection_id = ?
       AND data_json IS NOT NULL
       AND (
         message_db_id IS NULL
         OR chat_jid IS NULL
         OR group_jid IS NULL
         OR actor_user_id IS NULL
         OR target_user_id IS NULL
       )`,
      [connectionId]
    )
    const extractMessageRef = (raw: unknown, fallbackChatJid: string | null): { chatJid: string; messageId: string } | null => {
      if (!raw || typeof raw !== 'object') return null
      const data = raw as Record<string, unknown>
      const key = data.key as Record<string, unknown> | undefined
      const messageKey = data.messageKey as Record<string, unknown> | undefined
      const chatJid = (data.chatJid as string | undefined) ?? (data.chatId as string | undefined) ?? (data.chat_jid as string | undefined) ?? (data.remoteJid as string | undefined) ?? (key?.remoteJid as string | undefined) ?? (messageKey?.chatJid as string | undefined) ?? fallbackChatJid ?? null
      const messageId = (data.messageId as string | undefined) ?? (data.message_id as string | undefined) ?? (data.id as string | undefined) ?? (key?.id as string | undefined) ?? (messageKey?.messageId as string | undefined) ?? null
      if (!chatJid || !messageId) return null
      return { chatJid, messageId }
    }

    let eventsMessageLogged = 0
    let eventsMessageUpdated = 0
    let eventsContextLogged = 0
    let eventsContextUpdated = 0
    let eventsActorLogged = 0
    let eventsActorUpdated = 0
    let eventsTargetLogged = 0
    let eventsTargetUpdated = 0

    for (const row of eventRows) {
      let parsed: unknown = null
      try {
        parsed = deserialize<unknown>(row.data_json)
      } catch {
        parsed = null
      }
      const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null

      const ref = row.message_db_id ? null : extractMessageRef(record, row.chat_jid ?? null)
      if (ref) {
        type MessageRow = RowDataPacket & { id: number }
        const [msgRows] = await pool.execute<MessageRow[]>(
          `SELECT id
         FROM messages
         WHERE connection_id = ?
           AND chat_jid = ?
           AND message_id = ?
         LIMIT 1`,
          [connectionId, ref.chatJid, ref.messageId]
        )
        const msgId = msgRows[0]?.id
        if (msgId) {
          const groupJid = ref.chatJid.endsWith('@g.us') ? ref.chatJid : null
          const [eventMsgResult] = await pool.execute<ResultSetHeader>(
            `UPDATE events_log
           SET message_db_id = ?,
               chat_jid = COALESCE(chat_jid, ?),
               group_jid = COALESCE(group_jid, ?)
           WHERE connection_id = ?
             AND id = ?`,
            [msgId, ref.chatJid, groupJid, connectionId, row.id]
          )
          if (eventMsgResult.affectedRows) {
            eventsMessageUpdated += eventMsgResult.affectedRows
            if (eventsMessageLogged < LOG_SAMPLE_LIMIT) {
              logger.info('backfill events_log.message_db_id atualizado', {
                eventId: row.id,
                chatJid: ref.chatJid,
                messageDbId: msgId,
              })
              eventsMessageLogged += 1
            }
          }
        }
      }

      const chatCandidate = pickFrom(record, ['chatJid', 'chatId', 'chat_jid', 'remoteJid', 'jid', 'id']) ?? null
      const groupCandidate = pickFrom(record, ['groupJid', 'groupId', 'group_jid']) ?? null
      const resolvedChatJid = row.chat_jid ?? (chatCandidate && !isGroupJid(chatCandidate) ? chatCandidate : null)
      const resolvedGroupJid = row.group_jid ?? (groupCandidate && isGroupJid(groupCandidate) ? groupCandidate : null) ?? (chatCandidate && isGroupJid(chatCandidate) ? chatCandidate : null)

      if ((resolvedChatJid && !row.chat_jid) || (resolvedGroupJid && !row.group_jid)) {
        const [eventContextResult] = await pool.execute<ResultSetHeader>(
          `UPDATE events_log
         SET chat_jid = COALESCE(chat_jid, ?),
             group_jid = COALESCE(group_jid, ?)
         WHERE connection_id = ?
           AND id = ?`,
          [resolvedChatJid, resolvedGroupJid, connectionId, row.id]
        )
        if (eventContextResult.affectedRows) {
          eventsContextUpdated += eventContextResult.affectedRows
          if (eventsContextLogged < LOG_SAMPLE_LIMIT) {
            logger.info('backfill events_log.contexto atualizado', {
              eventId: row.id,
              chatJid: resolvedChatJid,
              groupJid: resolvedGroupJid,
            })
            eventsContextLogged += 1
          }
        }
      }

      if (!row.actor_user_id) {
        const actorJid = pickFrom(record, ['actorJid', 'actor', 'author', 'creator', 'from', 'sender']) ?? null
        const actorPn = pickFrom(record, ['actorPn', 'authorPn', 'senderPn', 'participantPn', 'pn']) ?? null
        let actorUserId: string | null = null
        if (actorJid && isUserJid(actorJid)) {
          actorUserId = await ensureUserByIdentifiers([{ type: 'jid', value: actorJid }], null)
        } else if (actorPn) {
          actorUserId = await ensureUserByPn(actorPn)
        }
        if (actorUserId) {
          const [actorResult] = await pool.execute<ResultSetHeader>(
            `UPDATE events_log
           SET actor_user_id = UNHEX(REPLACE(?, '-', ''))
           WHERE connection_id = ?
             AND id = ?
             AND actor_user_id IS NULL`,
            [actorUserId, connectionId, row.id]
          )
          if (actorResult.affectedRows) {
            eventsActorUpdated += actorResult.affectedRows
            if (eventsActorLogged < LOG_SAMPLE_LIMIT) {
              logger.info('backfill events_log.actor_user_id atualizado', { eventId: row.id })
              eventsActorLogged += 1
            }
          }
        }
      }

      if (!row.target_user_id) {
        const targetJid = pickFrom(record, ['targetJid', 'target', 'participant', 'user']) ?? null
        const targetPn = pickFrom(record, ['targetPn', 'participantPn', 'userPn', 'pn']) ?? null
        let targetUserId: string | null = null
        if (targetJid && isUserJid(targetJid)) {
          targetUserId = await ensureUserByIdentifiers([{ type: 'jid', value: targetJid }], null)
        } else if (targetPn) {
          targetUserId = await ensureUserByPn(targetPn)
        }
        if (targetUserId) {
          const [targetResult] = await pool.execute<ResultSetHeader>(
            `UPDATE events_log
           SET target_user_id = UNHEX(REPLACE(?, '-', ''))
           WHERE connection_id = ?
             AND id = ?
             AND target_user_id IS NULL`,
            [targetUserId, connectionId, row.id]
          )
          if (targetResult.affectedRows) {
            eventsTargetUpdated += targetResult.affectedRows
            if (eventsTargetLogged < LOG_SAMPLE_LIMIT) {
              logger.info('backfill events_log.target_user_id atualizado', { eventId: row.id })
              eventsTargetLogged += 1
            }
          }
        }
      }
    }

    if (eventsMessageUpdated) {
      logger.info('backfill events_log.message_db_id total', { updated: eventsMessageUpdated })
    }
    if (eventsContextUpdated) {
      logger.info('backfill events_log.contexto total', { updated: eventsContextUpdated })
    }
    if (eventsActorUpdated) {
      logger.info('backfill events_log.actor_user_id total', { updated: eventsActorUpdated })
    }
    if (eventsTargetUpdated) {
      logger.info('backfill events_log.target_user_id total', { updated: eventsTargetUpdated })
    }
  }

  const backfillContacts = async () => {
    await backfillContactsUserId()
    await backfillContactAliases()
  }

  type BackfillTask = {
    key: string
    label: string
    dependsOn?: string[]
    count: () => Promise<number>
    run: () => Promise<void>
  }

  const countRows = async (sql: string, params: Array<string | number | boolean | null>) => {
    type CountRow = RowDataPacket & { total: number }
    const [rows] = await pool.execute<CountRow[]>(sql, params)
    return rows[0]?.total ?? 0
  }

  const countGroupsMissing = async () => {
    const baseMissing = await countRows(
      `SELECT COUNT(*) AS total
       FROM \`groups\`
       WHERE connection_id = ?
         AND (
           owner_user_id IS NULL
           OR subject IS NULL
           OR subject = ''
           OR announce IS NULL
           OR \`restrict\` IS NULL
           OR size IS NULL
         )`,
      [connectionId]
    )
    const participantsMissing = await countRows(
      `SELECT COUNT(*) AS total
       FROM (
         SELECT g.jid
         FROM \`groups\` g
         LEFT JOIN group_participants gp
           ON gp.connection_id = g.connection_id
          AND gp.group_jid = g.jid
         WHERE g.connection_id = ?
         GROUP BY g.jid
         HAVING COUNT(gp.user_id) = 0
       ) missing`,
      [connectionId]
    )
    return baseMissing + participantsMissing
  }

  const countContactsMissing = async () =>
    countRows(
      `SELECT COUNT(*) AS total
       FROM wa_contacts_cache
       WHERE connection_id = ?
         AND (
           user_id IS NULL
           OR display_name IS NULL
           OR display_name = ''
         )`,
      [connectionId]
    )

  const countLidMappingsMissing = async () =>
    countRows(
      `SELECT COUNT(*) AS total
       FROM lid_mappings
       WHERE connection_id = ?
         AND user_id IS NULL`,
      [connectionId]
    )

  const countChatsFromJsonMissing = async () =>
    countRows(
      `SELECT COUNT(*) AS total
       FROM chats
       WHERE connection_id = ?
         AND (
           display_name IS NULL
           OR display_name = ''
           OR last_message_ts IS NULL
           OR unread_count IS NULL
         )`,
      [connectionId]
    )

  const countChatUsersMissing = async () =>
    countRows(
      `SELECT COUNT(*) AS total
       FROM (
         SELECT c.jid
         FROM chats c
         LEFT JOIN chat_users cu
           ON cu.connection_id = c.connection_id
          AND cu.chat_jid = c.jid
         WHERE c.connection_id = ?
           AND c.jid NOT LIKE '%@g.us'
         GROUP BY c.jid
         HAVING COUNT(cu.user_id) = 0
       ) missing`,
      [connectionId]
    )

  const countChatsDisplayNameMissing = async () =>
    countRows(
      `SELECT COUNT(*) AS total
       FROM chats
       WHERE connection_id = ?
         AND (display_name IS NULL OR display_name = '')`,
      [connectionId]
    )

  const countUsersDisplayNameMissing = async () =>
    countRows(
      `SELECT COUNT(*) AS total
       FROM users
       WHERE connection_id = ?
         AND (display_name IS NULL OR display_name = '')`,
      [connectionId]
    )

  const countCommandsLogMissing = async () =>
    countRows(
      `SELECT COUNT(*) AS total
       FROM commands_log
       WHERE connection_id = ?
         AND actor_user_id IS NULL
         AND chat_jid NOT LIKE '%@g.us'`,
      [connectionId]
    )

  const countMessagesMissing = async () =>
    countRows(
      `SELECT COUNT(*) AS total
       FROM messages
       WHERE connection_id = ?
         AND (
           sender_user_id IS NULL
           OR timestamp IS NULL
           OR content_type IS NULL
           OR content_type = ''
           OR message_type IS NULL
           OR message_type = ''
           OR status IS NULL
           OR status = ''
           OR is_forwarded IS NULL
           OR is_ephemeral IS NULL
           OR text_preview IS NULL
           OR text_preview = ''
         )`,
      [connectionId]
    )

  const countMessageEventsMissing = async () =>
    countRows(
      `SELECT COUNT(*) AS total
       FROM message_events
       WHERE connection_id = ?
         AND (
           message_db_id IS NULL
           OR actor_user_id IS NULL
           OR target_user_id IS NULL
         )`,
      [connectionId]
    )

  const countEventsLogMissing = async () =>
    countRows(
      `SELECT COUNT(*) AS total
       FROM events_log
       WHERE connection_id = ?
         AND data_json IS NOT NULL
         AND (
           message_db_id IS NULL
           OR chat_jid IS NULL
           OR group_jid IS NULL
           OR actor_user_id IS NULL
           OR target_user_id IS NULL
         )`,
      [connectionId]
    )

  const countLabelsMissing = async () =>
    countRows(
      `SELECT COUNT(*) AS total
       FROM labels
       WHERE connection_id = ?
         AND (
           actor_user_id IS NULL
           OR name IS NULL
           OR name = ''
           OR color IS NULL
           OR color = ''
         )`,
      [connectionId]
    )

  const countLabelAssociationsMissing = async () =>
    countRows(
      `SELECT COUNT(*) AS total
       FROM label_associations
       WHERE connection_id = ?
         AND (
           actor_user_id IS NULL
           OR (association_type = 'message' AND message_db_id IS NULL)
           OR (association_type = 'chat' AND (chat_jid IS NULL OR chat_jid = ''))
           OR (association_type IN ('contact', 'group') AND (target_jid IS NULL OR target_jid = ''))
         )`,
      [connectionId]
    )

  const countBlocklistMissing = async () =>
    countRows(
      `SELECT COUNT(*) AS total
       FROM blocklist
       WHERE connection_id = ?
         AND user_id IS NULL`,
      [connectionId]
    )

  const buildTaskOrder = (tasksWithMissing: Array<BackfillTask & { missing: number }>): Array<BackfillTask & { missing: number }> => {
    const byKey = new Map(tasksWithMissing.map((task) => [task.key, task]))
    const remaining = new Set(tasksWithMissing.map((task) => task.key))
    const done = new Set<string>()
    const ordered: Array<BackfillTask & { missing: number }> = []

    while (remaining.size) {
      const ready = Array.from(remaining)
        .map((key) => byKey.get(key)!)
        .filter((task) => (task.dependsOn ?? []).every((dep) => !byKey.has(dep) || done.has(dep)))
      if (!ready.length) {
        logger.warn('backfill dependencias em ciclo, executando restante sem ordem', {
          remaining: Array.from(remaining),
        })
        for (const key of remaining) {
          const task = byKey.get(key)
          if (task) ordered.push(task)
        }
        break
      }
      ready.sort((a, b) => b.missing - a.missing || a.key.localeCompare(b.key))
      const next = ready[0]
      ordered.push(next)
      remaining.delete(next.key)
      done.add(next.key)
    }
    return ordered
  }

  const tasks: BackfillTask[] = [
    {
      key: 'groups',
      label: 'groups/participants',
      count: countGroupsMissing,
      run: backfillGroupsAndParticipants,
    },
    {
      key: 'contacts',
      label: 'contacts',
      count: countContactsMissing,
      run: backfillContacts,
    },
    {
      key: 'lid_mappings',
      label: 'lid_mappings',
      count: countLidMappingsMissing,
      run: backfillLidMappings,
    },
    {
      key: 'chats_from_json',
      label: 'chats(json)',
      count: countChatsFromJsonMissing,
      run: backfillChatsFromJson,
    },
    {
      key: 'chat_users_direct',
      label: 'chat_users(direct)',
      count: countChatUsersMissing,
      run: backfillChatUsersDirect,
    },
    {
      key: 'chats_display_name',
      label: 'chats.display_name',
      dependsOn: ['contacts', 'groups'],
      count: countChatsDisplayNameMissing,
      run: backfillChatsDisplayName,
    },
    {
      key: 'users_display_name',
      label: 'users.display_name',
      dependsOn: ['contacts'],
      count: countUsersDisplayNameMissing,
      run: backfillUsersDisplayName,
    },
    {
      key: 'commands_log',
      label: 'commands_log.actor_user_id',
      count: countCommandsLogMissing,
      run: backfillCommandsLogActors,
    },
    {
      key: 'messages',
      label: 'messages',
      count: countMessagesMissing,
      run: backfillMessages,
    },
    {
      key: 'message_events',
      label: 'message_events',
      dependsOn: ['messages'],
      count: countMessageEventsMissing,
      run: backfillMessageEvents,
    },
    {
      key: 'labels',
      label: 'labels',
      count: countLabelsMissing,
      run: backfillLabels,
    },
    {
      key: 'label_associations',
      label: 'label_associations',
      dependsOn: ['messages'],
      count: countLabelAssociationsMissing,
      run: backfillLabelAssociations,
    },
    {
      key: 'blocklist',
      label: 'blocklist',
      count: countBlocklistMissing,
      run: backfillBlocklist,
    },
    {
      key: 'events_log',
      label: 'events_log',
      count: countEventsLogMissing,
      run: backfillEventsLog,
    },
  ]

  const tasksWithMissing: Array<BackfillTask & { missing: number }> = []
  for (const task of tasks) {
    let missing = 0
    try {
      missing = await task.count()
    } catch (error) {
      logger.warn('falha ao contar pendencias', { task: task.key, err: error })
    }
    tasksWithMissing.push({ ...task, missing })
  }

  const orderedTasks = buildTaskOrder(tasksWithMissing)
  logger.info('backfill ordem de prioridade', {
    ordem: orderedTasks.map((task) => ({ task: task.key, missing: task.missing })),
  })

  for (const task of orderedTasks) {
    logger.info('backfill tarefa iniciada', { task: task.key, missing: task.missing })
    await task.run()
    logger.info('backfill tarefa concluida', { task: task.key })
  }

  await pool.end()
  logger.info('backfill concluido')
}

main().catch((error) => {
  logger.error('falha no backfill', { err: error })
  process.exitCode = 1
})
