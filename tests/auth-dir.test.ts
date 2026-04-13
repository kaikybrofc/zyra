import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = {
  authDir: 'data/auth',
  connectionId: 'default',
}

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))

beforeEach(() => {
  vi.resetModules()
  mockConfig.authDir = 'data/auth'
  mockConfig.connectionId = 'default'
})

describe('auth-dir', () => {
  it('resolve authDir com connectionId informado', async () => {
    const { resolveAuthDir } = await import('../src/core/auth/auth-dir.ts')
    expect(resolveAuthDir('conn')).toBe(path.resolve(process.cwd(), 'data/auth', 'conn'))
  })

  it('usa config.connectionId quando connectionId nao é informado', async () => {
    mockConfig.connectionId = 'main'
    const { resolveAuthDir } = await import('../src/core/auth/auth-dir.ts')
    expect(resolveAuthDir()).toBe(path.resolve(process.cwd(), 'data/auth', 'main'))
  })

  it('preserva authDir absoluto', async () => {
    mockConfig.authDir = '/tmp/zyra-auth'
    const { resolveAuthDir } = await import('../src/core/auth/auth-dir.ts')
    expect(resolveAuthDir('c1')).toBe(path.resolve(process.cwd(), '/tmp/zyra-auth', 'c1'))
    expect(resolveAuthDir('c1')).toBe('/tmp/zyra-auth/c1')
  })
})

