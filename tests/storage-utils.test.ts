import { beforeEach, describe, expect, it, vi } from 'vitest'

const mkdirMock = vi.fn()

vi.mock('node:fs/promises', () => ({
  mkdir: (...args: unknown[]) => mkdirMock(...args),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}))

beforeEach(() => {
  vi.resetModules()
  mkdirMock.mockReset()
})

describe('ensureAuthFolder', () => {
  it('creates the directory and caches the success', async () => {
    mkdirMock.mockResolvedValue(undefined)
    const { ensureAuthFolder } = await import('../src/core/auth/storage-utils.ts')

    await ensureAuthFolder('/tmp/auth-test')
    await ensureAuthFolder('/tmp/auth-test')

    expect(mkdirMock).toHaveBeenCalledTimes(1)
  })

  it('clears the cache on failure so the next call retries', async () => {
    mkdirMock.mockRejectedValueOnce(new Error('EACCES: permission denied'))
    mkdirMock.mockResolvedValue(undefined)

    const { ensureAuthFolder } = await import('../src/core/auth/storage-utils.ts')

    await expect(ensureAuthFolder('/tmp/auth-retry')).rejects.toThrow('EACCES')

    // second call must retry — not replay the cached rejection
    await expect(ensureAuthFolder('/tmp/auth-retry')).resolves.toBeUndefined()
    expect(mkdirMock).toHaveBeenCalledTimes(2)
  })

  it('concurrent callers all wait on the same task and do not double-create', async () => {
    let resolveDir!: () => void
    const dirPromise = new Promise<void>((r) => {
      resolveDir = r
    })
    mkdirMock.mockReturnValue(dirPromise)

    const { ensureAuthFolder } = await import('../src/core/auth/storage-utils.ts')

    const p1 = ensureAuthFolder('/tmp/concurrent')
    const p2 = ensureAuthFolder('/tmp/concurrent')

    resolveDir()
    await Promise.all([p1, p2])

    expect(mkdirMock).toHaveBeenCalledTimes(1)
  })
})
