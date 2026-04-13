import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let getRedisClientMock: ReturnType<typeof vi.fn>

const mockConfig = {
  redisUrl: null as string | null,
  redisPrefix: 'zyra:conexao',
  connectionId: 'default',
}

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/core/redis/client.js', () => ({
  getRedisClient: (...args: unknown[]) => getRedisClientMock(...args),
}))

const createRedisClient = () => {
  const values = new Map<string, string>()
  const multiSetCalls: Array<{ key: string; value: string; options: unknown }> = []

  return {
    values,
    multiSetCalls,
    client: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, options?: unknown) => {
        values.set(key, value)
        multiSetCalls.push({ key, value, options })
        return 'OK'
      }),
      del: vi.fn(async (keys: string | string[]) => {
        const list = Array.isArray(keys) ? keys : [keys]
        for (const key of list) {
          values.delete(key)
        }
        return list.length
      }),
      keys: vi.fn(async (pattern: string) => {
        const prefix = pattern.replace(/\*$/, '')
        return Array.from(values.keys()).filter((key) => key.startsWith(prefix))
      }),
      mGet: vi.fn(async (keys: string[]) => keys.map((key) => values.get(key) ?? null)),
      multi: vi.fn(() => {
        const pipelineEntries: Array<{ key: string; value: string; options: unknown }> = []
        return {
          set: (key: string, value: string, options?: unknown) => {
            pipelineEntries.push({ key, value, options })
            return undefined
          },
          exec: vi.fn(async () => {
            for (const entry of pipelineEntries) {
              values.set(entry.key, entry.value)
              multiSetCalls.push(entry)
            }
            return []
          }),
        }
      }),
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useRealTimers()
  mockConfig.redisUrl = null
  mockConfig.redisPrefix = 'zyra:conexao'
  mockConfig.connectionId = 'default'
  getRedisClientMock = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('cache-store', () => {
  it('usa cache em memoria com TTL e operacoes em lote', async () => {
    vi.useFakeTimers()

    const { createCacheStore, createExtendedCacheStore } = await import('../src/store/cache-store.ts')
    const cache = createCacheStore('media', 1, 'conn')
    const extended = createExtendedCacheStore('devices', 1, 'conn')

    cache.set('a', { ok: true })
    expect(cache.get<{ ok: boolean }>('a')).toEqual({ ok: true })

    await extended.mset([
      { key: 'k1', value: { id: 1 } },
      { key: 'k2', value: { id: 2 } },
    ])
    expect(await extended.mget<{ id: number }>(['k1', 'k2', 'k3'])).toEqual({
      k1: { id: 1 },
      k2: { id: 2 },
      k3: undefined,
    })

    await vi.advanceTimersByTimeAsync(1001)

    expect(cache.get('a')).toBeUndefined()
    expect(await extended.mget(['k1', 'k2'])).toEqual({
      k1: undefined,
      k2: undefined,
    })

    cache.set('b', 1)
    cache.flushAll()
    expect(cache.get('b')).toBeUndefined()

    await extended.mset([{ key: 'k4', value: { id: 4 } }])
    await extended.mdel(['k4'])
    expect(await extended.mget(['k4'])).toEqual({ k4: undefined })
  })

  it('usa redis quando configurado e aplica prefixo com connectionId', async () => {
    mockConfig.redisUrl = 'redis://test'
    mockConfig.redisPrefix = 'suite:cache'

    const redis = createRedisClient()
    getRedisClientMock.mockResolvedValue(redis.client)

    const { createCacheStore, createExtendedCacheStore } = await import('../src/store/cache-store.ts')
    const cache = createCacheStore('media', 60, 'tenant-1')
    const extended = createExtendedCacheStore('devices', 30, 'tenant-1')

    await cache.set('msg', { id: '1' })
    expect(redis.client.set).toHaveBeenCalledWith(
      'suite:cache:tenant-1:cache:media:msg',
      expect.any(String),
      { EX: 60 }
    )
    expect(await cache.get<{ id: string }>('msg')).toEqual({ id: '1' })

    await extended.mset([
      { key: 'a', value: { n: 1 } },
      { key: 'b', value: { n: 2 } },
    ])
    expect(await extended.mget<{ n: number }>(['a', 'b'])).toEqual({
      a: { n: 1 },
      b: { n: 2 },
    })

    await extended.mdel(['a'])
    expect(redis.client.del).toHaveBeenCalledWith(['suite:cache:tenant-1:cache:devices:a'])

    await cache.flushAll()
    expect(redis.client.keys).toHaveBeenCalledWith('suite:cache:tenant-1:cache:media:*')
  })
})
