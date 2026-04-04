import {
  BufferJSON,
  type Chat,
  type Contact,
  type GroupMetadata,
  type GroupParticipant,
  type LIDMapping,
  type WAMessage,
  type proto,
} from '@whiskeysockets/baileys'
import type { RowDataPacket } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.js'
import { ensureMysqlConnection } from '../core/db/connection.js'
import { getMysqlPool } from '../core/db/mysql.js'
import { getMessageText, getNormalizedMessage } from '../utils/message.js'

const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)
const deserialize = <T>(value: unknown) => {
  if (value === null || value === undefined) return null as T
  if (typeof value === 'string') {
    return JSON.parse(value, BufferJSON.reviver) as T
  }
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T
}

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

const extractForwardedFlag = (
  content: proto.IMessage | undefined,
  type: keyof proto.IMessage | null
): boolean | null => {
  if (!content || !type) return null
  const inner = content[type]
  if (!inner || typeof inner !== 'object') return null
  const contextInfo = (
    inner as { contextInfo?: { isForwarded?: boolean; forwardingScore?: number } }
  ).contextInfo
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
  return Boolean(
    content.ephemeralMessage ||
      content.viewOnceMessage ||
      content.viewOnceMessageV2 ||
      content.viewOnceMessageV2Extension
  )
}

type MessageKeyParts = {
  chatJid: string
  messageId: string
  fromMe: number
}

const parseMessageKey = (key: string): MessageKeyParts | null => {
  const [chatJid, , fromMeRaw, messageId] = key.split(':')
  if (!chatJid || !messageId || fromMeRaw === undefined) return null
  return {
    chatJid,
    messageId,
    fromMe: fromMeRaw === '1' ? 1 : 0,
  }
}

export type SqlStore = {
  enabled: boolean
  getMessage: (key: string) => Promise<WAMessage | undefined>
  setMessage: (message: WAMessage) => Promise<void>
  deleteMessage: (chatJid: string, messageId: string, fromMe: boolean) => Promise<void>
  deleteMessagesByJid: (jid: string) => Promise<void>
  getGroup: (id: string) => Promise<GroupMetadata | undefined>
  setGroup: (id: string, group: GroupMetadata) => Promise<void>
  deleteGroup: (id: string) => Promise<void>
  setGroupParticipants: (
    groupJid: string,
    participants: GroupParticipant[],
    options?: { replace?: boolean }
  ) => Promise<void>
  removeGroupParticipants: (groupJid: string, participantJids: string[]) => Promise<void>
  setChat: (id: string, chat: Chat) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  setContact: (id: string, contact: Contact) => Promise<void>
  setLidMapping: (mapping: LIDMapping) => Promise<void>
  getLidForPn: (pn: string) => Promise<string | null>
  getPnForLid: (lid: string) => Promise<string | null>
  recordMessageEvent: (event: {
    key: { chatJid: string; messageId: string; fromMe: boolean }
    type: string
    actorJid?: string | null
    targetJid?: string | null
    data?: unknown
  }) => Promise<void>
  recordEvent: (event: {
    type: string
    actorJid?: string | null
    targetJid?: string | null
    chatJid?: string | null
    groupJid?: string | null
    messageKey?: { chatJid: string; messageId: string; fromMe: boolean } | null
    data?: unknown
  }) => Promise<void>
  setBlocklist: (entry: {
    jid: string
    isBlocked: boolean
    actorJid?: string | null
    reason?: string | null
    data?: unknown
  }) => Promise<void>
  recordGroupEvent: (event: {
    groupJid: string
    eventType: string
    actorJid?: string | null
    targetJid?: string | null
    data?: unknown
  }) => Promise<void>
  recordGroupJoinRequest: (entry: {
    groupJid: string
    userJid: string
    actorJid?: string | null
    action: string
    method?: string | null
    data?: unknown
  }) => Promise<void>
  recordNewsletter: (entry: { newsletterId: string; data?: unknown }) => Promise<void>
  recordNewsletterParticipant: (entry: {
    newsletterId: string
    userJid: string
    role?: string | null
    status?: string | null
  }) => Promise<void>
  recordNewsletterEvent: (event: {
    newsletterId: string
    eventType: string
    actorJid?: string | null
    targetJid?: string | null
    data?: unknown
  }) => Promise<void>
  recordMessageFailure: (entry: {
    chatJid: string
    messageId?: string | null
    senderJid?: string | null
    actorJid?: string | null
    reason?: string | null
    data?: unknown
  }) => Promise<void>
  recordBotSession: (entry: {
    deviceLabel?: string | null
    platform?: string | null
    appVersion?: string | null
    lastLogin?: Date | null
    data?: unknown
  }) => Promise<void>
  recordCommandLog: (entry: {
    actorJid?: string | null
    chatJid: string
    commandName: string
    argsText?: string | null
    success: boolean
    durationMs?: number | null
    data?: unknown
  }) => Promise<void>
  setUserDevice: (entry: { userJid: string; deviceId: string; data?: unknown }) => Promise<void>
  setChatUser: (chatJid: string, userJid: string, role?: string | null) => Promise<void>
  deleteChatUser: (chatJid: string, userJid: string) => Promise<void>
  setLabel: (label: {
    id: string
    name?: string | null
    color?: string | null
    data?: unknown
    actorJid?: string | null
  }) => Promise<void>
  setLabelAssociation: (association: {
    labelId: string
    associationType: 'chat' | 'message' | 'contact' | 'group'
    chatJid?: string | null
    messageKey?: { chatJid: string; messageId: string; fromMe: boolean } | null
    targetJid?: string | null
    actorJid?: string | null
    data?: unknown
  }) => Promise<void>
}

