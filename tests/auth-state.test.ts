import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig: {
  authDir: string
  connectionId: string
  mysqlUrl: string | null | undefined
  redisUrl: string | null | undefined
} = {
  authDir: 'data/auth',
  connectionId: 'default',
  mysqlUrl: null,
  redisUrl: null,
}

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))

const useMysqlAuthState = vi.fn(async (_connectionId?: string) => ({
  state: { creds: { from: 'mysql' } } as never,
  saveCreds: vi.fn(async () => undefined),
}))
vi.mock('../src/core/auth/mysql-auth-state.js', () => ({ useMysqlAuthState }))

const useRedisAuthState = vi.fn(async (_connectionId?: string) => ({
  state: { creds: { from: 'redis' } } as never,
  saveCreds: vi.fn(async () => undefined),
}))
vi.mock('../src/core/auth/redis-auth-state.js', () => ({ useRedisAuthState }))

const useMultiFileAuthState = vi.fn(async (_authDir: string) => ({
  state: { creds: { from: 'disk' } } as never,
  saveCreds: vi.fn(async () => undefined),
}))
vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  return { ...actual, useMultiFileAuthState }
})

describe('auth-state factory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockConfig.authDir = 'data/auth'
    mockConfig.connectionId = 'default'
    mockConfig.mysqlUrl = null
    mockConfig.redisUrl = null
  })

  it('prioriza mysql quando mysqlUrl esta configurado', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    mockConfig.redisUrl = 'redis://test'

    const { getAuthState } = await import('../src/core/auth/state.ts')
    const result = await getAuthState('conn')

    expect(useMysqlAuthState).toHaveBeenCalledTimes(1)
    expect(useMysqlAuthState).toHaveBeenCalledWith('conn')
    expect(useRedisAuthState).not.toHaveBeenCalled()
    expect(useMultiFileAuthState).not.toHaveBeenCalled()
    expect((result as never as { state: { creds: { from: string } } }).state.creds.from).toBe('mysql')
  })

  it('usa redis quando mysqlUrl nao esta configurado e redisUrl esta', async () => {
    mockConfig.mysqlUrl = null
    mockConfig.redisUrl = 'redis://test'

    const { getAuthState } = await import('../src/core/auth/state.ts')
    const result = await getAuthState('conn')

    expect(useMysqlAuthState).not.toHaveBeenCalled()
    expect(useRedisAuthState).toHaveBeenCalledTimes(1)
    expect(useRedisAuthState).toHaveBeenCalledWith('conn')
    expect(useMultiFileAuthState).not.toHaveBeenCalled()
    expect((result as never as { state: { creds: { from: string } } }).state.creds.from).toBe('redis')
  })

  it('usa disco quando mysqlUrl e redisUrl nao estao configurados', async () => {
    mockConfig.mysqlUrl = null
    mockConfig.redisUrl = null

    const { getAuthState } = await import('../src/core/auth/state.ts')
    const result = await getAuthState('conn')

    expect(useMysqlAuthState).not.toHaveBeenCalled()
    expect(useRedisAuthState).not.toHaveBeenCalled()
    expect(useMultiFileAuthState).toHaveBeenCalledTimes(1)
    expect(useMultiFileAuthState).toHaveBeenCalledWith(path.resolve(process.cwd(), 'data/auth', 'conn'))
    expect((result as never as { state: { creds: { from: string } } }).state.creds.from).toBe('disk')
  })

  it('quando connectionId nao é informado, usa config.connectionId no disco', async () => {
    mockConfig.connectionId = 'main'

    const { getAuthState } = await import('../src/core/auth/state.ts')
    await getAuthState()

    expect(useMultiFileAuthState).toHaveBeenCalledWith(path.resolve(process.cwd(), 'data/auth', 'main'))
  })
})

