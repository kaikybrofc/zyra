import { randomUUID } from 'node:crypto'
import {
  type AuthenticationCreds,
  BufferJSON,
  type Contact,
  type GroupMetadata,
  type WAMessage,
  type proto,
} from '@whiskeysockets/baileys'
import { loadEnv } from '../../bootstrap/env.js'
import { config } from '../../config/index.js'
import { createLogger } from '../../observability/logger.js'
import { ensureMysqlConnection } from './connection.js'
import { getMysqlPool } from './mysql.js'
import { getMessageText, getNormalizedMessage } from '../../utils/message.js'

loadEnv()
const logger = createLogger()

const BATCH_SIZE = 500

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
    type CredsRow = { creds_json: unknown }
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

  const ensureUserByJid = async (jid: string, displayName?: string | null) => {
    type UserRow = { user_id: string }
    const [rows] = await pool.execute<UserRow[]>(
      `SELECT BIN_TO_UUID(user_id, 1) AS user_id
       FROM user_identifiers
       WHERE connection_id = ?
         AND id_type = 'jid'
         AND id_value = ?
       LIMIT 1`,
      [connectionId, jid]
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
      return existing
    }

    const userId = randomUUID()
    await pool.execute(
      `INSERT INTO users (id, connection_id, display_name)
       VALUES (UUID_TO_BIN(?, 1), ?, ?)`,
      [userId, connectionId, displayName ?? null]
    )
    await pool.execute(
      `INSERT INTO user_identifiers (connection_id, user_id, id_type, id_value)
       VALUES (?, UUID_TO_BIN(?, 1), 'jid', ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
      [connectionId, userId, jid]
    )
    return userId
  }

  const setChatUser = async (chatJid: string, userJid: string, role?: string | null) => {
    const normalizedChat = normalizeIdentifier(chatJid)
    const normalizedUser = normalizeIdentifier(userJid)
    if (!normalizedChat || !normalizedUser) return
    const userId = await ensureUserByJid(normalizedUser)
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
      [connectionId, normalizedChat, userId, role ?? null]
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
  type GroupRow = { jid: string; data_json: unknown }
  const [groupRows] = await pool.execute<GroupRow[]>(
    `SELECT jid, data_json FROM \`groups\` WHERE connection_id = ?`,
    [connectionId]
  )
  for (const row of groupRows) {
    const group = deserialize<GroupMetadata>(row.data_json)
    if (group?.owner) {
      const ownerJid = normalizeIdentifier(group.owner)
      if (ownerJid) {
        const ownerUserId = await ensureUserByJid(ownerJid)
        await pool.execute(
          `UPDATE \`groups\`
           SET owner_user_id = UUID_TO_BIN(?, 1)
           WHERE connection_id = ?
             AND jid = ?`,
          [ownerUserId, connectionId, row.jid]
        )
      }
    }
    if (group?.participants?.length) {
      for (const participant of group.participants) {
        const jid = normalizeIdentifier(participant.id)
        if (!jid) continue
        const userId = await ensureUserByJid(jid)
        const role = participant.admin ?? null
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
      }
    }
  }

  logger.info('backfill groups.owner_user_id concluido', { total: groupRows.length })

  // Backfill lid_mappings.user_id and wa_contacts_cache.user_id
  await pool.execute(
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
  await pool.execute(
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
  await pool.execute(
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

  // Backfill chat_users for direct chats
  type ChatRow = { jid: string; data_json: unknown }
  const [chatRows] = await pool.execute<ChatRow[]>(
    `SELECT jid, data_json FROM chats WHERE connection_id = ?`,
    [connectionId]
  )
  for (const row of chatRows) {
    if (!row.jid.endsWith('@g.us')) {
      await setChatUser(row.jid, row.jid, null)
    }
  }

  // Backfill contacts aliases
  type ContactRow = { jid: string; data_json: unknown }
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

  // Backfill messages in batches
  let lastId = 0
  while (true) {
    type MessageRow = {
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
        ? selfJid
        : (message.key.participant ?? message.key.remoteJid ?? null)
      if (senderJid) {
        const senderUserId = await ensureUserByJid(senderJid)
        await pool.execute(
          `UPDATE messages
           SET sender_user_id = UUID_TO_BIN(?, 1)
           WHERE connection_id = ?
             AND id = ?
             AND sender_user_id IS NULL`,
          [senderUserId, connectionId, row.id]
        )
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
    }

    logger.info('backfill mensagens', { lastId })
  }

  // Backfill message_events.message_db_id
  await pool.execute(
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

  // Backfill events_log.message_db_id (best effort from data_json)
  type EventRow = {
    id: number
    chat_jid: string | null
    group_jid: string | null
    data_json: unknown
  }
  const [eventRows] = await pool.execute<EventRow[]>(
    `SELECT id, chat_jid, group_jid, data_json
     FROM events_log
     WHERE connection_id = ?
       AND message_db_id IS NULL
       AND data_json IS NOT NULL`,
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

  for (const row of eventRows) {
    let parsed: unknown = null
    try {
      parsed = deserialize<unknown>(row.data_json)
    } catch {
      parsed = null
    }
    const ref = extractMessageRef(parsed, row.chat_jid ?? null)
    if (!ref) continue
    type MessageRow = { id: number }
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
    if (!msgId) continue
    const groupJid = ref.chatJid.endsWith('@g.us') ? ref.chatJid : null
    await pool.execute(
      `UPDATE events_log
       SET message_db_id = ?,
           chat_jid = COALESCE(chat_jid, ?),
           group_jid = COALESCE(group_jid, ?)
       WHERE connection_id = ?
         AND id = ?`,
      [msgId, ref.chatJid, groupJid, connectionId, row.id]
    )
  }

  await pool.end()
  logger.info('backfill concluido')
}

main().catch((error) => {
  logger.error('falha no backfill', { err: error })
  process.exitCode = 1
})
