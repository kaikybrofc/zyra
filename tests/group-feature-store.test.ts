import { beforeEach, describe, expect, it, vi } from 'vitest'

const memFiles = new Map<string, string>()

const { mockConfig, mockPool, mockRedisClient } = vi.hoisted(() => ({
  mockConfig: {
    mysqlUrl: 'mysql://user:pass@localhost:3306/zyra',
    redisUrl: 'redis://localhost:6379',
    connectionId: 'default',
    redisPrefix: 'zyra:conexao',
  },
  mockPool: {
    execute: vi.fn(),
  },
  mockRedisClient: {
    hGet: vi.fn(),
    hSet: vi.fn(),
  },
}))

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/core/db/mysql.js', () => ({ getMysqlPool: vi.fn(() => mockPool) }))
vi.mock('../src/core/redis/client.js', () => ({ getRedisClient: vi.fn(async () => mockRedisClient) }))
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async (file: string) => {
    const value = memFiles.get(file)
    if (value === undefined) throw new Error('ENOENT')
    return value
  }),
  writeFile: vi.fn(async (file: string, content: string) => {
    memFiles.set(file, content)
  }),
}))

describe('groupFeatureStore', () => {
  beforeEach(() => {
    vi.resetModules()
    memFiles.clear()
    mockPool.execute.mockReset().mockResolvedValue([[]])
    mockRedisClient.hGet.mockReset().mockResolvedValue(null)
    mockRedisClient.hSet.mockReset().mockResolvedValue(undefined)
  })

  it('persiste estado em mysql, redis e arquivo fallback', async () => {
    const { groupFeatureStore } = await import('../src/store/group-feature-store.ts')

    await groupFeatureStore.setAntilinkEnabled('grupo@g.us', true)

    expect(mockPool.execute).toHaveBeenCalled()
    expect(mockRedisClient.hSet).toHaveBeenCalledWith('zyra:conexao:default:features:group', 'grupo@g.us', expect.stringContaining('"antilink":true'))
    const fallback = [...memFiles.values()].join('\n')
    expect(fallback).toContain('grupo@g.us')
    expect(fallback).toContain('"antilink": true')
  })

  it('consulta sql primeiro e usa redis como fallback quando sql nao tiver estado', async () => {
    mockRedisClient.hGet.mockResolvedValue(JSON.stringify({ antilink: true, antilinkAllowedDomains: ['exemplo.com'] }))

    const { groupFeatureStore } = await import('../src/store/group-feature-store.ts')
    const enabled = await groupFeatureStore.isAntilinkEnabled('grupo@g.us')
    const domains = await groupFeatureStore.getAntilinkAllowedDomains('grupo@g.us')

    expect(enabled).toBe(true)
    expect(domains).toEqual(['exemplo.com'])
    expect(mockPool.execute).toHaveBeenCalled()
  })
})
