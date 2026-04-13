import { beforeEach, describe, expect, it, vi } from 'vitest'

let getRedisClientMock: ReturnType<typeof vi.fn>
let getRedisNamespaceMock: ReturnType<typeof vi.fn>

const mockConfig = {
  redisUrl: null as string | null,
}

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/core/redis/client.js', () => ({
  getRedisClient: (...args: unknown[]) => getRedisClientMock(...args),
}))
vi.mock('../src/core/redis/prefix.js', () => ({
  getRedisNamespace: (...args: unknown[]) => getRedisNamespaceMock(...args),
}))

const createRedisClient = () => {
  const hashes = new Map<string, Map<string, string>>()
  const ensure = (key: string) => {
    const hash = hashes.get(key) ?? new Map<string, string>()
    hashes.set(key, hash)
    return hash
  }

  return {
    hashes,
    client: {
      hGet: vi.fn(async (hash: string, field: string) => ensure(hash).get(field) ?? null),
      hSet: vi.fn(async (hash: string, field: string, value: string) => {
        ensure(hash).set(field, value)
        return 1
      }),
      hDel: vi.fn(async (hash: string, fields: string | string[]) => {
        const list = Array.isArray(fields) ? fields : [fields]
        const target = ensure(hash)
        for (const field of list) target.delete(field)
        return list.length
      }),
      hKeys: vi.fn(async (hash: string) => Array.from(ensure(hash).keys())),
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mockConfig.redisUrl = null
  getRedisClientMock = vi.fn()
  getRedisNamespaceMock = vi.fn(() => 'zyra:tenant')
})

describe('redis-store', () => {
  it('retorna store desabilitada quando redis nao esta configurado', async () => {
    const { createRedisStore } = await import('../src/store/redis-store.ts')
    const store = createRedisStore('tenant')

    expect(store.enabled).toBe(false)
    await expect(store.getMessage('msg')).resolves.toBeUndefined()
    await expect(store.getLidForPn('5511')).resolves.toBeNull()
  })

  it('persiste mensagens, grupos e mappings no redis', async () => {
    mockConfig.redisUrl = 'redis://test'
    const redis = createRedisClient()
    getRedisClientMock.mockResolvedValue(redis.client)

    const { createRedisStore } = await import('../src/store/redis-store.ts')
    const store = createRedisStore('tenant')

    const messageKey = 'chat@s.whatsapp.net::0:msg-1'
    const message = {
      key: { remoteJid: 'chat@s.whatsapp.net', id: 'msg-1', fromMe: false },
      message: { conversation: 'oi' },
    }

    await store.setMessage(messageKey, message as never)
    await store.setGroup('group@g.us', { id: 'group@g.us', subject: 'Grupo' } as never)
    await store.setChat('chat@s.whatsapp.net', { id: 'chat@s.whatsapp.net', unreadCount: 1 } as never)
    await store.setContact('user@s.whatsapp.net', { id: 'user@s.whatsapp.net', name: 'User' } as never)
    await store.setLidMapping({ lid: '551199@lid', pn: '551199' } as never)

    expect(await store.getMessage(messageKey)).toEqual(message)
    expect(await store.getGroup('group@g.us')).toEqual({ id: 'group@g.us', subject: 'Grupo' })
    expect(await store.getLidForPn('551199')).toBe('551199@lid')
    expect(await store.getPnForLid('551199@lid')).toBe('551199')

    await store.deleteMessage(messageKey)
    expect(await store.getMessage(messageKey)).toBeUndefined()
  })

  it('remove mensagens por jid e usa fallback seguro em caso de falha', async () => {
    mockConfig.redisUrl = 'redis://test'
    const redis = createRedisClient()
    getRedisClientMock.mockResolvedValue(redis.client)

    const { createRedisStore } = await import('../src/store/redis-store.ts')
    const store = createRedisStore('tenant')

    await store.setMessage('chat@s.whatsapp.net::0:1', { key: { id: '1' } } as never)
    await store.setMessage('chat@s.whatsapp.net:user@s.whatsapp.net:0:2', { key: { id: '2' } } as never)
    await store.setMessage('other@s.whatsapp.net::0:3', { key: { id: '3' } } as never)

    await store.deleteMessagesByJid('chat@s.whatsapp.net')

    expect(redis.client.hDel).toHaveBeenCalledWith(
      'zyra:tenant:store:messages',
      ['chat@s.whatsapp.net::0:1', 'chat@s.whatsapp.net:user@s.whatsapp.net:0:2']
    )

    getRedisClientMock.mockRejectedValueOnce(new Error('redis down'))
    await expect(store.getMessage('missing')).resolves.toBeUndefined()
    await expect(store.getPnForLid('x')).resolves.toBeNull()
  })
})
