import { randomUUID } from 'node:crypto'
import {
  type AuthenticationCreds,
  BufferJSON,
  type Contact,
  type GroupMetadata,
  type WAMessage,
  type proto,
} from '@whiskeysockets/baileys'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { loadEnv } from '../../bootstrap/env.js'
import { config } from '../../config/index.js'
import { createLogger } from '../../observability/logger.js'
import { ensureMysqlConnection } from './connection.js'
import { getMysqlPool } from './mysql.js'
import { getMessageText, getNormalizedMessage } from '../../utils/message.js'

loadEnv()
const logger = createLogger()
const LOG_SAMPLE_LIMIT = Number(process.env.WA_BACKFILL_LOG_SAMPLE ?? 20)

const BATCH_SIZE = Number(process.env.WA_BACKFILL_BATCH_SIZE ?? 500)
const GROUP_LOG_EVERY = Number(process.env.WA_BACKFILL_GROUP_LOG_EVERY ?? 25)
const PARTICIPANT_LOG_EVERY = Number(process.env.WA_BACKFILL_PARTICIPANT_LOG_EVERY ?? 200)
const MESSAGE_LOG_EVERY = Number(process.env.WA_BACKFILL_MESSAGE_LOG_EVERY ?? 1000)

const logAffected = (label: string, result: ResultSetHeader) => {
  if (result.affectedRows) {
    logger.info('backfill atualizado', { item: label, affected: result.affectedRows })
  }
}

const shouldLogProgress = (every: number, count: number) =>
  Number.isFinite(every) && every > 0 && count % every === 0

