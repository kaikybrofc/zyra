import { beforeEach, describe, expect, it, vi } from 'vitest'

const rmMock = vi.fn(async () => undefined)
const mkdirMock = vi.fn(async () => undefined)
const getMysqlPoolMock = vi.fn(() => null)
const getRedisClientMock = vi.fn(async () => null)
const getRedisNamespaceMock = vi.fn((connectionId: string) => `ns:${connectionId}`)
const getLegacyRedisNamespaceMock = vi.fn((connectionId: string) => `legacy:${connectionId}`)
const resolveAuthDirMock = vi.fn((connectionId: string) => `/auth/${connectionId}`)
const resolveAntiBanStateDirMock = vi.fn((connectionId: string) => `/antiban/${connectionId}`)

const mockConfig = {
  redisUrl: null as string | null,
  authDir: '/auth',
  antibanStateDir: 'data/antiban',
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}

vi.mock('node:fs/promises', () => ({
  rm: (...args: unknown[]) => rmMock(...args),
  mkdir: (...args: unknown[]) => mkdirMock(...args),
}))
vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/core/db/mysql.js', () => ({
  getMysqlPool: (...args: unknown[]) => getMysqlPoolMock(...args),
}))
vi.mock('../src/core/redis/client.js', () => ({
  getRedisClient: (...args: unknown[]) => getRedisClientMock(...args),
}))
vi.mock('../src/core/redis/prefix.js', () => ({
  getRedisNamespace: (...args: unknown[]) => getRedisNamespaceMock(...args),
  getLegacyRedisNamespace: (...args: unknown[]) => getLegacyRedisNamespaceMock(...args),
}))
vi.mock('../src/core/auth/auth-dir.js', () => ({
  resolveAuthDir: (...args: unknown[]) => resolveAuthDirMock(...args),
}))
vi.mock('../src/core/connection/antiban.js', () => ({
  resolveAntiBanStateDir: (...args: unknown[]) => resolveAntiBanStateDirMock(...args),
}))

describe('hardDeleteSessionArtifacts', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConfig.redisUrl = null
    mockConfig.authDir = '/auth'
    mockConfig.antibanStateDir = 'data/antiban'
    getMysqlPoolMock.mockReturnValue(null)
    rmMock.mockResolvedValue(undefined)
    mkdirMock.mockResolvedValue(undefined)
  })

  it('remove authDir e estado antiban no hard delete', async () => {
    const { hardDeleteSessionArtifacts } = await import('../src/core/connection/session-cleanup.ts')
    const result = await hardDeleteSessionArtifacts('conn-a', logger as never)

    expect(result.authDir).toBe(true)
    expect(result.antibanState).toBe(true)
    expect(rmMock).toHaveBeenCalledWith('/auth/conn-a', { recursive: true, force: true })
    expect(mkdirMock).toHaveBeenCalledWith('/auth/conn-a', { recursive: true })
    expect(rmMock).toHaveBeenCalledWith('/antiban/conn-a', { recursive: true, force: true })
  })

  it('registra erro quando limpeza do estado antiban falha', async () => {
    rmMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('rm antiban failed'))

    const { hardDeleteSessionArtifacts } = await import('../src/core/connection/session-cleanup.ts')
    const result = await hardDeleteSessionArtifacts('conn-b', logger as never)

    expect(result.antibanState).toBe(false)
    expect(result.errors.some((entry) => entry.includes('antiban_state'))).toBe(true)
    expect(logger.warn).toHaveBeenCalled()
  })
})
