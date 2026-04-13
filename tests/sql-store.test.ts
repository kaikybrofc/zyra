import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = {
  mysqlUrl: null as string | null,
  connectionId: 'default',
}

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/core/db/connection.js', () => ({
  ensureMysqlConnection: vi.fn(),
}))
vi.mock('../src/core/db/mysql.js', () => ({
  getMysqlPool: vi.fn(() => null),
}))
vi.mock('../src/observability/logger.js', () => ({
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  })),
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mockConfig.mysqlUrl = null
  mockConfig.connectionId = 'default'
})

describe('sql-store', () => {
  it('retorna store desabilitada com fallbacks seguros quando mysql nao esta configurado', async () => {
    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    expect(store.enabled).toBe(false)
    store.setSelfJid('bot@s.whatsapp.net')
    await expect(store.getMessage('chat::0:msg')).resolves.toBeUndefined()
    await expect(store.getGroup('group@g.us')).resolves.toBeUndefined()
    await expect(store.getLidForPn('5511')).resolves.toBeNull()
    await expect(
      store.recordCommandLog({
        chatJid: 'chat@s.whatsapp.net',
        commandName: 'ping',
        success: true,
      })
    ).resolves.toBeUndefined()
    await expect(
      store.setLabelAssociation({
        labelId: 'l1',
        associationType: 'chat',
        chatJid: 'chat@s.whatsapp.net',
      })
    ).resolves.toBeUndefined()
  })
})