const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)
const deserialize = <T>(value: unknown) => {
  if (value === null || value === undefined) return null as T
  if (typeof value === 'string') {
    return JSON.parse(value, BufferJSON.reviver) as T
  }
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T
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
):
  | {
      mediaType: string
      mimeType: string | null
      fileSha256: string | null
      fileLength: number | null
      fileName: string | null
      url: string | null
      data: unknown
    }
  | null => {
  if (!content || !type) return null
  const mediaTypes = new Set([
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'documentMessage',
    'stickerMessage',
    'ptvMessage',
  ])
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

const getContextInfo = (
  content: proto.IMessage | undefined,
  type: keyof proto.IMessage | null
): proto.IContextInfo | null => {
  if (!content || !type) return null
  const inner = (content as proto.IMessage)[type] as { contextInfo?: proto.IContextInfo } | null
  return inner?.contextInfo ?? null
}

const normalizeIdentifier = (value: string | null | undefined): string | null => {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

const userIdCache = new Map<string, string>()
const cacheKey = (type: string, value: string) => `${type}:${value}`
const cacheUserId = (
  userId: string,
  identifiers: Array<{ type: string; value: string }>
) => {
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
    const creds = rows[0]?.creds_json
      ? deserialize<AuthenticationCreds>(rows[0].creds_json)
      : null
    const jid = normalizeIdentifier((creds as { me?: { id?: string | null } } | null)?.me?.id ?? null)
    if (!jid) {
      logger.warn('nao foi possivel resolver o JID da conta para backfill')
    }
    return jid
  }

  const selfJid = await resolveSelfJid()

  type UserIdentifierType = 'jid' | 'pn' | 'lid' | 'username'

  const ensureUserByIdentifiers = async (
    identifiers: Array<{ type: UserIdentifierType; value: string }>,
    displayName?: string | null
  ) => {
    const clean = identifiers
      .map((entry) => ({ type: entry.type, value: normalizeIdentifier(entry.value) }))
      .filter(
        (entry): entry is { type: UserIdentifierType; value: string } =>
          Boolean(entry.value)
      )
    if (!clean.length) return null

    const cachedUserId =
      clean
        .map((entry) => userIdCache.get(cacheKey(entry.type, entry.value)))
        .find((value): value is string => Boolean(value)) ?? null

    if (cachedUserId) {
      if (displayName) {
        await pool.execute(
          `UPDATE users
           SET display_name = ?
           WHERE connection_id = ?
             AND id = UUID_TO_BIN(?, 1)`,
          [displayName, connectionId, cachedUserId]
        )
      }
      for (const ident of clean) {
        await pool.execute(
          `INSERT INTO user_identifiers (connection_id, user_id, id_type, id_value)
           VALUES (?, UUID_TO_BIN(?, 1), ?, ?)
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
      `SELECT BIN_TO_UUID(user_id, 1) AS user_id, id_type, id_value
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
             AND id = UUID_TO_BIN(?, 1)`,
          [displayName, connectionId, existing]
        )
      }
      for (const ident of clean) {
        await pool.execute(
          `INSERT INTO user_identifiers (connection_id, user_id, id_type, id_value)
           VALUES (?, UUID_TO_BIN(?, 1), ?, ?)
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
       VALUES (UUID_TO_BIN(?, 1), ?, ?)`,
      [userId, connectionId, displayName ?? null]
    )
    for (const ident of clean) {
      await pool.execute(
        `INSERT INTO user_identifiers (connection_id, user_id, id_type, id_value)
         VALUES (?, UUID_TO_BIN(?, 1), ?, ?)
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
        [connectionId, userId, ident.type, ident.value]
      )
    }
    cacheUserId(userId, clean)
    return userId
  }

  const ensureUserByJid = async (jid: string, displayName?: string | null) =>
    ensureUserByIdentifiers([{ type: 'jid', value: jid }], displayName)

  const ensureUserByPn = async (pn: string, displayName?: string | null) =>
    ensureUserByIdentifiers([{ type: 'pn', value: pn }], displayName)

  const setChatUser = async (chatJid: string, userJid: string, role?: string | null) => {
    const normalizedChat = normalizeIdentifier(chatJid)
    const normalizedUser = normalizeIdentifier(userJid)
    if (!normalizedChat || !normalizedUser) return
    const userId = await ensureUserByJid(normalizedUser)
    const resolvedRole = role ?? 'member'
    await pool.execute(
      `INSERT INTO chat_users (
         connection_id,
         chat_jid,
         user_id,
         role
       )
       VALUES (?, ?, UUID_TO_BIN(?, 1), ?)
       ON DUPLICATE KEY UPDATE
         role = VALUES(role)`,
      [connectionId, normalizedChat, userId, resolvedRole]
    )
  }

  const setUserAlias = async (
    jid: string,
    type: 'pushName' | 'notify' | 'username' | 'display_name',
    value: string
  ) => {
    const userId = await ensureUserByJid(jid)
    await pool.execute(
      `INSERT INTO user_aliases (connection_id, user_id, alias_type, alias_value)
       VALUES (?, UUID_TO_BIN(?, 1), ?, ?)
       ON DUPLICATE KEY UPDATE last_seen = CURRENT_TIMESTAMP`,
      [connectionId, userId, type, value]
    )
  }

  // Backfill groups owner_user_id
  // Backfill groups and participants
  type GroupRow = RowDataPacket & { jid: string; data_json: unknown }
  const [groupRows] = await pool.execute<GroupRow[]>(
    `SELECT jid, data_json FROM \`groups\` WHERE connection_id = ?`,
    [connectionId]
  )
  let groupIndex = 0
  let participantsProcessed = 0
  for (const row of groupRows) {
    groupIndex += 1
    const group = deserialize<GroupMetadata>(row.data_json)
    const ownerCandidates: Array<{ type: UserIdentifierType; value: string }> = []
    if (group?.owner) ownerCandidates.push({ type: 'jid', value: group.owner })
    if ((group as { ownerPn?: string | null }).ownerPn) {
      ownerCandidates.push({
        type: 'pn',
        value: (group as { ownerPn?: string | null }).ownerPn as string,
      })
    }
    if (!ownerCandidates.length) {
      if ((group as { subjectOwner?: string | null }).subjectOwner) {
        ownerCandidates.push({
          type: 'jid',
          value: (group as { subjectOwner?: string | null }).subjectOwner as string,
        })
      }
      if ((group as { subjectOwnerPn?: string | null }).subjectOwnerPn) {
        ownerCandidates.push({
          type: 'pn',
          value: (group as { subjectOwnerPn?: string | null }).subjectOwnerPn as string,
        })
      }
      if ((group as { descOwner?: string | null }).descOwner) {
        ownerCandidates.push({
          type: 'jid',
          value: (group as { descOwner?: string | null }).descOwner as string,
        })
      }
      if ((group as { descOwnerPn?: string | null }).descOwnerPn) {
        ownerCandidates.push({
          type: 'pn',
          value: (group as { descOwnerPn?: string | null }).descOwnerPn as string,
        })
      }
    }
    if (ownerCandidates.length) {
      const ownerUserId = await ensureUserByIdentifiers(ownerCandidates, null)
      if (ownerUserId) {
        const [result] = await pool.execute<ResultSetHeader>(
          `UPDATE \`groups\`
           SET owner_user_id = UUID_TO_BIN(?, 1)
           WHERE connection_id = ?
             AND jid = ?`,
          [ownerUserId, connectionId, row.jid]
        )
        if (result.affectedRows) {
          logger.info('backfill groups.owner_user_id atualizado', { groupJid: row.jid })
        }
      }
    }
    if (group?.participants?.length) {
      for (const participant of group.participants) {
        const jid = normalizeIdentifier(participant.id)
        if (!jid) continue
        const userId = await ensureUserByJid(jid)
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
           VALUES (?, ?, UUID_TO_BIN(?, 1), ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             participant_jid = VALUES(participant_jid),
             role = VALUES(role),
             is_admin = VALUES(is_admin),
             is_superadmin = VALUES(is_superadmin),
             data_json = VALUES(data_json)`,
          [
            connectionId,
            row.jid,
            userId,
            jid,
            role,
            isAdmin ? 1 : 0,
            isSuper ? 1 : 0,
            serialize(participant),
          ]
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

  // Backfill lid_mappings.user_id and wa_contacts_cache.user_id
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

  // Backfill chat_users for direct chats
  type ChatRow = RowDataPacket & { jid: string; data_json: unknown }
  const [chatRows] = await pool.execute<ChatRow[]>(
    `SELECT jid, data_json FROM chats WHERE connection_id = ?`,
    [connectionId]
  )
  for (const row of chatRows) {
    if (!row.jid.endsWith('@g.us')) {
      await setChatUser(row.jid, row.jid, 'member')
    }
  }

  // Backfill contacts aliases
  type ContactRow = RowDataPacket & { jid: string; data_json: unknown }
  const [contactRows] = await pool.execute<ContactRow[]>(
    `SELECT jid, data_json FROM wa_contacts_cache WHERE connection_id = ?`,
    [connectionId]
  )
  for (const row of contactRows) {
    const contact = deserialize<Contact>(row.data_json)
    if (!contact) continue
    if (contact.notify) await setUserAlias(row.jid, 'notify', contact.notify)
    if (contact.name) await setUserAlias(row.jid, 'display_name', contact.name)
    const pushName = (contact as { pushName?: string }).pushName
    if (pushName) await setUserAlias(row.jid, 'pushName', pushName)
  }

  // Backfill chats.display_name from groups/contacts/aliases
  const [chatGroupResult] = await pool.execute<ResultSetHeader>(
    `UPDATE chats c
     INNER JOIN \`groups\` g
       ON g.connection_id = c.connection_id
      AND g.jid = c.jid
     SET c.display_name = g.subject
     WHERE c.connection_id = ?
       AND c.display_name IS NULL
       AND g.subject IS NOT NULL`,
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
       AND c.display_name IS NULL
       AND c.jid NOT LIKE '%@g.us'
       AND w.display_name IS NOT NULL`,
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
       AND c.display_name IS NULL
       AND c.jid NOT LIKE '%@g.us'
       AND ua.alias_value IS NOT NULL`,
    [connectionId, connectionId, connectionId]
  )
  logAffected('chats.display_name(aliases)', chatAliasResult)

  // Backfill users.display_name from contacts/aliases
  const [userContactResult] = await pool.execute<ResultSetHeader>(
    `UPDATE users u
     INNER JOIN wa_contacts_cache w
       ON w.connection_id = u.connection_id
      AND w.user_id = u.id
     SET u.display_name = w.display_name
     WHERE u.connection_id = ?
       AND u.display_name IS NULL
       AND w.display_name IS NOT NULL`,
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
       AND u.display_name IS NULL
       AND ua.alias_value IS NOT NULL`,
    [connectionId, connectionId, connectionId]
  )
  logAffected('users.display_name(aliases)', userAliasResult)

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
    const [rows] = await pool.execute<MessageRow[]>(
      `SELECT id, chat_jid, message_id, from_me, data_json
       FROM messages
       WHERE connection_id = ?
         AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
      [connectionId, lastId, BATCH_SIZE]
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
          [
            connectionId,
            row.id,
            mediaInfo.mediaType,
            mediaInfo.mimeType,
            mediaInfo.fileSha256,
            mediaInfo.fileLength,
            mediaInfo.fileName,
            mediaInfo.url,
            serialize(mediaInfo.data),
          ]
        )
      }

      const contextInfo = getContextInfo(normalized.content, normalized.type)
      const mentionedJids =
        contextInfo?.mentionedJid?.filter((jid): jid is string => typeof jid === 'string') ?? []
      const quotedJid = typeof contextInfo?.participant === 'string' ? contextInfo.participant : null

      const senderJid = message.key.fromMe
        ? (selfJid ?? message.key.participant ?? null)
        : (message.key.participant ?? message.key.remoteJid ?? null)
      if (senderJid) {
        const senderUserId = await ensureUserByJid(senderJid)
        const [updateResult] = await pool.execute<ResultSetHeader>(
          `UPDATE messages
           SET sender_user_id = UUID_TO_BIN(?, 1)
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
           VALUES (?, ?, UUID_TO_BIN(?, 1), 'sender')`,
          [connectionId, row.id, senderUserId]
        )
      }

      for (const jid of mentionedJids) {
        const userId = await ensureUserByJid(jid)
        await pool.execute(
          `INSERT IGNORE INTO message_users (
             connection_id,
             message_db_id,
             user_id,
             relation_type
           )
           VALUES (?, ?, UUID_TO_BIN(?, 1), 'mentioned')`,
          [connectionId, row.id, userId]
        )
      }

      if (quotedJid) {
        const userId = await ensureUserByJid(quotedJid)
        await pool.execute(
          `INSERT IGNORE INTO message_users (
             connection_id,
             message_db_id,
             user_id,
             relation_type
           )
           VALUES (?, ?, UUID_TO_BIN(?, 1), 'quoted')`,
          [connectionId, row.id, userId]
        )
      }

      if (contextInfo?.participant) {
        const userId = await ensureUserByJid(contextInfo.participant)
        await pool.execute(
          `INSERT IGNORE INTO message_users (
             connection_id,
             message_db_id,
             user_id,
             relation_type
           )
           VALUES (?, ?, UUID_TO_BIN(?, 1), 'participant')`,
          [connectionId, row.id, userId]
        )
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
         SET sender_user_id = UUID_TO_BIN(?, 1)
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
  const extractMessageRef = (
    raw: unknown,
    fallbackChatJid: string | null
  ): { chatJid: string; messageId: string } | null => {
    if (!raw || typeof raw !== 'object') return null
    const data = raw as Record<string, unknown>
    const key = data.key as Record<string, unknown> | undefined
    const messageKey = data.messageKey as Record<string, unknown> | undefined
    const chatJid =
      (data.chatJid as string | undefined) ??
      (data.chatId as string | undefined) ??
      (data.chat_jid as string | undefined) ??
      (data.remoteJid as string | undefined) ??
      (key?.remoteJid as string | undefined) ??
      (messageKey?.chatJid as string | undefined) ??
      fallbackChatJid ??
      null
    const messageId =
      (data.messageId as string | undefined) ??
      (data.message_id as string | undefined) ??
      (data.id as string | undefined) ??
      (key?.id as string | undefined) ??
      (messageKey?.messageId as string | undefined) ??
      null
    if (!chatJid || !messageId) return null
    return { chatJid, messageId }
  }

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

    const chatCandidate =
      pickFrom(record, ['chatJid', 'chatId', 'chat_jid', 'remoteJid', 'jid', 'id']) ?? null
    const groupCandidate =
      pickFrom(record, ['groupJid', 'groupId', 'group_jid']) ?? null
    const resolvedChatJid =
      row.chat_jid ?? (chatCandidate && !isGroupJid(chatCandidate) ? chatCandidate : null)
    const resolvedGroupJid =
      row.group_jid ??
      (groupCandidate && isGroupJid(groupCandidate) ? groupCandidate : null) ??
      (chatCandidate && isGroupJid(chatCandidate) ? chatCandidate : null)

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
      const actorJid =
        pickFrom(record, ['actorJid', 'actor', 'author', 'creator', 'from', 'sender']) ?? null
      const actorPn =
        pickFrom(record, ['actorPn', 'authorPn', 'senderPn', 'participantPn', 'pn']) ?? null
      let actorUserId: string | null = null
      if (actorJid && isUserJid(actorJid)) {
        actorUserId = await ensureUserByIdentifiers([{ type: 'jid', value: actorJid }], null)
      } else if (actorPn) {
        actorUserId = await ensureUserByPn(actorPn)
      }
      if (actorUserId) {
        const [actorResult] = await pool.execute<ResultSetHeader>(
          `UPDATE events_log
           SET actor_user_id = UUID_TO_BIN(?, 1)
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
      const targetJid =
        pickFrom(record, ['targetJid', 'target', 'participant', 'user']) ?? null
      const targetPn =
        pickFrom(record, ['targetPn', 'participantPn', 'userPn', 'pn']) ?? null
      let targetUserId: string | null = null
      if (targetJid && isUserJid(targetJid)) {
        targetUserId = await ensureUserByIdentifiers([{ type: 'jid', value: targetJid }], null)
      } else if (targetPn) {
        targetUserId = await ensureUserByPn(targetPn)
      }
      if (targetUserId) {
        const [targetResult] = await pool.execute<ResultSetHeader>(
          `UPDATE events_log
           SET target_user_id = UUID_TO_BIN(?, 1)
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

  await pool.end()
  logger.info('backfill concluido')
}

main().catch((error) => {
  logger.error('falha no backfill', { err: error })
  process.exitCode = 1
})