export function createSqlStore(): SqlStore {
  if (!config.mysqlUrl) {
    return {
      enabled: false,
      getMessage: async () => undefined,
      setMessage: async () => undefined,
      deleteMessage: async () => undefined,
      deleteMessagesByJid: async () => undefined,
      getGroup: async () => undefined,
      setGroup: async () => undefined,
      deleteGroup: async () => undefined,
      setGroupParticipants: async () => undefined,
      removeGroupParticipants: async () => undefined,
      setChat: async () => undefined,
      deleteChat: async () => undefined,
      setContact: async () => undefined,
      setLidMapping: async () => undefined,
      getLidForPn: async () => null,
      getPnForLid: async () => null,
      recordMessageEvent: async () => undefined,
      recordEvent: async () => undefined,
      setBlocklist: async () => undefined,
      recordGroupEvent: async () => undefined,
      recordGroupJoinRequest: async () => undefined,
      recordNewsletter: async () => undefined,
      recordNewsletterParticipant: async () => undefined,
      recordNewsletterEvent: async () => undefined,
      recordMessageFailure: async () => undefined,
      recordBotSession: async () => undefined,
      recordCommandLog: async () => undefined,
      setUserDevice: async () => undefined,
      setChatUser: async () => undefined,
      deleteChatUser: async () => undefined,
      setLabel: async () => undefined,
      setLabelAssociation: async () => undefined,
    }
  }

  const safe = async <T>(
    fn: (pool: NonNullable<ReturnType<typeof getMysqlPool>>) => Promise<T>,
    fallback: T,
    options?: { ensureConnection?: boolean }
  ): Promise<T> => {
    try {
      const pool = getMysqlPool()
      if (!pool) return fallback
      if (options?.ensureConnection) {
        await ensureMysqlConnection(pool)
      }
      return await fn(pool)
    } catch {
      return fallback
    }
  }

  const connectionId = config.connectionId ?? 'default'

  type UserIdentifierType = 'pn' | 'lid' | 'jid' | 'username'

  const normalizeIdentifier = (value: string | null | undefined): string | null => {
    if (!value) return null
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
  }

  const ensureUserByIdentifiers = async (
    pool: NonNullable<ReturnType<typeof getMysqlPool>>,
    identifiers: Array<{ type: UserIdentifierType; value: string }>,
    displayName?: string | null,
    aliases?: Array<{ type: 'pushName' | 'notify' | 'username' | 'display_name'; value: string }>
  ): Promise<string | null> => {
    const cleanIdentifiers = identifiers.filter((entry) => entry.value.length)
    if (!cleanIdentifiers.length) return null

    type UserRow = RowDataPacket & { user_id: string }
    for (const entry of cleanIdentifiers) {
      const [rows] = await pool.execute<UserRow[]>(
        `SELECT BIN_TO_UUID(user_id, 1) AS user_id
         FROM user_identifiers
         WHERE connection_id = ?
           AND id_type = ?
           AND id_value = ?
         LIMIT 1`,
        [connectionId, entry.type, entry.value]
      )
      if (rows[0]?.user_id) {
        const userId = rows[0].user_id
        if (displayName) {
          await pool.execute(
            `UPDATE users
             SET display_name = ?
             WHERE connection_id = ?
               AND id = UUID_TO_BIN(?, 1)`,
            [displayName, connectionId, userId]
          )
        }
        for (const ident of cleanIdentifiers) {
          await pool.execute(
            `INSERT INTO user_identifiers (connection_id, user_id, id_type, id_value)
             VALUES (?, UUID_TO_BIN(?, 1), ?, ?)
             ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
            [connectionId, userId, ident.type, ident.value]
          )
        }
        if (aliases?.length) {
          for (const alias of aliases) {
            if (!alias.value.trim()) continue
            await pool.execute(
              `INSERT INTO user_aliases (connection_id, user_id, alias_type, alias_value)
               VALUES (?, UUID_TO_BIN(?, 1), ?, ?)
               ON DUPLICATE KEY UPDATE last_seen = CURRENT_TIMESTAMP`,
              [connectionId, userId, alias.type, alias.value.trim()]
            )
          }
        }
        return userId
      }
    }

    const userId = randomUUID()
    await pool.execute(
      `INSERT INTO users (id, connection_id, display_name)
       VALUES (UUID_TO_BIN(?, 1), ?, ?)`,
      [userId, connectionId, displayName ?? null]
    )
    for (const ident of cleanIdentifiers) {
      await pool.execute(
        `INSERT INTO user_identifiers (connection_id, user_id, id_type, id_value)
         VALUES (?, UUID_TO_BIN(?, 1), ?, ?)
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
        [connectionId, userId, ident.type, ident.value]
      )
    }
    if (aliases?.length) {
      for (const alias of aliases) {
        if (!alias.value.trim()) continue
        await pool.execute(
          `INSERT INTO user_aliases (connection_id, user_id, alias_type, alias_value)
           VALUES (?, UUID_TO_BIN(?, 1), ?, ?)
           ON DUPLICATE KEY UPDATE last_seen = CURRENT_TIMESTAMP`,
          [connectionId, userId, alias.type, alias.value.trim()]
        )
      }
    }
    return userId
  }

  const toBase64 = (value: unknown): string | null => {
    if (!value) return null
    if (typeof value === 'string') return value
    if (value instanceof Uint8Array) {
      return Buffer.from(value).toString('base64')
    }
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

  const getMessageDbId = async (
    pool: NonNullable<ReturnType<typeof getMysqlPool>>,
    key: { chatJid: string; messageId: string; fromMe: number }
  ): Promise<number | null> => {
    type IdRow = RowDataPacket & { id: number }
    const [rows] = await pool.execute<IdRow[]>(
      `SELECT id
       FROM messages
       WHERE connection_id = ?
         AND chat_jid = ?
         AND message_id = ?
         AND from_me = ?
       ORDER BY id DESC
       LIMIT 1`,
      [connectionId, key.chatJid, key.messageId, key.fromMe]
    )
    return rows[0]?.id ?? null
  }

  const getContextInfo = (
    content: proto.IMessage | undefined,
    type: keyof proto.IMessage | null
  ): proto.IContextInfo | null => {
    if (!content || !type) return null
    const inner = (content as proto.IMessage)[type] as { contextInfo?: proto.IContextInfo } | null
    return inner?.contextInfo ?? null
  }

  const collectMentionedJids = (context: proto.IContextInfo | null): string[] => {
    if (!context?.mentionedJid?.length) return []
    return context.mentionedJid.filter((jid): jid is string => typeof jid === 'string')
  }

  const setMessageUsers = async (
    pool: NonNullable<ReturnType<typeof getMysqlPool>>,
    messageDbId: number,
    senderUserId: string | null,
    mentionedJids: string[],
    quotedJid: string | null,
    participantJids: string[]
  ) => {
    if (senderUserId) {
      await pool.execute(
        `INSERT IGNORE INTO message_users (
           connection_id,
           message_db_id,
           user_id,
           relation_type
         )
         VALUES (?, ?, UUID_TO_BIN(?, 1), 'sender')`,
        [connectionId, messageDbId, senderUserId]
      )
    }

    for (const jid of participantJids) {
      const userId = await ensureUserByIdentifiers(pool, [{ type: 'jid', value: jid }], null)
      if (!userId) continue
      await pool.execute(
        `INSERT IGNORE INTO message_users (
           connection_id,
           message_db_id,
           user_id,
           relation_type
         )
         VALUES (?, ?, UUID_TO_BIN(?, 1), 'participant')`,
        [connectionId, messageDbId, userId]
      )
    }

    for (const jid of mentionedJids) {
      const userId = await ensureUserByIdentifiers(pool, [{ type: 'jid', value: jid }], null)
      if (!userId) continue
      await pool.execute(
        `INSERT IGNORE INTO message_users (
           connection_id,
           message_db_id,
           user_id,
           relation_type
         )
         VALUES (?, ?, UUID_TO_BIN(?, 1), 'mentioned')`,
        [connectionId, messageDbId, userId]
      )
    }

    if (quotedJid) {
      const userId = await ensureUserByIdentifiers(pool, [{ type: 'jid', value: quotedJid }], null)
      if (userId) {
        await pool.execute(
          `INSERT IGNORE INTO message_users (
             connection_id,
             message_db_id,
             user_id,
             relation_type
           )
           VALUES (?, ?, UUID_TO_BIN(?, 1), 'quoted')`,
          [connectionId, messageDbId, userId]
        )
      }
    }
  }

  return {
    enabled: true,
    getMessage: async (key) =>
      safe(async (pool) => {
        const parsed = parseMessageKey(key)
        if (!parsed) return undefined
        type MessageRow = RowDataPacket & { data_json: unknown }
        const [rows] = await pool.execute<MessageRow[]>(
          `SELECT data_json
           FROM messages
           WHERE connection_id = ?
             AND chat_jid = ?
             AND message_id = ?
             AND from_me = ?
             AND deleted_at IS NULL
           ORDER BY id DESC
           LIMIT 1`,
          [connectionId, parsed.chatJid, parsed.messageId, parsed.fromMe]
        )
        const row = rows[0]
        return row ? deserialize<WAMessage>(row.data_json) : undefined
      }, undefined),
    setMessage: async (message) =>
      safe(async (pool) => {
        const key = message.key
        if (!key?.remoteJid || !key.id) return
        const senderJid =
          key.fromMe ? null : (key.participant ?? key.remoteJid ?? null)
        const normalizedSender = normalizeIdentifier(senderJid)
        const senderUserId = normalizedSender
          ? await ensureUserByIdentifiers(
              pool,
              [{ type: 'jid', value: normalizedSender }],
              null,
              message.pushName
                ? [{ type: 'pushName', value: message.pushName }]
                : undefined
            )
          : null
        const { content, type } = getNormalizedMessage(message)
        const textPreview = getMessageText(message)
        const timestamp = toNumber(message.messageTimestamp)
        const contentType = type ? String(type) : null
        const messageType =
          message.messageStubType !== undefined && message.messageStubType !== null
            ? String(message.messageStubType)
            : null
        const status =
          message.status !== undefined && message.status !== null ? String(message.status) : null
        const isForwarded = extractForwardedFlag(content, type)
        const isEphemeral = extractEphemeralFlag(message)
        const payload = serialize(message)

        await pool.execute(
          `INSERT INTO messages (
             connection_id,
             chat_jid,
             message_id,
             from_me,
             sender_user_id,
             timestamp,
             content_type,
             message_type,
             status,
             is_forwarded,
             is_ephemeral,
             text_preview,
             data_json
           )
           VALUES (?, ?, ?, ?, IF(?, UUID_TO_BIN(?, 1), NULL), ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             timestamp = VALUES(timestamp),
             content_type = VALUES(content_type),
             message_type = VALUES(message_type),
             status = VALUES(status),
             is_forwarded = VALUES(is_forwarded),
             is_ephemeral = VALUES(is_ephemeral),
             text_preview = VALUES(text_preview),
             data_json = VALUES(data_json),
             deleted_at = NULL`,
          [
            connectionId,
            key.remoteJid,
            key.id,
            key.fromMe ? 1 : 0,
            senderUserId ? 1 : 0,
            senderUserId,
            timestamp,
            contentType,
            messageType,
            status,
            toTinyInt(isForwarded),
            toTinyInt(isEphemeral),
            textPreview ? textPreview.slice(0, 512) : null,
            payload,
          ]
        )

        const normalized = getNormalizedMessage(message)
        const mediaInfo = extractMediaInfo(normalized.content, normalized.type)
        const messageText = getMessageText(message)
        if (mediaInfo || messageText || senderUserId) {
          const messageDbId = await getMessageDbId(pool, {
            chatJid: key.remoteJid,
            messageId: key.id,
            fromMe: key.fromMe ? 1 : 0,
          })
          if (messageDbId) {
            const contextInfo = getContextInfo(normalized.content, normalized.type)
            const mentionedJids = collectMentionedJids(contextInfo)
            const quotedJid =
              typeof contextInfo?.participant === 'string' ? contextInfo.participant : null
            const participantJids = contextInfo?.participant ? [contextInfo.participant] : []
            await setMessageUsers(
              pool,
              messageDbId,
              senderUserId,
              mentionedJids,
              quotedJid,
              participantJids
            )

            if (mediaInfo) {
              await pool.execute(
                `DELETE FROM message_media
                 WHERE connection_id = ?
                   AND message_db_id = ?`,
                [connectionId, messageDbId]
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
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
                `,
                [
                  connectionId,
                  messageDbId,
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
                [connectionId, messageDbId, messageText]
              )
            }
          }
        }
      }, undefined, { ensureConnection: true }),
    deleteMessage: async (chatJid, messageId, fromMe) =>
      safe(async (pool) => {
        await pool.execute(
          `UPDATE messages
           SET deleted_at = CURRENT_TIMESTAMP
           WHERE connection_id = ?
             AND chat_jid = ?
             AND message_id = ?
             AND from_me = ?`,
          [connectionId, chatJid, messageId, fromMe ? 1 : 0]
        )
      }, undefined, { ensureConnection: true }),
    deleteMessagesByJid: async (jid) =>
      safe(async (pool) => {
        await pool.execute(
          `UPDATE messages
           SET deleted_at = CURRENT_TIMESTAMP
           WHERE connection_id = ?
             AND chat_jid = ?`,
          [connectionId, jid]
        )
      }, undefined, { ensureConnection: true }),
    getGroup: async (id) =>
      safe(async (pool) => {
        type GroupRow = RowDataPacket & { data_json: unknown }
        const [rows] = await pool.execute<GroupRow[]>(
          `SELECT data_json
           FROM \`groups\`
           WHERE connection_id = ?
             AND jid = ?
           LIMIT 1`,
          [connectionId, id]
        )
        const row = rows[0]
        return row ? deserialize<GroupMetadata>(row.data_json) : undefined
      }, undefined),
    setGroup: async (id, group) =>
      safe(async (pool) => {
        try {
          const payload = serialize(group)
          const subject = group.subject ?? null
          if (group.owner) {
            const owner = normalizeIdentifier(group.owner)
            if (owner) {
              await ensureUserByIdentifiers(pool, [{ type: 'jid', value: owner }], null)
            }
          }
          await pool.execute(
            `INSERT INTO \`groups\` (
               connection_id,
               jid,
               subject,
               owner_user_id,
               announce,
               \`restrict\`,
               size,
               data_json
             )
             VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               subject = VALUES(subject),
               announce = VALUES(announce),
               \`restrict\` = VALUES(\`restrict\`),
               size = VALUES(size),
               data_json = VALUES(data_json)`,
            [
              connectionId,
              id,
              subject,
              toTinyInt(group.announce),
              toTinyInt(group.restrict),
              typeof group.size === 'number' ? group.size : null,
              payload,
            ]
          )
        } catch (error) {
          console.error('[sql-store] falha ao salvar groups', {
            id,
            subjectLen: group.subject ? group.subject.length : 0,
            err: error,
          })
        }
      }, undefined, { ensureConnection: true }),
    deleteGroup: async (id) =>
      safe(async (pool) => {
        await pool.execute(
          `DELETE FROM \`groups\` WHERE connection_id = ? AND jid = ?`,
          [connectionId, id]
        )
      }, undefined, { ensureConnection: true }),
    setGroupParticipants: async (groupJid, participants, options) =>
      safe(async (pool) => {
        if (!participants.length) {
          if (options?.replace) {
            await pool.execute(
              `DELETE FROM group_participants
               WHERE connection_id = ?
                 AND group_jid = ?`,
              [connectionId, groupJid]
            )
          }
          return
        }

        const participantJids: string[] = []
        for (const participant of participants) {
          const jid = normalizeIdentifier(participant.id)
          if (!jid) continue
          participantJids.push(jid)
          const userId = await ensureUserByIdentifiers(pool, [{ type: 'jid', value: jid }], null)
          if (!userId) continue
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
              groupJid,
              userId,
              jid,
              role,
              toTinyInt(isAdmin),
              toTinyInt(isSuper),
              serialize(participant),
            ]
          )
        }

        if (options?.replace) {
          const placeholders = participantJids.map(() => '?').join(', ')
          if (participantJids.length) {
            await pool.execute(
              `DELETE FROM group_participants
               WHERE connection_id = ?
                 AND group_jid = ?
                 AND participant_jid NOT IN (${placeholders})`,
              [connectionId, groupJid, ...participantJids]
            )
          }
        }
      }, undefined, { ensureConnection: true }),
    removeGroupParticipants: async (groupJid, participantJids) =>
      safe(async (pool) => {
        if (!participantJids.length) return
        const placeholders = participantJids.map(() => '?').join(', ')
        await pool.execute(
          `DELETE FROM group_participants
           WHERE connection_id = ?
             AND group_jid = ?
             AND participant_jid IN (${placeholders})`,
          [connectionId, groupJid, ...participantJids]
        )
      }, undefined, { ensureConnection: true }),
    setChat: async (id, chat) =>
      safe(async (pool) => {
        const payload = serialize(chat)
        const displayName: string | null =
          chat.name ?? (chat as { subject?: string | null }).subject ?? null
        const normalizedJid = normalizeIdentifier(id)
        if (normalizedJid) {
          await ensureUserByIdentifiers(
            pool,
            [{ type: 'jid', value: normalizedJid }],
            displayName,
            displayName ? [{ type: 'display_name', value: displayName }] : undefined
          )
        }
        const lastMessageTs: number | null = toNumber(
          (chat as { conversationTimestamp?: unknown }).conversationTimestamp
        )
        const rawUnreadCount = (chat as { unreadCount?: number }).unreadCount
        const unreadCount: number | null =
          typeof rawUnreadCount === 'number' ? rawUnreadCount : null
        const values: Array<string | number | null> = [
          connectionId,
          id,
          displayName,
          lastMessageTs,
          unreadCount,
          payload,
        ]
        await pool.execute(
          `INSERT INTO chats (
             connection_id,
             jid,
             display_name,
             last_message_ts,
             unread_count,
             data_json
           )
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             display_name = VALUES(display_name),
             last_message_ts = VALUES(last_message_ts),
             unread_count = VALUES(unread_count),
             data_json = VALUES(data_json),
             deleted_at = NULL`,
          values
        )
      }, undefined, { ensureConnection: true }),
    deleteChat: async (id) =>
      safe(async (pool) => {
        await pool.execute(
          `UPDATE chats
           SET deleted_at = CURRENT_TIMESTAMP
           WHERE connection_id = ?
             AND jid = ?`,
          [connectionId, id]
        )
      }, undefined, { ensureConnection: true }),
    setContact: async (id, contact) =>
      safe(async (pool) => {
        const payload = serialize(contact)
        const displayName = contact.name ?? contact.notify ?? null
        const normalizedJid = normalizeIdentifier(id)
        const aliases: Array<{
          type: 'pushName' | 'notify' | 'username' | 'display_name'
          value: string
        }> = []
        if (contact.notify) aliases.push({ type: 'notify', value: contact.notify })
        if (contact.name) aliases.push({ type: 'display_name', value: contact.name })
        if ((contact as { pushName?: string }).pushName) {
          aliases.push({
            type: 'pushName',
            value: (contact as { pushName?: string }).pushName as string,
          })
        }
        if (normalizedJid) {
          await ensureUserByIdentifiers(
            pool,
            [{ type: 'jid', value: normalizedJid }],
            displayName,
            aliases.length ? aliases : undefined
          )
        }
        await pool.execute(
          `INSERT INTO wa_contacts_cache (
             connection_id,
             jid,
             user_id,
             display_name,
             data_json
           )
           VALUES (?, ?, NULL, ?, ?)
           ON DUPLICATE KEY UPDATE
             display_name = VALUES(display_name),
             data_json = VALUES(data_json)`,
          [connectionId, id, displayName, payload]
        )
      }, undefined, { ensureConnection: true }),
    setLidMapping: async ({ lid, pn }) =>
      safe(async (pool) => {
        const normalizedPn = normalizeIdentifier(pn)
        const normalizedLid = normalizeIdentifier(lid)
        if (normalizedPn || normalizedLid) {
          const identifiers: Array<{ type: UserIdentifierType; value: string }> = []
          if (normalizedPn) identifiers.push({ type: 'pn', value: normalizedPn })
          if (normalizedLid) identifiers.push({ type: 'lid', value: normalizedLid })
          await ensureUserByIdentifiers(pool, identifiers, null)
        }
        await pool.execute(
          `INSERT INTO lid_mappings (
             connection_id,
             pn,
             lid,
             user_id
           )
           VALUES (?, ?, ?, NULL)
           ON DUPLICATE KEY UPDATE
             lid = VALUES(lid)`,
          [connectionId, pn, lid]
        )
      }, undefined, { ensureConnection: true }),
    getLidForPn: async (pn) =>
      safe(async (pool) => {
        type LidRow = RowDataPacket & { lid: string }
        const [rows] = await pool.execute<LidRow[]>(
          `SELECT lid
           FROM lid_mappings
           WHERE connection_id = ?
             AND pn = ?
           LIMIT 1`,
          [connectionId, pn]
        )
        const row = rows[0]
        return row?.lid ?? null
      }, null),
    getPnForLid: async (lid) =>
      safe(async (pool) => {
        type PnRow = RowDataPacket & { pn: string }
        const [rows] = await pool.execute<PnRow[]>(
          `SELECT pn
           FROM lid_mappings
           WHERE connection_id = ?
             AND lid = ?
           LIMIT 1`,
          [connectionId, lid]
        )
        const row = rows[0]
        return row?.pn ?? null
      }, null),
    recordMessageEvent: async (event) =>
      safe(async (pool) => {
        const messageDbId = await getMessageDbId(pool, {
          chatJid: event.key.chatJid,
          messageId: event.key.messageId,
          fromMe: event.key.fromMe ? 1 : 0,
        })
        const actorId = event.actorJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: event.actorJid }], null)
          : null
        const targetId = event.targetJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: event.targetJid }], null)
          : null
        await pool.execute(
          `INSERT INTO message_events (
             connection_id,
             chat_jid,
             message_id,
             event_type,
             actor_user_id,
             target_user_id,
             message_db_id,
             data_json
           )
           VALUES (?, ?, ?, ?, IF(?, UUID_TO_BIN(?, 1), NULL), IF(?, UUID_TO_BIN(?, 1), NULL), ?, ?)`,
          [
            connectionId,
            event.key.chatJid,
            event.key.messageId,
            event.type,
            actorId ? 1 : 0,
            actorId,
            targetId ? 1 : 0,
            targetId,
            messageDbId,
            event.data ? serialize(event.data) : null,
          ]
        )
      }, undefined, { ensureConnection: true }),
    recordEvent: async (event) =>
      safe(async (pool) => {
        const actorId = event.actorJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: event.actorJid }], null)
          : null
        const targetId = event.targetJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: event.targetJid }], null)
          : null
        const messageDbId = event.messageKey
          ? await getMessageDbId(pool, {
              chatJid: event.messageKey.chatJid,
              messageId: event.messageKey.messageId,
              fromMe: event.messageKey.fromMe ? 1 : 0,
            })
          : null
        await pool.execute(
          `INSERT INTO events_log (
             connection_id,
             event_type,
             actor_user_id,
             target_user_id,
             chat_jid,
             group_jid,
             message_db_id,
             data_json
           )
           VALUES (?, ?, IF(?, UUID_TO_BIN(?, 1), NULL), IF(?, UUID_TO_BIN(?, 1), NULL), ?, ?, ?, ?)`,
          [
            connectionId,
            event.type,
            actorId ? 1 : 0,
            actorId,
            targetId ? 1 : 0,
            targetId,
            event.chatJid ?? null,
            event.groupJid ?? null,
            messageDbId,
            event.data ? serialize(event.data) : null,
          ]
        )
      }, undefined, { ensureConnection: true }),
    setBlocklist: async (entry) =>
      safe(async (pool) => {
        const jid = normalizeIdentifier(entry.jid)
        if (!jid) return
        const userId = await ensureUserByIdentifiers(pool, [{ type: 'jid', value: jid }], null)
        const actorId = entry.actorJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: entry.actorJid }], null)
          : null
        await pool.execute(
          `INSERT INTO blocklist (
             connection_id,
             user_id,
             actor_user_id,
             jid,
             is_blocked,
             reason
           )
           VALUES (?, IF(?, UUID_TO_BIN(?, 1), NULL), IF(?, UUID_TO_BIN(?, 1), NULL), ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             user_id = VALUES(user_id),
             actor_user_id = VALUES(actor_user_id),
             is_blocked = VALUES(is_blocked),
             reason = VALUES(reason)`,
          [
            connectionId,
            userId ? 1 : 0,
            userId,
            actorId ? 1 : 0,
            actorId,
            jid,
            entry.isBlocked ? 1 : 0,
            entry.reason ?? null,
          ]
        )
      }, undefined, { ensureConnection: true }),
    recordGroupEvent: async (event) =>
      safe(async (pool) => {
        const groupJid = normalizeIdentifier(event.groupJid)
        if (!groupJid) return
        const actorId = event.actorJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: event.actorJid }], null)
          : null
        const targetId = event.targetJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: event.targetJid }], null)
          : null
        await pool.execute(
          `INSERT INTO group_events (
             connection_id,
             group_jid,
             event_type,
             actor_user_id,
             target_user_id,
             data_json
           )
           VALUES (?, ?, ?, IF(?, UUID_TO_BIN(?, 1), NULL), IF(?, UUID_TO_BIN(?, 1), NULL), ?)`,
          [
            connectionId,
            groupJid,
            event.eventType,
            actorId ? 1 : 0,
            actorId,
            targetId ? 1 : 0,
            targetId,
            event.data ? serialize(event.data) : null,
          ]
        )
      }, undefined, { ensureConnection: true }),
    recordGroupJoinRequest: async (entry) =>
      safe(async (pool) => {
        const groupJid = normalizeIdentifier(entry.groupJid)
        const userJid = normalizeIdentifier(entry.userJid)
        if (!groupJid || !userJid) return
        const userId = await ensureUserByIdentifiers(pool, [{ type: 'jid', value: userJid }], null)
        const actorId = entry.actorJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: entry.actorJid }], null)
          : null
        await pool.execute(
          `INSERT INTO group_join_requests (
             connection_id,
             group_jid,
             user_id,
             actor_user_id,
             action,
             method,
             data_json
           )
           VALUES (?, ?, UUID_TO_BIN(?, 1), IF(?, UUID_TO_BIN(?, 1), NULL), ?, ?, ?)`,
          [
            connectionId,
            groupJid,
            userId,
            actorId ? 1 : 0,
            actorId,
            entry.action,
            entry.method ?? null,
            entry.data ? serialize(entry.data) : null,
          ]
        )
      }, undefined, { ensureConnection: true }),
    recordNewsletter: async (entry) =>
      safe(async (pool) => {
        await pool.execute(
          `INSERT INTO newsletters (
             connection_id,
             newsletter_id,
             data_json
           )
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE data_json = VALUES(data_json)`,
          [connectionId, entry.newsletterId, serialize(entry.data ?? {})]
        )
      }, undefined, { ensureConnection: true }),
    recordNewsletterParticipant: async (entry) =>
      safe(async (pool) => {
        const userId = await ensureUserByIdentifiers(pool, [{ type: 'jid', value: entry.userJid }], null)
        await pool.execute(
          `INSERT INTO newsletter_participants (
             connection_id,
             newsletter_id,
             user_id,
             role,
             status
           )
           VALUES (?, ?, UUID_TO_BIN(?, 1), ?, ?)
           ON DUPLICATE KEY UPDATE
             role = VALUES(role),
             status = VALUES(status)`,
          [connectionId, entry.newsletterId, userId, entry.role ?? null, entry.status ?? null]
        )
      }, undefined, { ensureConnection: true }),
    recordNewsletterEvent: async (event) =>
      safe(async (pool) => {
        const actorId = event.actorJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: event.actorJid }], null)
          : null
        const targetId = event.targetJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: event.targetJid }], null)
          : null
        await pool.execute(
          `INSERT INTO newsletter_events (
             connection_id,
             newsletter_id,
             event_type,
             actor_user_id,
             target_user_id,
             data_json
           )
           VALUES (?, ?, ?, IF(?, UUID_TO_BIN(?, 1), NULL), IF(?, UUID_TO_BIN(?, 1), NULL), ?)`,
          [
            connectionId,
            event.newsletterId,
            event.eventType,
            actorId ? 1 : 0,
            actorId,
            targetId ? 1 : 0,
            targetId,
            event.data ? serialize(event.data) : null,
          ]
        )
      }, undefined, { ensureConnection: true }),
    recordMessageFailure: async (entry) =>
      safe(async (pool) => {
        const senderId = entry.senderJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: entry.senderJid }], null)
          : null
        const actorId = entry.actorJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: entry.actorJid }], null)
          : null
        await pool.execute(
          `INSERT INTO message_failures (
             connection_id,
             chat_jid,
             message_id,
             sender_user_id,
             actor_user_id,
             failure_reason,
             data_json
           )
           VALUES (?, ?, ?, IF(?, UUID_TO_BIN(?, 1), NULL), IF(?, UUID_TO_BIN(?, 1), NULL), ?, ?)`,
          [
            connectionId,
            entry.chatJid,
            entry.messageId ?? null,
            senderId ? 1 : 0,
            senderId,
            actorId ? 1 : 0,
            actorId,
            entry.reason ?? null,
            entry.data ? serialize(entry.data) : null,
          ]
        )
      }, undefined, { ensureConnection: true }),
    recordBotSession: async (entry) =>
      safe(async (pool) => {
        await pool.execute(
          `INSERT INTO bot_sessions (
             connection_id,
             device_label,
             platform,
             app_version,
             last_login,
             data_json
           )
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            connectionId,
            entry.deviceLabel ?? null,
            entry.platform ?? null,
            entry.appVersion ?? null,
            entry.lastLogin ?? null,
            entry.data ? serialize(entry.data) : null,
          ]
        )
      }, undefined, { ensureConnection: true }),
    recordCommandLog: async (entry) =>
      safe(async (pool) => {
        const actorId = entry.actorJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: entry.actorJid }], null)
          : null
        await pool.execute(
          `INSERT INTO commands_log (
             connection_id,
             actor_user_id,
             chat_jid,
             command_name,
             args_text,
             success,
             duration_ms,
             data_json
           )
           VALUES (?, IF(?, UUID_TO_BIN(?, 1), NULL), ?, ?, ?, ?, ?, ?)`,
          [
            connectionId,
            actorId ? 1 : 0,
            actorId,
            entry.chatJid,
            entry.commandName,
            entry.argsText ?? null,
            entry.success ? 1 : 0,
            entry.durationMs ?? null,
            entry.data ? serialize(entry.data) : null,
          ]
        )
      }, undefined, { ensureConnection: true }),
    setUserDevice: async (entry) =>
      safe(async (pool) => {
        const userId = await ensureUserByIdentifiers(pool, [{ type: 'jid', value: entry.userJid }], null)
        await pool.execute(
          `INSERT INTO user_devices (
             connection_id,
             user_id,
             device_id,
             data_json
           )
           VALUES (?, UUID_TO_BIN(?, 1), ?, ?)
           ON DUPLICATE KEY UPDATE
             data_json = VALUES(data_json)`,
          [connectionId, userId, entry.deviceId, entry.data ? serialize(entry.data) : null]
        )
      }, undefined, { ensureConnection: true }),
    setChatUser: async (chatJid, userJid, role) =>
      safe(async (pool) => {
        const normalizedChat = normalizeIdentifier(chatJid)
        const normalizedUser = normalizeIdentifier(userJid)
        if (!normalizedChat || !normalizedUser) return
        const userId = await ensureUserByIdentifiers(pool, [{ type: 'jid', value: normalizedUser }], null)
        if (!userId) return
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
      }, undefined, { ensureConnection: true }),
    deleteChatUser: async (chatJid, userJid) =>
      safe(async (pool) => {
        const normalizedChat = normalizeIdentifier(chatJid)
        const normalizedUser = normalizeIdentifier(userJid)
        if (!normalizedChat || !normalizedUser) return
        const userId = await ensureUserByIdentifiers(pool, [{ type: 'jid', value: normalizedUser }], null)
        if (!userId) return
        await pool.execute(
          `DELETE FROM chat_users
           WHERE connection_id = ?
             AND chat_jid = ?
             AND user_id = UUID_TO_BIN(?, 1)`,
          [connectionId, normalizedChat, userId]
        )
      }, undefined, { ensureConnection: true }),
    setLabel: async (label) =>
      safe(async (pool) => {
        const actorId = label.actorJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: label.actorJid }], null)
          : null
        await pool.execute(
          `INSERT INTO labels (
             connection_id,
             label_id,
             actor_user_id,
             name,
             color,
             data_json
           )
           VALUES (?, ?, IF(?, UUID_TO_BIN(?, 1), NULL), ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             actor_user_id = VALUES(actor_user_id),
             name = VALUES(name),
             color = VALUES(color),
             data_json = VALUES(data_json)`,
          [
            connectionId,
            label.id,
            actorId ? 1 : 0,
            actorId,
            label.name ?? null,
            label.color ?? null,
            label.data ? serialize(label.data) : null,
          ]
        )
      }, undefined, { ensureConnection: true }),
    setLabelAssociation: async (association) =>
      safe(async (pool) => {
        const actorId = association.actorJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: association.actorJid }], null)
          : null
        const targetId = association.targetJid
          ? await ensureUserByIdentifiers(pool, [{ type: 'jid', value: association.targetJid }], null)
          : null
        const messageDbId = association.messageKey
          ? await getMessageDbId(pool, {
              chatJid: association.messageKey.chatJid,
              messageId: association.messageKey.messageId,
              fromMe: association.messageKey.fromMe ? 1 : 0,
            })
          : null
        await pool.execute(
          `INSERT INTO label_associations (
             connection_id,
             label_id,
             actor_user_id,
             association_type,
             chat_jid,
             message_db_id,
             target_jid,
             data_json
           )
           VALUES (?, ?, IF(?, UUID_TO_BIN(?, 1), NULL), ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             actor_user_id = VALUES(actor_user_id),
             chat_jid = VALUES(chat_jid),
             message_db_id = VALUES(message_db_id),
             target_jid = VALUES(target_jid),
             data_json = VALUES(data_json)`,
          [
            connectionId,
            association.labelId,
            actorId ? 1 : 0,
            actorId,
            association.associationType,
            association.chatJid ?? null,
            messageDbId,
            association.targetJid ?? null,
            association.data ? serialize(association.data) : null,
          ]
        )
      }, undefined, { ensureConnection: true }),
  }
}
