import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BufferJSON, initAuthCreds, type AuthenticationCreds } from '@whiskeysockets/baileys'
import { join } from 'node:path'

const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)

const fileStore = new Map<string, string>()
const readFile = vi.fn(async (path: string) => {
  const key = String(path)
  if (!fileStore.has(key)) {
    throw new Error('ENOENT')
  }
  return fileStore.get(key)
})
const writeFile = vi.fn(async (path: string, data: unknown) => {
  fileStore.set(String(path), String(data))
})
const mkdir = vi.fn(async () => undefined)
const unlink = vi.fn(async () => undefined)

vi.mock('node:fs/promises', () => ({
  readFile,
  writeFile,
  mkdir,
  unlink,
}))

const mockConfig = {
  authDir: '/tmp/auth-test',
  printQRInTerminal: false,
  logLevel: 'info',
  redisUrl: 'redis://test',
  redisPrefix: 'test:conexao',
  mysqlUrl: 'mysql://test',
  mysqlRetryIntervalMs: 1000,
  connectionId: 'default',
  allowOwnMessages: false,
  authPersistKeysOnDisk: false,
}

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))

const getRedisNamespace = (connectionId?: string) => `test:${connectionId ?? 'default'}`
const getLegacyRedisNamespace = () => null

vi.mock('../src/core/redis/prefix.js', () => ({
  getRedisNamespace,
  getLegacyRedisNamespace,
}))

const redisStore = new Map<string, string>()
const redisClient = {
  get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => {
    redisStore.set(key, value)
  }),
  hmGet: vi.fn(async (_key: string, ids: string[]) => ids.map(() => null)),
  hSet: vi.fn(async () => undefined),
  hDel: vi.fn(async () => undefined),
  multi: vi.fn(() => ({
    hSet: vi.fn().mockReturnThis(),
    hDel: vi.fn().mockReturnThis(),
    exec: vi.fn(async () => []),
  })),
}

vi.mock('../src/core/redis/client.js', () => ({
  getRedisClient: vi.fn(async () => redisClient),
}))

const queries: Array<{ sql: string; params?: unknown[] }> = []
let mysqlCredsSerialized: string | null = null

const pool = {
  execute: vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params })
    if (sql.includes('SELECT creds_json')) {
      const rows = mysqlCredsSerialized ? [{ creds_json: mysqlCredsSerialized }] : []
      return [rows as unknown[], []]
    }
    return [[], []]
  }),
}

const mysqlPoolRef: { value: typeof pool | null } = { value: pool }

vi.mock('../src/core/db/mysql.js', () => ({
  getMysqlPool: () => mysqlPoolRef.value,
}))

vi.mock('../src/core/db/connection.js', () => ({
  ensureMysqlConnection: vi.fn(async () => undefined),
}))

describe('mysql-auth-state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    fileStore.clear()
    redisStore.clear()
    queries.length = 0
    mysqlCredsSerialized = null
    mysqlPoolRef.value = pool
    pool.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params })
      if (sql.includes('SELECT creds_json')) {
        const rows = mysqlCredsSerialized ? [{ creds_json: mysqlCredsSerialized }] : []
        return [rows as unknown[], []]
      }
      return [[], []]
    })
  })

  it('prioriza redis quando o mysql esta incompleto', async () => {
    const good = initAuthCreds()
    const bad = { ...good, noiseKey: undefined } as unknown as AuthenticationCreds

    mysqlCredsSerialized = serialize(bad)
    const credsKey = `${getRedisNamespace('conn')}:creds`
    redisStore.set(credsKey, serialize(good))

    const { useMysqlAuthState } = await import('../src/core/auth/mysql-auth-state.ts')
    const { state } = await useMysqlAuthState('conn')

    expect(state.creds.advSecretKey).toBe(good.advSecretKey)

    const insert = queries.find((query) => query.sql.includes('INSERT INTO auth_creds'))
    expect(insert?.params?.[1]).toBe(serialize(good))
  })

  it('mantem mysql quando completo e sincroniza redis', async () => {
    const mysqlCreds = initAuthCreds()
    const redisCreds = initAuthCreds()

    mysqlCredsSerialized = serialize(mysqlCreds)
    const credsKey = `${getRedisNamespace('conn')}:creds`
    redisStore.set(credsKey, serialize(redisCreds))

    const { useMysqlAuthState } = await import('../src/core/auth/mysql-auth-state.ts')
    const { state } = await useMysqlAuthState('conn')

    expect(state.creds.advSecretKey).toBe(mysqlCreds.advSecretKey)
    expect(redisStore.get(credsKey)).toBe(serialize(mysqlCreds))
  })

  it('atualiza disco quando necessario', async () => {
    const mysqlCreds = initAuthCreds()
    mysqlCredsSerialized = serialize(mysqlCreds)

    const credsPath = join(mockConfig.authDir, 'conn', 'creds.json')
    fileStore.set(credsPath, serialize(initAuthCreds()))

    const { useMysqlAuthState } = await import('../src/core/auth/mysql-auth-state.ts')
    await useMysqlAuthState('conn')

    expect(fileStore.get(credsPath)).toBe(serialize(mysqlCreds))
  })

  it('faz fallback para redis/disco quando mysql esta indisponivel', async () => {
    mysqlPoolRef.value = null
    const redisCreds = initAuthCreds()
    const credsKey = `${getRedisNamespace('conn')}:creds`
    redisStore.set(credsKey, serialize(redisCreds))

    const { useMysqlAuthState } = await import('../src/core/auth/mysql-auth-state.ts')
    const { state } = await useMysqlAuthState('conn')

    expect(state.creds.advSecretKey).toBe(redisCreds.advSecretKey)
    expect(queries.length).toBe(0)
  })

  it('faz fallback quando mysql falha durante leitura', async () => {
    pool.execute.mockImplementationOnce(async () => {
      throw new Error('mysql down')
    })
    const redisCreds = initAuthCreds()
    const credsKey = `${getRedisNamespace('conn')}:creds`
    redisStore.set(credsKey, serialize(redisCreds))

    const { useMysqlAuthState } = await import('../src/core/auth/mysql-auth-state.ts')
    const { state } = await useMysqlAuthState('conn')

    expect(state.creds.advSecretKey).toBe(redisCreds.advSecretKey)
  })
})
