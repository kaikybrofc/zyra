import {
  BufferJSON,
  type Chat,
  type Contact,
  type GroupMetadata,
  type LIDMapping,
  type WAMessage,
  type proto,
} from '@whiskeysockets/baileys'
import { config } from '../config/index.js'
import { getMysqlPool } from '../core/db/mysql.js'
import { getMessageText, getNormalizedMessage } from '../utils/message.js'

const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)
const deserialize = <T>(value: string) => JSON.parse(value, BufferJSON.reviver) as T

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
  const contextInfo = (inner as { contextInfo?: proto.Message.IContextInfo }).contextInfo
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
  setChat: (id: string, chat: Chat) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  setContact: (id: string, contact: Contact) => Promise<void>
  setLidMapping: (mapping: LIDMapping) => Promise<void>
  getLidForPn: (pn: string) => Promise<string | null>
  getPnForLid: (lid: string) => Promise<string | null>
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
      setChat: async () => undefined,
      deleteChat: async () => undefined,
      setContact: async () => undefined,
      setLidMapping: async () => undefined,
      getLidForPn: async () => null,
      getPnForLid: async () => null,
    }
  }

  const safe = async <T>(
    fn: (pool: NonNullable<ReturnType<typeof getMysqlPool>>) => Promise<T>,
    fallback: T
  ): Promise<T> => {
    try {
      const pool = getMysqlPool()
      if (!pool) return fallback
      return await fn(pool)
    } catch {
      return fallback
    }
  }

  const connectionId = config.connectionId

  return {
    enabled: true,
    getMessage: async (key) =>
      safe(async (pool) => {
        const parsed = parseMessageKey(key)
        if (!parsed) return undefined
        const [rows] = await pool.execute<
          Array<{ data_json: string }>
        >(
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
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
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
      }, undefined),
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
      }, undefined),
    deleteMessagesByJid: async (jid) =>
      safe(async (pool) => {
        await pool.execute(
          `UPDATE messages
           SET deleted_at = CURRENT_TIMESTAMP
           WHERE connection_id = ?
             AND chat_jid = ?`,
          [connectionId, jid]
        )
      }, undefined),
    getGroup: async (id) =>
      safe(async (pool) => {
        const [rows] = await pool.execute<Array<{ data_json: string }>>(
          `SELECT data_json
           FROM groups
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
        const payload = serialize(group)
        const subject = group.subject ?? null
        await pool.execute(
          `INSERT INTO groups (
             connection_id,
             jid,
             subject,
             owner_user_id,
             announce,
             restrict,
             size,
             data_json
           )
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             subject = VALUES(subject),
             announce = VALUES(announce),
             restrict = VALUES(restrict),
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
      }, undefined),
    deleteGroup: async (id) =>
      safe(async (pool) => {
        await pool.execute(
          `DELETE FROM groups WHERE connection_id = ? AND jid = ?`,
          [connectionId, id]
        )
      }, undefined),
    setChat: async (id, chat) =>
      safe(async (pool) => {
        const payload = serialize(chat)
        const displayName = chat.name ?? (chat as { subject?: string }).subject ?? null
        const lastMessageTs = toNumber((chat as { conversationTimestamp?: unknown }).conversationTimestamp)
        const unreadCount =
          typeof (chat as { unreadCount?: number }).unreadCount === 'number'
            ? (chat as { unreadCount?: number }).unreadCount
            : null
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
          [connectionId, id, displayName, lastMessageTs, unreadCount, payload]
        )
      }, undefined),
    deleteChat: async (id) =>
      safe(async (pool) => {
        await pool.execute(
          `UPDATE chats
           SET deleted_at = CURRENT_TIMESTAMP
           WHERE connection_id = ?
             AND jid = ?`,
          [connectionId, id]
        )
      }, undefined),
    setContact: async (id, contact) =>
      safe(async (pool) => {
        const payload = serialize(contact)
        const displayName = contact.name ?? contact.notify ?? null
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
      }, undefined),
    setLidMapping: async ({ lid, pn }) =>
      safe(async (pool) => {
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
      }, undefined),
    getLidForPn: async (pn) =>
      safe(async (pool) => {
        const [rows] = await pool.execute<Array<{ lid: string }>>(
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
        const [rows] = await pool.execute<Array<{ pn: string }>>(
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
  }
}
