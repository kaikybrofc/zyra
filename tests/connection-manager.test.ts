import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = {
  connectionIds: null as string[] | null,
  connectionId: 'default',
  mysqlUrl: null as string | null,
  connectionControlMode: 'legacy' as 'legacy' | 'managed' | 'hybrid',
}

const createSocketMock = vi.fn()
const isShutdownInProgressMock = vi.fn(() => false)
const unregisterShutdownTargetMock = vi.fn()
const registerEventsMock = vi.fn()
const initMysqlSchemaMock = vi.fn(async () => undefined)
const getMysqlPoolMock = vi.fn(() => null)

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/core/connection/socket.js', () => ({
  createSocket: (...args: unknown[]) => createSocketMock(...args),
  isShutdownInProgress: (...args: unknown[]) => isShutdownInProgressMock(...args),
  unregisterShutdownTarget: (...args: unknown[]) => unregisterShutdownTargetMock(...args),
}))
vi.mock('../src/events/register.js', () => ({
  registerEvents: (...args: unknown[]) => registerEventsMock(...args),
}))
vi.mock('../src/core/db/init.js', () => ({
  initMysqlSchema: (...args: unknown[]) => initMysqlSchemaMock(...args),
}))
vi.mock('../src/core/db/mysql.js', () => ({
  getMysqlPool: (...args: unknown[]) => getMysqlPoolMock(...args),
}))
vi.mock('../src/observability/logger.js', () => ({
  createLogger: vi.fn(() => logger),
}))

const makeSock = () => ({
  ev: { removeAllListeners: vi.fn() },
  end: vi.fn(async () => undefined),
})

