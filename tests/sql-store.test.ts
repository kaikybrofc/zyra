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
const getMessageTextMock = vi.fn().mockReturnValue(null)
const getNormalizedMessageMock = vi.fn().mockReturnValue({ content: undefined, type: null })

vi.mock('../src/utils/message.js', () => ({
  getMessageText: (...args: unknown[]) => getMessageTextMock(...args),
  getNormalizedMessage: (...args: unknown[]) => getNormalizedMessageMock(...args),
}))

const createPool = (rows: Record<string, unknown>[] = []) => {
  const connection = {
    execute: vi.fn().mockResolvedValue([rows]),
    query: vi.fn().mockResolvedValue([rows]),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  }

  return {
    execute: vi.fn().mockResolvedValue([rows]),
    query: vi.fn().mockResolvedValue([rows]),
    getConnection: vi.fn().mockResolvedValue(connection),
    __connection: connection,
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mockConfig.mysqlUrl = null
  mockConfig.connectionId = 'default'
  getMysqlPoolMock = vi.fn(() => null)
  ensureMysqlConnectionMock = vi.fn().mockResolvedValue(undefined)
  getMessageTextMock.mockReset().mockReturnValue(null)
  getNormalizedMessageMock.mockReset().mockReturnValue({ content: undefined, type: null })
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
      getConnection: vi.fn().mockResolvedValue({
        execute: vi.fn().mockResolvedValue([[]]),
        query: vi.fn().mockResolvedValue([[{ acquired: 1 }]]),
        beginTransaction: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(),
      }),
    }
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    const p1 = store.setLidMapping({ lid: '99@lid', pn: '99' } as never)
    await new Promise<void>((res) => setTimeout(res, 0))

    const p2 = store.setLidMapping({ lid: '99@lid', pn: '99' } as never)
    unblockFirst()
    await Promise.all([p1, p2])

    const firstP2Start = executionLog.indexOf('start-' + String(executionLog.filter(e => e.startsWith('start-')).length))
    const lastP1End = executionLog.lastIndexOf('end-1')
    expect(lastP1End).toBeLessThan(firstP2Start === -1 ? Infinity : firstP2Start)
    expect(pool.execute).toHaveBeenCalled()
  })

  it('nao degrada users.display_name quando o candidato e pior', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[{ user_id: '11111111-1111-1111-1111-111111111111' }]])
        .mockResolvedValueOnce([[{ display_name: 'João Silva' }]])
        .mockResolvedValue([[]]),
      query: vi.fn().mockResolvedValue([[]]),
      getConnection: vi.fn().mockResolvedValue({
        execute: vi.fn().mockResolvedValue([[]]),
        query: vi.fn().mockResolvedValue([[{ acquired: 1 }]]),
        beginTransaction: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(),
      }),
    }
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    await store.setContact('5511999999999@s.whatsapp.net', {
      id: '5511999999999@s.whatsapp.net',
      name: '5511999999999',
    } as never)

    const updateUserCall = pool.execute.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE users') && sql.includes('SET display_name = ?')
    )
    expect(updateUserCall).toBeUndefined()
  })

  it('persiste nome melhor no cache de contato quando o existente e pior', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[{ user_id: '11111111-1111-1111-1111-111111111111' }]])
        .mockResolvedValueOnce([[{ display_name: '5511999999999' }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ display_name: null }]])
        .mockResolvedValue([[]]),
      query: vi.fn().mockResolvedValue([[]]),
      getConnection: vi.fn().mockResolvedValue({
        execute: vi.fn().mockResolvedValue([[]]),
        query: vi.fn().mockResolvedValue([[{ acquired: 1 }]]),
        beginTransaction: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(),
      }),
    }
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    await store.setContact('5511999999999@s.whatsapp.net', {
      id: '5511999999999@s.whatsapp.net',
      name: 'João Silva',
      notify: 'João Silva',
    } as never)

    const upsertContactCall = pool.execute.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO wa_contacts_cache')
    )
    expect(upsertContactCall).toBeTruthy()
    expect(upsertContactCall?.[1]).toContain('João Silva')
  })

  it('setChat preserva display_name melhor quando chega candidato pior', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[{ display_name: 'João Silva' }]])
        .mockResolvedValueOnce([[{ user_id: '11111111-1111-1111-1111-111111111111' }]])
        .mockResolvedValueOnce([[{ display_name: 'João Silva' }]])
        .mockResolvedValue([[]]),
      query: vi.fn().mockResolvedValue([[]]),
      getConnection: vi.fn().mockResolvedValue({
        execute: vi.fn().mockResolvedValue([[]]),
        query: vi.fn().mockResolvedValue([[{ acquired: 1 }]]),
        beginTransaction: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(),
      }),
    }
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    await store.setChat('5511999999999@s.whatsapp.net', {
      id: '5511999999999@s.whatsapp.net',
      name: '5511999999999',
    } as never)

    const upsertChatCall = pool.execute.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO chats')
    )
    expect(upsertChatCall?.[1]).toContain('João Silva')
    expect(upsertChatCall?.[1]).not.toContain('5511999999999')
  })

  it('setChat promove display_name melhor quando chega candidato melhor', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[{ display_name: '5511999999999' }]])
        .mockResolvedValueOnce([[{ user_id: '11111111-1111-1111-1111-111111111111' }]])
        .mockResolvedValueOnce([[{ display_name: '5511999999999' }]])
        .mockResolvedValue([[]]),
      query: vi.fn().mockResolvedValue([[]]),
      getConnection: vi.fn().mockResolvedValue({
        execute: vi.fn().mockResolvedValue([[]]),
        query: vi.fn().mockResolvedValue([[{ acquired: 1 }]]),
        beginTransaction: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(),
      }),
    }
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    await store.setChat('5511999999999@s.whatsapp.net', {
      id: '5511999999999@s.whatsapp.net',
      name: 'João Silva',
    } as never)

    const upsertChatCall = pool.execute.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO chats')
    )
    expect(upsertChatCall?.[1]).toContain('João Silva')
  })

  it('setContact melhora chats.display_name quando o valor atual e pior', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[{ user_id: '11111111-1111-1111-1111-111111111111' }]])
        .mockResolvedValueOnce([[{ display_name: '5511999999999' }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ display_name: '5511999999999' }]])
        .mockResolvedValue([[]]),
      query: vi.fn().mockResolvedValue([[]]),
      getConnection: vi.fn().mockResolvedValue({
        execute: vi.fn().mockResolvedValue([[]]),
        query: vi.fn().mockResolvedValue([[{ acquired: 1 }]]),
        beginTransaction: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(),
      }),
    }
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    await store.setContact('5511999999999@s.whatsapp.net', {
      id: '5511999999999@s.whatsapp.net',
      name: 'João Silva',
      notify: 'João Silva',
    } as never)

    const updateChatCall = pool.execute.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE chats') && sql.includes('SET display_name = ?')
    )
    expect(updateChatCall?.[1]).toContain('João Silva')
  })

  it('confirma materializacao atomica de usuario ao persistir contato', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const connection = {
      execute: vi.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]]),
      query: vi.fn().mockResolvedValue([[{ acquired: 1 }]]),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    }
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[{ display_name: null }]])
        .mockResolvedValueOnce([[{ display_name: null }]])
        .mockResolvedValue([[]]),
      query: vi.fn().mockResolvedValue([[]]),
      getConnection: vi.fn().mockResolvedValue(connection),
    }
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    await store.setContact('5511999999999@s.whatsapp.net', {
      id: '5511999999999@s.whatsapp.net',
      name: 'João Silva',
      notify: 'João Silva',
    } as never)

    expect(connection.beginTransaction).toHaveBeenCalledOnce()
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.rollback).not.toHaveBeenCalled()
    expect(connection.release).toHaveBeenCalledOnce()
    expect(connection.query).toHaveBeenNthCalledWith(1, 'SELECT GET_LOCK(?, 10) AS acquired', [expect.stringContaining('zyra:user:')])
    expect(connection.query).toHaveBeenNthCalledWith(2, 'SELECT RELEASE_LOCK(?)', [expect.stringContaining('zyra:user:')])

    const insertUserCall = connection.execute.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO users')
    )
    const insertIdentifierCall = connection.execute.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO user_identifiers')
    )
    expect(insertUserCall).toBeTruthy()
    expect(insertIdentifierCall).toBeTruthy()
  })

  it('faz rollback da materializacao de usuario quando a transacao falha', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const connection = {
      execute: vi.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[]])
        .mockRejectedValueOnce(new Error('boom')),
      query: vi.fn().mockResolvedValue([[{ acquired: 1 }]]),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    }
    const pool = {
      execute: vi.fn(),
      query: vi.fn().mockResolvedValue([[]]),
      getConnection: vi.fn().mockResolvedValue(connection),
    }
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    await expect(store.setContact('5511999999999@s.whatsapp.net', {
      id: '5511999999999@s.whatsapp.net',
      name: 'João Silva',
      notify: 'João Silva',
    } as never)).resolves.toBeUndefined()

    expect(connection.beginTransaction).toHaveBeenCalledOnce()
    expect(connection.commit).not.toHaveBeenCalled()
    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
    expect(connection.query).toHaveBeenNthCalledWith(1, 'SELECT GET_LOCK(?, 10) AS acquired', [expect.stringContaining('zyra:user:')])
    expect(connection.query).toHaveBeenNthCalledWith(2, 'SELECT RELEASE_LOCK(?)', [expect.stringContaining('zyra:user:')])
    expect(pool.execute).not.toHaveBeenCalled()
  })

  it('recordMessageEvent nao inventa actor_user_id e usa sender apenas como target fallback', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const senderUserId = '11111111-1111-1111-1111-111111111111'
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[{ id: 321 }]])
        .mockResolvedValueOnce([[{ sender_user_id: senderUserId }]])
        .mockResolvedValueOnce([[]]),
      query: vi.fn().mockResolvedValue([[]]),
      getConnection: vi.fn().mockResolvedValue({
        execute: vi.fn().mockResolvedValue([[]]),
        query: vi.fn().mockResolvedValue([[{ acquired: 1 }]]),
        beginTransaction: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(),
      }),
    }
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    await store.recordMessageEvent({
      key: { chatJid: 'chat@s.whatsapp.net', messageId: 'msg-1', fromMe: false },
      type: 'delete',
    })

    const insertEventCall = pool.execute.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO message_events')
    )
    expect(insertEventCall).toBeTruthy()
    expect(insertEventCall?.[1]).toEqual([
      'tenant',
      'chat@s.whatsapp.net',
      'msg-1',
      'delete',
      0,
      null,
      1,
      senderUserId,
      321,
      null,
    ])
  })

  it('recordEvent nao inventa actor_user_id e usa sender apenas como target fallback', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const senderUserId = '11111111-1111-1111-1111-111111111111'
    const pool = {
      execute: vi.fn()
        .mockResolvedValueOnce([[{ id: 654 }]])
        .mockResolvedValueOnce([[{ sender_user_id: senderUserId }]])
        .mockResolvedValueOnce([[]]),
      query: vi.fn().mockResolvedValue([[]]),
      getConnection: vi.fn().mockResolvedValue({
        execute: vi.fn().mockResolvedValue([[]]),
        query: vi.fn().mockResolvedValue([[{ acquired: 1 }]]),
        beginTransaction: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(),
      }),
    }
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    await store.recordEvent({
      type: 'message.delete',
      messageKey: { chatJid: 'chat@s.whatsapp.net', messageId: 'msg-1', fromMe: false },
    })

    const insertEventCall = pool.execute.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO events_log')
    )
    expect(insertEventCall).toBeTruthy()
    expect(insertEventCall?.[1]).toEqual([
      'tenant',
      'message.delete',
      0,
      null,
      1,
      senderUserId,
      'chat@s.whatsapp.net',
      null,
      654,
      null,
    ])
  })

  it('setMessage nao apaga timestamp existente com payload parcial', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const pool = {
      execute: vi.fn().mockResolvedValue([[]]),
      query: vi.fn().mockResolvedValue([[]]),
      getConnection: vi.fn().mockResolvedValue({
        execute: vi.fn().mockResolvedValue([[]]),
        query: vi.fn().mockResolvedValue([[{ acquired: 1 }]]),
        beginTransaction: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(),
      }),
    }
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    await store.setMessage({
      key: { remoteJid: 'chat@s.whatsapp.net', id: 'msg-1', fromMe: false },
      messageTimestamp: null,
      message: undefined,
    } as never)

    const insertMessageCall = pool.execute.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO messages')
    )
    expect(insertMessageCall?.[0]).toContain('timestamp = COALESCE(VALUES(timestamp), timestamp)')
  })

  it('setMessage nao apaga is_ephemeral existente com payload parcial', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    const pool = {
      execute: vi.fn().mockResolvedValue([[]]),
      query: vi.fn().mockResolvedValue([[]]),
      getConnection: vi.fn().mockResolvedValue({
        execute: vi.fn().mockResolvedValue([[]]),
        query: vi.fn().mockResolvedValue([[{ acquired: 1 }]]),
        beginTransaction: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        rollback: vi.fn().mockResolvedValue(undefined),
        release: vi.fn(),
      }),
    }
    getMysqlPoolMock.mockReturnValue(pool)

    const { createSqlStore } = await import('../src/store/sql-store.ts')
    const store = createSqlStore('tenant')

    await store.setMessage({
      key: { remoteJid: 'chat@s.whatsapp.net', id: 'msg-2', fromMe: false },
      message: undefined,
    } as never)

    const insertMessageCall = pool.execute.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO messages')
    )
    expect(insertMessageCall?.[0]).toContain('is_ephemeral = COALESCE(VALUES(is_ephemeral), is_ephemeral)')
  })
})
