import { BufferJSON, type CacheStore, type PossiblyExtendedCacheStore } from '@whiskeysockets/baileys'
import { config } from '../config/index.js'
import { getRedisClient } from '../core/redis/client.js'

type MemoryEntry<T> = {
  value: T
  expiresAt: number | null
}

const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)
const deserialize = <T>(value: string) => JSON.parse(value, BufferJSON.reviver) as T

const createMemoryCacheStore = (ttlSeconds: number) => {
  const store = new Map<string, MemoryEntry<unknown>>()
  const ttlMs = ttlSeconds > 0 ? ttlSeconds * 1000 : 0

  const isExpired = (entry: MemoryEntry<unknown>) =>
    entry.expiresAt !== null && Date.now() >= entry.expiresAt

  return {
    get: <T>(key: string): T | undefined => {
      const entry = store.get(key)
      if (!entry) return undefined
      if (isExpired(entry)) {
        store.delete(key)
        return undefined
      }
      return entry.value as T
    },
    set: <T>(key: string, value: T) => {
      const expiresAt = ttlMs ? Date.now() + ttlMs : null
      store.set(key, { value, expiresAt })
    },
    del: (key: string) => {
      store.delete(key)
    },
    flushAll: () => {
      store.clear()
    },
  }
}

const createMemoryExtendedCacheStore = (ttlSeconds: number): PossiblyExtendedCacheStore => {
  const base = createMemoryCacheStore(ttlSeconds)
  return {
    ...base,
    mget: async <T>(keys: string[]) => {
      const result: Record<string, T | undefined> = {}
      for (const key of keys) {
        result[key] = base.get<T>(key)
      }
      return result
    },
    mset: async <T>(entries: { key: string; value: T }[]) => {
      for (const entry of entries) {
        base.set(entry.key, entry.value)
      }
    },
    mdel: async (keys: string[]) => {
      for (const key of keys) {
        base.del(key)
      }
    },
  }
}

const createRedisCacheStore = (prefix: string, ttlSeconds: number): CacheStore => {
  return {
    get: async <T>(key: string): Promise<T> => {
      const client = await getRedisClient()
      const value = await client.get(`${prefix}:${key}`)
      return (value ? deserialize<T>(value) : undefined) as T
    },
    set: async <T>(key: string, value: T) => {
      const client = await getRedisClient()
      await client.set(`${prefix}:${key}`, serialize(value), { EX: ttlSeconds })
    },
    del: async (key: string) => {
      const client = await getRedisClient()
      await client.del(`${prefix}:${key}`)
    },
    flushAll: async () => {
      const client = await getRedisClient()
      const keys = await client.keys(`${prefix}:*`)
      if (keys.length) {
        await client.del(keys)
      }
    },
  }
}

const createRedisExtendedCacheStore = (
  prefix: string,
  ttlSeconds: number
): PossiblyExtendedCacheStore => {
  const base = createRedisCacheStore(prefix, ttlSeconds)
  return {
    ...base,
    mget: async <T>(keys: string[]) => {
      const client = await getRedisClient()
      const fullKeys = keys.map((key) => `${prefix}:${key}`)
      const values = await client.mGet(fullKeys)
      const result: Record<string, T | undefined> = {}
      for (const [index, raw] of values.entries()) {
        const key = keys[index]
        if (!key) continue
        result[key] = raw ? deserialize<T>(raw) : undefined
      }
      return result
    },
    mset: async <T>(entries: { key: string; value: T }[]) => {
      const client = await getRedisClient()
      const pipeline = client.multi()
      for (const entry of entries) {
        pipeline.set(`${prefix}:${entry.key}`, serialize(entry.value), { EX: ttlSeconds })
      }
      await pipeline.exec()
    },
    mdel: async (keys: string[]) => {
      const client = await getRedisClient()
      const fullKeys = keys.map((key) => `${prefix}:${key}`)
      if (fullKeys.length) {
        await client.del(fullKeys)
      }
    },
  }
}

/**
 * Monta o prefixo do cache considerando o connection_id.
 */
const buildCachePrefix = (name: string, connectionId?: string): string => {
  const base = config.redisPrefix ?? 'zyra:conexao'
  const resolvedId = connectionId ?? config.connectionId
  const prefix = resolvedId && !base.endsWith(`:${resolvedId}`) ? `${base}:${resolvedId}` : base
  return `${prefix}:cache:${name}`
}

/**
 * Cria um cache simples (Redis ou memoria) com TTL.
 */
export const createCacheStore = (
  name: string,
  ttlSeconds: number,
  connectionId?: string
): CacheStore => {
  const prefix = buildCachePrefix(name, connectionId)
  if (config.redisUrl) {
    return createRedisCacheStore(prefix, ttlSeconds)
  }
  return createMemoryCacheStore(ttlSeconds)
}

/**
 * Cria um cache estendido (Redis ou memoria) com TTL e operacoes em lote.
 */
export const createExtendedCacheStore = (
  name: string,
  ttlSeconds: number,
  connectionId?: string
): PossiblyExtendedCacheStore => {
  const prefix = buildCachePrefix(name, connectionId)
  if (config.redisUrl) {
    return createRedisExtendedCacheStore(prefix, ttlSeconds)
  }
  return createMemoryExtendedCacheStore(ttlSeconds)
}
