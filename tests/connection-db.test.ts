import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = {
  connectionId: 'default-conn',
}

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))

describe('ensureMysqlConnection', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConfig.connectionId = 'default-conn'
  })

  it('colapsa chamadas concorrentes para o mesmo connectionId', async () => {
    let release!: () => void
    const pool = {
      execute: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve([[], []])
          })
      ),
    }

    const { ensureMysqlConnection } = await import('../src/core/db/connection.ts')
    const first = ensureMysqlConnection(pool as never, 'conn-a')
    const second = ensureMysqlConnection(pool as never, 'conn-a')
    await Promise.resolve()

    expect(pool.execute).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    expect(pool.execute).toHaveBeenCalledTimes(1)
  })

  it('executa inserções independentes para connectionIds diferentes', async () => {
    const pool = {
      execute: vi.fn(async () => [[], []]),
    }

    const { ensureMysqlConnection } = await import('../src/core/db/connection.ts')
    await ensureMysqlConnection(pool as never, 'conn-a')
    await ensureMysqlConnection(pool as never, 'conn-b')

    expect(pool.execute).toHaveBeenCalledTimes(2)
    expect(pool.execute).toHaveBeenNthCalledWith(1, expect.stringContaining('INSERT INTO connections'), ['conn-a', 'conn-a'])
    expect(pool.execute).toHaveBeenNthCalledWith(2, expect.stringContaining('INSERT INTO connections'), ['conn-b', 'conn-b'])
  })

  it('não reinserta a mesma conexão depois do primeiro sucesso', async () => {
    const pool = {
      execute: vi.fn(async () => [[], []]),
    }

    const { ensureMysqlConnection } = await import('../src/core/db/connection.ts')
    await ensureMysqlConnection(pool as never, 'conn-a')
    await ensureMysqlConnection(pool as never, 'conn-a')

    expect(pool.execute).toHaveBeenCalledTimes(1)
  })

  it('usa config.connectionId quando o parâmetro não é informado', async () => {
    const pool = {
      execute: vi.fn(async () => [[], []]),
    }

    const { ensureMysqlConnection } = await import('../src/core/db/connection.ts')
    await ensureMysqlConnection(pool as never)

    expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO connections'), ['default-conn', 'default-conn'])
  })
})