describe('ConnectionManager', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConfig.connectionIds = null
    mockConfig.connectionId = 'default'
    mockConfig.mysqlUrl = null
    mockConfig.connectionControlMode = 'legacy'
    createSocketMock.mockImplementation(async () => makeSock())
    isShutdownInProgressMock.mockReturnValue(false)
    initMysqlSchemaMock.mockResolvedValue(undefined)
    getMysqlPoolMock.mockReturnValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('createConnection registra runtime sem conectar', async () => {
    const manager = await import('../src/core/connection/manager.ts')
    const info = manager.createConnection('session-1')

    expect(info.connectionId).toBe('session-1')
    expect(info.status).toBe('created')
    expect(info.socketActive).toBe(false)
    expect(createSocketMock).not.toHaveBeenCalled()
  })

  it('listConnections retorna todas as entradas registradas', async () => {
    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-a')
    manager.createConnection('conn-b')

    const list = manager.listConnections()
    expect(list.map((c) => c.connectionId)).toEqual(expect.arrayContaining(['conn-a', 'conn-b']))
  })

  it('getConnection retorna null para id inexistente', async () => {
    const manager = await import('../src/core/connection/manager.ts')
    expect(manager.getConnection('nao-existe')).toBeNull()
  })

  it('setConnectionLabel atualiza o label da conexão', async () => {
    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-label')
    manager.setConnectionLabel('conn-label', 'Meu Bot')

    expect(manager.getConnection('conn-label')?.label).toBe('Meu Bot')
  })

  it('setQrCode atualiza qrCode e muda status para qr', async () => {
    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-qr')
    manager.setQrCode('conn-qr', 'qr-data-abc')

    const info = manager.getConnection('conn-qr')
    expect(info?.status).toBe('qr')
    expect(info?.qrCode).toBe('qr-data-abc')
    expect(info?.qrCodeAt).toBeTypeOf('number')
  })

  it('setConnectionStatus open limpa qr e muda status para open', async () => {
    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-open')
    manager.setQrCode('conn-open', 'qr-data')
    manager.setConnectionStatus('conn-open', 'open')

    const info = manager.getConnection('conn-open')
    expect(info?.status).toBe('open')
    expect(info?.qrCode).toBeNull()
  })

  it('connect dispara scheduleReconnect e cria socket', async () => {
    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-connect')
    await manager.connect('conn-connect', logger as never)

    expect(createSocketMock).toHaveBeenCalledWith('conn-connect', logger)
    expect(registerEventsMock).toHaveBeenCalledTimes(1)
    const opts = registerEventsMock.mock.calls[0]?.[0] as { connectionId: string; reconnect: unknown }
    expect(opts.connectionId).toBe('conn-connect')
    expect(opts.reconnect).toBeTypeOf('function')
  })

  it('connect ignora quando instância já está open', async () => {
    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-already-open')
    manager.setConnectionStatus('conn-already-open', 'open')
    await manager.connect('conn-already-open', logger as never)

    expect(createSocketMock).not.toHaveBeenCalled()
  })

  it('disconnect encerra socket e muda status para closed', async () => {
    const sock = makeSock()
    createSocketMock.mockResolvedValue(sock)

    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-disc')
    await manager.connect('conn-disc', logger as never)
    await manager.disconnect('conn-disc', logger as never)

    expect(sock.end).toHaveBeenCalled()
    expect(manager.getConnection('conn-disc')?.status).toBe('closed')
    expect(manager.getConnection('conn-disc')?.socketActive).toBe(false)
  })

  it('restart desconecta e reconecta', async () => {
    const sock = makeSock()
    createSocketMock.mockResolvedValue(sock)

    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-restart')
    await manager.connect('conn-restart', logger as never)

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const restartPromise = manager.restart('conn-restart', logger as never)
    await vi.advanceTimersByTimeAsync(3000)
    await restartPromise

    expect(sock.end).toHaveBeenCalled()
    expect(createSocketMock).toHaveBeenCalledTimes(2)
  })

  it('deleteConnection remove runtime do manager', async () => {
    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-del')
    await manager.deleteConnection('conn-del', logger as never)

    expect(manager.getConnection('conn-del')).toBeNull()
  })

  it('pause encerra socket e mantém conexão registrada', async () => {
    const sock = makeSock()
    createSocketMock.mockResolvedValue(sock)

    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-pause')
    await manager.connect('conn-pause', logger as never)
    await manager.pause('conn-pause', logger as never)

    expect(sock.end).toHaveBeenCalled()
    expect(manager.getConnection('conn-pause')).not.toBeNull()
    expect(manager.getConnection('conn-pause')?.socketActive).toBe(false)
  })

  it('resume reconecta instância pausada', async () => {
    const sock = makeSock()
    createSocketMock.mockResolvedValue(sock)

    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-resume')
    await manager.pause('conn-resume', logger as never)
    await manager.resume('conn-resume', logger as never)

    expect(createSocketMock).toHaveBeenCalledWith('conn-resume', logger)
  })

  it('onQrCode callback chamado pelo registerEvents ao receber QR', async () => {
    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-qr-cb')
    await manager.connect('conn-qr-cb', logger as never)

    const opts = registerEventsMock.mock.calls[0]?.[0] as { onQrCode?: (qr: string) => void }
    expect(opts.onQrCode).toBeTypeOf('function')

    opts.onQrCode?.('qr-string-xyz')
    expect(manager.getConnection('conn-qr-cb')?.qrCode).toBe('qr-string-xyz')
    expect(manager.getConnection('conn-qr-cb')?.status).toBe('qr')
  })

  it('onConnectionOpen callback atualiza status para open', async () => {
    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-open-cb')
    await manager.connect('conn-open-cb', logger as never)

    const opts = registerEventsMock.mock.calls[0]?.[0] as { onConnectionOpen?: () => void }
    opts.onConnectionOpen?.()

    expect(manager.getConnection('conn-open-cb')?.status).toBe('open')
  })

  it('resolveStartupConnectionIds respeita prioridade: connectionIds > mysql > connectionId', async () => {
    mockConfig.connectionIds = ['explicit-a', 'explicit-b']
    mockConfig.mysqlUrl = 'mysql://test'
    getMysqlPoolMock.mockReturnValue({
      execute: vi.fn().mockResolvedValue([[{ connection_id: 'db-a' }], []]),
    })

    const manager = await import('../src/core/connection/manager.ts')
    const ids = await manager.resolveStartupConnectionIds()
    expect(ids).toEqual(['explicit-a', 'explicit-b'])
  })

  it('resolveStartupConnectionIds em modo managed usa apenas managed_connections em running', async () => {
    mockConfig.connectionControlMode = 'managed'
    mockConfig.mysqlUrl = 'mysql://test'
    mockConfig.connectionIds = ['ignorado-no-managed']

    const executeMock = vi.fn(async (query: string) => {
      if (query.includes('FROM managed_connections') && query.includes("desired_state = 'running'")) {
        return [[{ connection_id: 'managed-a' }, { connection_id: 'managed-b' }], []]
      }
      return [[], []]
    })
    getMysqlPoolMock.mockReturnValue({ execute: executeMock })

    const manager = await import('../src/core/connection/manager.ts')
    const ids = await manager.resolveStartupConnectionIds()
    expect(ids).toEqual(['managed-a', 'managed-b'])
  })

  it('resolveStartupConnectionIds em modo hybrid migra auth_creds faltantes', async () => {
    mockConfig.connectionControlMode = 'hybrid'
    mockConfig.mysqlUrl = 'mysql://test'
    mockConfig.connectionIds = ['explicit-a']

    const executeMock = vi.fn(async (query: string) => {
      if (query.includes('FROM managed_connections') && query.includes("desired_state = 'running'")) {
        return [[{ connection_id: 'managed-a' }], []]
      }
      if (query.includes('FROM auth_creds')) {
        return [[{ connection_id: 'legacy-a' }, { connection_id: 'managed-a' }], []]
      }
      if (query.includes('SELECT connection_id FROM managed_connections ORDER BY')) {
        return [[{ connection_id: 'managed-a' }], []]
      }
      return [[], []]
    })
    getMysqlPoolMock.mockReturnValue({ execute: executeMock })

    const manager = await import('../src/core/connection/manager.ts')
    const ids = await manager.resolveStartupConnectionIds()
    expect(ids).toEqual(['managed-a', 'explicit-a', 'legacy-a'])

    const migrationInsert = executeMock.mock.calls.find((call) => String(call[0]).includes('INSERT INTO managed_connections'))
    expect(migrationInsert).toBeTruthy()
  })

  it('getOperationalSnapshots retorna snapshot por conexão', async () => {
    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('snap-a')
    manager.createConnection('snap-b')

    const snapshots = manager.getOperationalSnapshots()
    expect(snapshots.map((s) => s.connectionId)).toEqual(expect.arrayContaining(['snap-a', 'snap-b']))
    for (const s of snapshots) {
      expect(s.socketActive).toBe(false)
    }
  })

  it('getAntiBanStatsByConnection retorna estatísticas de cada conexão ativa', async () => {
    createSocketMock.mockImplementation(async (connectionId: string) => ({
      ev: { removeAllListeners: vi.fn() },
      end: vi.fn(async () => undefined),
      antiban: {
        getStats: () => ({ id: connectionId, sent: connectionId === 'conn-a' ? 10 : 20 }),
      },
    }))

    const manager = await import('../src/core/connection/manager.ts')
    manager.createConnection('conn-a')
    manager.createConnection('conn-b')
    await manager.connect('conn-a', logger as never)
    await manager.connect('conn-b', logger as never)

    expect(manager.getAntiBanStatsByConnection()).toEqual({
      'conn-a': { id: 'conn-a', sent: 10 },
      'conn-b': { id: 'conn-b', sent: 20 },
    })
  })
})
