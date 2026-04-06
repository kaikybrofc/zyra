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
  mysqlUrl: null,
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

describe('redis-auth-state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fileStore.clear()
    redisStore.clear()
  })

  it('prioriza redis e atualiza disco quando necessario', async () => {
    const redisCreds = initAuthCreds()
    const diskCreds = initAuthCreds()
    const credsKey = `${getRedisNamespace('conn')}:creds`
    redisStore.set(credsKey, serialize(redisCreds))

    const credsPath = join(mockConfig.authDir, 'creds.json')
    fileStore.set(credsPath, serialize(diskCreds))

    const { useRedisAuthState } = await import('../src/core/auth/redis-auth-state.ts')
    await useRedisAuthState('conn')

    expect(fileStore.get(credsPath)).toBe(serialize(redisCreds))
  })

  it('usa disco quando redis esta incompleto e sincroniza redis', async () => {
    const good = initAuthCreds()
    const bad = { ...good, noiseKey: undefined } as unknown as AuthenticationCreds
    const credsKey = `${getRedisNamespace('conn')}:creds`
    redisStore.set(credsKey, serialize(bad))

    const credsPath = join(mockConfig.authDir, 'creds.json')
    fileStore.set(credsPath, serialize(good))

    const { useRedisAuthState } = await import('../src/core/auth/redis-auth-state.ts')
    await useRedisAuthState('conn')

    expect(redisStore.get(credsKey)).toBe(serialize(good))
  })
})
