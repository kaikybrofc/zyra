import {
  BufferJSON,
  type Chat,
  type Contact,
  type GroupMetadata,
  type LIDMapping,
  type WAMessage,
} from '@whiskeysockets/baileys'
import { config } from '../config/index.js'
import { getRedisClient } from '../core/redis/client.js'

const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)
const deserialize = <T>(value: string) => JSON.parse(value, BufferJSON.reviver) as T

const storePrefix = `${config.redisPrefix ?? 'zyra:conexao'}:store`
const storeKeys = {
  messages: `${storePrefix}:messages`,
  groups: `${storePrefix}:groups`,
  chats: `${storePrefix}:chats`,
  contacts: `${storePrefix}:contacts`,
  lidByPn: `${storePrefix}:lid:pn`,
  pnByLid: `${storePrefix}:lid:lid`,
}

export type RedisStore = {
  enabled: boolean
  getMessage: (key: string) => Promise<WAMessage | undefined>
  setMessage: (key: string, message: WAMessage) => Promise<void>
  deleteMessage: (key: string) => Promise<void>
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

export function createRedisStore(): RedisStore {
  if (!config.redisUrl) {
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

  const safe = async <T>(fn: (client: Awaited<ReturnType<typeof getRedisClient>>) => Promise<T>, fallback: T): Promise<T> => {
    try {
      const client = await getRedisClient()
      return await fn(client)
    } catch {
      return fallback
    }
  }

  return {
    enabled: true,
    getMessage: async (key) =>
      safe(async (client) => {
        const raw = await client.hGet(storeKeys.messages, key)
        return raw ? deserialize<WAMessage>(raw) : undefined
      }, undefined),
    setMessage: async (key, message) =>
      safe(async (client) => {
        await client.hSet(storeKeys.messages, key, serialize(message))
      }, undefined),
    deleteMessage: async (key) =>
      safe(async (client) => {
        await client.hDel(storeKeys.messages, key)
      }, undefined),
    deleteMessagesByJid: async (jid) =>
      safe(async (client) => {
        const keys = await client.hKeys(storeKeys.messages)
        const prefix = `${jid}:`
        const toDelete = keys.filter((key) => key.startsWith(prefix))
        if (toDelete.length) {
          await client.hDel(storeKeys.messages, toDelete)
        }
      }, undefined),
    getGroup: async (id) =>
      safe(async (client) => {
        const raw = await client.hGet(storeKeys.groups, id)
        return raw ? deserialize<GroupMetadata>(raw) : undefined
      }, undefined),
    setGroup: async (id, group) =>
      safe(async (client) => {
        await client.hSet(storeKeys.groups, id, serialize(group))
      }, undefined),
    deleteGroup: async (id) =>
      safe(async (client) => {
        await client.hDel(storeKeys.groups, id)
      }, undefined),
    setChat: async (id, chat) =>
      safe(async (client) => {
        await client.hSet(storeKeys.chats, id, serialize(chat))
      }, undefined),
    deleteChat: async (id) =>
      safe(async (client) => {
        await client.hDel(storeKeys.chats, id)
      }, undefined),
    setContact: async (id, contact) =>
      safe(async (client) => {
        await client.hSet(storeKeys.contacts, id, serialize(contact))
      }, undefined),
    setLidMapping: async ({ lid, pn }) =>
      safe(async (client) => {
        await client.hSet(storeKeys.lidByPn, pn, lid)
        await client.hSet(storeKeys.pnByLid, lid, pn)
      }, undefined),
    getLidForPn: async (pn) =>
      safe(async (client) => {
        const lid = await client.hGet(storeKeys.lidByPn, pn)
        return lid ?? null
      }, null),
    getPnForLid: async (lid) =>
      safe(async (client) => {
        const pn = await client.hGet(storeKeys.pnByLid, lid)
        return pn ?? null
      }, null),
  }
}
