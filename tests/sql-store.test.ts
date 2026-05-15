import { beforeEach, describe, expect, it, vi } from 'vitest'

let getMysqlPoolMock: ReturnType<typeof vi.fn>
let ensureMysqlConnectionMock: ReturnType<typeof vi.fn>

const mockConfig = {
  mysqlUrl: null as string | null,
  connectionId: 'default',
}

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/core/db/connection.js', () => ({
  ensureMysqlConnection: (...args: unknown[]) => ensureMysqlConnectionMock(...args),
}))
vi.mock('../src/core/db/mysql.js', () => ({
  getMysqlPool: (...args: unknown[]) => getMysqlPoolMock(...args),
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
vi.mock('../src/utils/media-download.js', () => ({
  downloadIncomingMediaToDisk: vi.fn().mockResolvedValue(null),
}))
vi.mock('../src/utils/message.js', () => ({
  getMessageText: vi.fn().mockReturnValue(null),
  getNormalizedMessage: vi.fn().mockReturnValue(null),
}))

const createPool = (rows: Record<string, unknown>[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows]),
  query: vi.fn().mockResolvedValue([rows]),
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mockConfig.mysqlUrl = null
  mockConfig.connectionId = 'default'
  getMysqlPoolMock = vi.fn(() => null)
  ensureMysqlConnectionMock = vi.fn().mockResolvedValue(undefined)
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

  it('retorna null quando getMysqlPool retorna null', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    getMysqlPoolMock.mockReturnValue(null)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    expect(store.enabled).toBe(true)
    await expect(store.getLidForPn('5511')).resolves.toBeNull()
    await expect(store.getPnForLid('5511@lid')).resolves.toBeNull()
    await expect(store.getMessage('chat@s.whatsapp.net::0:msg-1')).resolves.toBeUndefined()
  })

  it('getLidForPn retorna lid quando encontrado no pool', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const pool = createPool([{ lid: '5511@lid' }])
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    expect(await store.getLidForPn('5511')).toBe('5511@lid')
    expect(pool.execute).toHaveBeenCalledOnce()
  })

  it('getLidForPn retorna null quando nao encontrado no pool', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const pool = createPool([])
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    expect(await store.getLidForPn('5511')).toBeNull()
  })

  it('getPnForLid retorna pn quando encontrado no pool', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const pool = createPool([{ pn: '5511' }])
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    expect(await store.getPnForLid('5511@lid')).toBe('5511')
    expect(pool.execute).toHaveBeenCalledOnce()
  })

  it('getMessage retorna mensagem quando encontrada no pool', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const msgData = { key: { remoteJid: 'chat@s.whatsapp.net', id: 'msg-1', fromMe: false }, message: { conversation: 'oi' } }
    const pool = createPool([{ data_json: JSON.stringify(msgData) }])
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    expect(await store.getMessage('chat@s.whatsapp.net::0:msg-1')).toEqual(msgData)
    expect(pool.execute).toHaveBeenCalledOnce()
  })

  it('getMessage retorna undefined quando key e invalida', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const pool = createPool()
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    await expect(store.getMessage('')).resolves.toBeUndefined()
    await expect(store.getMessage('nomatch')).resolves.toBeUndefined()
    expect(pool.execute).not.toHaveBeenCalled()
  })

  it('getMessage retorna undefined quando nao encontrada no pool', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const pool = createPool([])
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    await expect(store.getMessage('chat@s.whatsapp.net::0:missing')).resolves.toBeUndefined()
  })

  it('withLidPnPairLock serializa chamadas concorrentes para o mesmo par lid/pn', async () => {
    mockConfig.mysqlUrl = 'mysql://test'

    const executionLog: string[] = []
    let unblockFirst!: () => void
    const firstBarrier = new Promise<void>((res) => { unblockFirst = res })
    let executeCount = 0

    const pool = {
      execute: vi.fn().mockImplementation(async () => {
        const n = ++executeCount
        executionLog.push(`start-${n}`)
        if (n === 1) await firstBarrier
        executionLog.push(`end-${n}`)
        return [[]]
      }),
      query: vi.fn().mockResolvedValue([[]]),
    }
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    const p1 = store.setLidMapping({ lid: '99@lid', pn: '99' } as never)
    // yield so p1 can acquire the lock and reach the first blocked execute
    await new Promise<void>((res) => setTimeout(res, 0))

    const p2 = store.setLidMapping({ lid: '99@lid', pn: '99' } as never)
    // p2 should be queued behind p1's lock; unblock p1 now
    unblockFirst()
    await Promise.all([p1, p2])

    // p1's first execute must complete before p2 can begin any execute
    const firstP2Start = executionLog.indexOf('start-' + String(executionLog.filter(e => e.startsWith('start-')).length))
    const lastP1End = executionLog.lastIndexOf('end-1')
    expect(lastP1End).toBeLessThan(firstP2Start === -1 ? Infinity : firstP2Start)
    expect(pool.execute).toHaveBeenCalled()
  })
})
