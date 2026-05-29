import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadEnvMock = vi.fn()
const mkdirMock = vi.fn(async () => undefined)
const rmMock = vi.fn(async () => undefined)
const ensureMysqlConnectionMock = vi.fn(async () => undefined)
const closeRedisClientMock = vi.fn(async () => undefined)
const getRedisNamespaceMock = vi.fn((connectionId?: string) => `ns:${connectionId ?? 'default'}`)
const getLegacyRedisNamespaceMock = vi.fn((connectionId?: string) => `legacy:${connectionId ?? 'default'}`)
const resolveAuthDirMock = vi.fn((connectionId?: string) => `/auth/${connectionId ?? 'default'}`)
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}

const mockConfig = {
  connectionId: 'default',
  redisUrl: 'redis://test',
  authDir: '/auth',
}

const redisClient = {
  del: vi.fn(async () => 1),
  unlink: vi.fn(async () => 1),
  scan: vi.fn(async () => ({ cursor: 0, keys: ['ns:conn-a:keys:1'] })),
  quit: vi.fn(async () => undefined),
}

const mysqlPool = {
  execute: vi.fn(async () => [[], []]),
  end: vi.fn(async () => undefined),
}

const getMysqlPoolMock = vi.fn(() => mysqlPool)
const getRedisClientMock = vi.fn(async () => redisClient)

vi.mock('../src/bootstrap/env.js', () => ({ loadEnv: () => loadEnvMock() }))
vi.mock('node:fs/promises', () => ({
  mkdir: (...args: unknown[]) => mkdirMock(...args),
  rm: (...args: unknown[]) => rmMock(...args),
}))
vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/observability/logger.js', () => ({ createLogger: vi.fn(() => logger) }))
vi.mock('../src/core/redis/client.js', () => ({
  getRedisClient: (...args: unknown[]) => getRedisClientMock(...args),
  closeRedisClient: (...args: unknown[]) => closeRedisClientMock(...args),
}))
vi.mock('../src/core/redis/prefix.js', () => ({
  getRedisNamespace: (...args: unknown[]) => getRedisNamespaceMock(...args),
  getLegacyRedisNamespace: (...args: unknown[]) => getLegacyRedisNamespaceMock(...args),
}))
vi.mock('../src/core/auth/auth-dir.js', () => ({
  resolveAuthDir: (...args: unknown[]) => resolveAuthDirMock(...args),
}))
vi.mock('../src/core/db/connection.js', () => ({
  ensureMysqlConnection: (...args: unknown[]) => ensureMysqlConnectionMock(...args),
}))
vi.mock('../src/core/db/mysql.js', () => ({
  getMysqlPool: (...args: unknown[]) => getMysqlPoolMock(...args),
}))

describe('delete-session command', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConfig.connectionId = 'default'
    mockConfig.redisUrl = 'redis://test'
    getMysqlPoolMock.mockReturnValue(mysqlPool)
    getRedisClientMock.mockResolvedValue(redisClient)
    mysqlPool.execute.mockResolvedValue([[], []])
    mysqlPool.end.mockResolvedValue(undefined)
    redisClient.scan.mockResolvedValue({ cursor: 0, keys: ['ns:conn-a:keys:1'] })
  })

  it('usa --connection como alvo explícito em mysql redis e disco', async () => {
    const argv = process.argv
    process.argv = ['node', 'delete-session.ts', '--connection', 'conn-a']

    await import('../src/core/db/delete-session.ts')
    await vi.waitFor(() => {
      expect(ensureMysqlConnectionMock).toHaveBeenCalledWith(mysqlPool, 'conn-a')
      expect(mysqlPool.execute).toHaveBeenCalledWith('DELETE FROM auth_creds WHERE connection_id = ?', ['conn-a'])
      expect(mysqlPool.execute).toHaveBeenCalledWith('DELETE FROM signal_keys WHERE connection_id = ?', ['conn-a'])
      expect(getRedisNamespaceMock).toHaveBeenCalledWith('conn-a')
      expect(getLegacyRedisNamespaceMock).toHaveBeenCalledWith('conn-a')
      expect(resolveAuthDirMock).toHaveBeenCalledWith('conn-a')
      expect(rmMock).toHaveBeenCalledWith('/auth/conn-a', { recursive: true, force: true })
      expect(closeRedisClientMock).toHaveBeenCalled()
    })

    process.argv = argv
  })

  it('mantém fallback para config.connectionId quando argumento não é informado', async () => {
    const argv = process.argv
    process.argv = ['node', 'delete-session.ts']
    mockConfig.connectionId = 'legacy-main'

    await import('../src/core/db/delete-session.ts')
    await vi.waitFor(() => {
      expect(ensureMysqlConnectionMock).toHaveBeenCalledWith(mysqlPool, 'legacy-main')
      expect(resolveAuthDirMock).toHaveBeenCalledWith('legacy-main')
    })

    process.argv = argv
  })
})
