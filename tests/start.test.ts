import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = {
  connectionIds: null as string[] | null,
  connectionId: 'default',
  mysqlUrl: null as string | null,
  antibanEnabled: false,
  antibanMetricsEnabled: false,
  webhookRetryWorkerEnabled: true,
  webhookOutboxEnabled: true,
  bootstrapConnectionsEnabled: true,
  apiEnabled: false,
}

const createSocketMock = vi.fn()
const isShutdownInProgressMock = vi.fn(() => false)
const unregisterShutdownTargetMock = vi.fn()
const registerEventsMock = vi.fn()
const initMysqlSchemaMock = vi.fn(async () => undefined)
const getMysqlPoolMock = vi.fn(() => null)
const startAntiBanMetricsServerMock = vi.fn(() => ({ stop: vi.fn(async () => undefined) }))
const startWebhookRetryWorkerMock = vi.fn(() => ({ stop: vi.fn() }))
const startWebhookOutboxWorkerMock = vi.fn(() => ({ stop: vi.fn() }))
const enqueueConnectionOutboxEventMock = vi.fn(async () => undefined)
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
vi.mock('../src/observability/antiban-metrics.js', () => ({
  startAntiBanMetricsServer: (...args: unknown[]) => startAntiBanMetricsServerMock(...args),
}))
vi.mock('../src/webhook/retry-worker.js', () => ({
  startWebhookRetryWorker: (...args: unknown[]) => startWebhookRetryWorkerMock(...args),
}))
vi.mock('../src/core/webhooks/outbox-dispatcher.js', () => ({
  startWebhookOutboxWorker: (...args: unknown[]) => startWebhookOutboxWorkerMock(...args),
  enqueueConnectionOutboxEvent: (...args: unknown[]) => enqueueConnectionOutboxEventMock(...args),
}))

describe('startup multi-connection', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    // Evita vazamento de fake timers de outros testes/arquivos.
    vi.useRealTimers()
    vi.resetModules()
    vi.clearAllMocks()
    mockConfig.connectionIds = null
    mockConfig.connectionId = 'default'
    mockConfig.mysqlUrl = null
    mockConfig.antibanEnabled = false
    mockConfig.antibanMetricsEnabled = false
    mockConfig.webhookRetryWorkerEnabled = true
    mockConfig.webhookOutboxEnabled = true
    mockConfig.bootstrapConnectionsEnabled = true
    mockConfig.apiEnabled = false
    startWebhookRetryWorkerMock.mockReturnValue({ stop: vi.fn() })
    startWebhookOutboxWorkerMock.mockReturnValue({ stop: vi.fn() })
    enqueueConnectionOutboxEventMock.mockResolvedValue(undefined)
    createSocketMock.mockImplementation(async (connectionId: string) => ({
      ev: { removeAllListeners: vi.fn() },
      end: vi.fn(async () => undefined),
      connectionId,
    }))
    isShutdownInProgressMock.mockReturnValue(false)
    initMysqlSchemaMock.mockResolvedValue(undefined)
    getMysqlPoolMock.mockReturnValue(null)
  })

  it('usa WA_CONNECTION_IDS quando informado', async () => {
    mockConfig.connectionIds = ['conn-a', 'conn-b']

    const { start } = await import('../src/bootstrap/start.ts')
    await start()

    expect(createSocketMock).toHaveBeenNthCalledWith(1, 'conn-a', logger)
    expect(createSocketMock).toHaveBeenNthCalledWith(2, 'conn-b', logger)
  })

  it('prioriza WA_CONNECTION_IDS sobre descoberta no mysql', async () => {
    mockConfig.connectionIds = [' explicit-a ', 'explicit-a', 'explicit-b']
    mockConfig.mysqlUrl = 'mysql://test'
    getMysqlPoolMock.mockReturnValue({
      execute: vi.fn().mockResolvedValue([[{ connection_id: 'db-a' }, { connection_id: 'db-b' }], []]),
    })

    const { start } = await import('../src/bootstrap/start.ts')
    await start()

    expect(createSocketMock).toHaveBeenCalledTimes(2)
    expect(createSocketMock).toHaveBeenNthCalledWith(1, 'explicit-a', logger)
    expect(createSocketMock).toHaveBeenNthCalledWith(2, 'explicit-b', logger)
  })

  it('carrega conexões de auth_creds quando mysql esta configurado', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    getMysqlPoolMock.mockReturnValue({
      execute: vi.fn().mockResolvedValue([[{ connection_id: 'db-a' }, { connection_id: 'db-b' }], []]),
    })

    const { start } = await import('../src/bootstrap/start.ts')
    await start()

    expect(createSocketMock).toHaveBeenNthCalledWith(1, 'db-a', logger)
    expect(createSocketMock).toHaveBeenNthCalledWith(2, 'db-b', logger)
  })

  it('normaliza conexões carregadas do mysql antes do boot', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    getMysqlPoolMock.mockReturnValue({
      execute: vi.fn().mockResolvedValue([[{ connection_id: ' db-a ' }, { connection_id: '' }, { connection_id: 'db-a' }, { connection_id: 'db-b' }], []]),
    })

    const { start } = await import('../src/bootstrap/start.ts')
    await start()

    expect(createSocketMock).toHaveBeenCalledTimes(2)
    expect(createSocketMock).toHaveBeenNthCalledWith(1, 'db-a', logger)
    expect(createSocketMock).toHaveBeenNthCalledWith(2, 'db-b', logger)
  })

  it('propaga erro quando a descoberta no mysql falha', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    getMysqlPoolMock.mockReturnValue({
      execute: vi.fn().mockRejectedValue(new Error('mysql discovery failed')),
    })

    const { start } = await import('../src/bootstrap/start.ts')

    await expect(start()).rejects.toThrow('mysql discovery failed')
  })

  it('faz fallback para WA_CONNECTION_ID quando nao ha override nem conexoes no mysql', async () => {
    mockConfig.mysqlUrl = 'mysql://test'
    mockConfig.connectionId = 'legacy-main'
    getMysqlPoolMock.mockReturnValue({
      execute: vi.fn().mockResolvedValue([[], []]),
    })

    const { start } = await import('../src/bootstrap/start.ts')
    await start()

    expect(createSocketMock).toHaveBeenCalledTimes(1)
    expect(createSocketMock).toHaveBeenCalledWith('legacy-main', logger)
  })

  it('mantem reconnect isolado por conexão via callback registrado', async () => {
    mockConfig.connectionIds = ['conn-a', 'conn-b']
    const sockets = new Map<string, { ev: { removeAllListeners: ReturnType<typeof vi.fn> }; end: ReturnType<typeof vi.fn> }>()
    createSocketMock.mockImplementation(async (connectionId: string) => {
      const sock = {
        ev: { removeAllListeners: vi.fn() },
        end: vi.fn(async () => undefined),
      }
      sockets.set(connectionId, sock)
      return sock
    })

    const { start } = await import('../src/bootstrap/start.ts')
    await start()

    const firstReconnect = registerEventsMock.mock.calls[0]?.[0]?.reconnect as (() => Promise<void>) | undefined
    expect(firstReconnect).toBeTypeOf('function')
    await firstReconnect?.()

    expect(createSocketMock).toHaveBeenCalledTimes(3)
    expect(createSocketMock).toHaveBeenNthCalledWith(3, 'conn-a', logger)
    expect(createSocketMock.mock.calls.filter((call) => call[0] === 'conn-b')).toHaveLength(1)
    expect(unregisterShutdownTargetMock).toHaveBeenCalledTimes(1)
    expect(unregisterShutdownTargetMock.mock.calls[0]?.[0]).toBe('conn-a')
  })

  it('colapsa reconnects concorrentes da mesma conexão', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    mockConfig.connectionIds = ['conn-a']
    let releaseReconnect!: () => void
    let reconnectBlocked = false
    createSocketMock.mockImplementation(async (connectionId: string) => {
      if (connectionId === 'conn-a' && reconnectBlocked) {
        await new Promise<void>((resolve) => {
          releaseReconnect = resolve
        })
      }
      return {
        ev: { removeAllListeners: vi.fn() },
        end: vi.fn(async () => undefined),
      }
    })

    const { start } = await import('../src/bootstrap/start.ts')
    await start()

    const reconnect = registerEventsMock.mock.calls[0]?.[0]?.reconnect as () => Promise<void>
    reconnectBlocked = true
    const pendingA = reconnect()
    const pendingB = reconnect()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(2500)

    expect(createSocketMock).toHaveBeenCalledTimes(2)

    releaseReconnect()
    await Promise.all([pendingA, pendingB])
    expect(createSocketMock).toHaveBeenCalledTimes(2)
  })

  it('ignora reconnect quando shutdown está em andamento', async () => {
    mockConfig.connectionIds = ['conn-a', 'conn-b']
    isShutdownInProgressMock.mockReturnValue(false)

    const { start } = await import('../src/bootstrap/start.ts')
    await start()

    isShutdownInProgressMock.mockReturnValue(true)
    const reconnectA = registerEventsMock.mock.calls[0]?.[0]?.reconnect as () => Promise<void>
    await reconnectA()

    expect(createSocketMock).toHaveBeenCalledTimes(2)
  })

  it('permite reconnects independentes para conexões diferentes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    mockConfig.connectionIds = ['conn-a', 'conn-b']
    let releaseA!: () => void
    let blockAReconnect = false
    createSocketMock.mockImplementation(async (connectionId: string) => {
      if (connectionId === 'conn-a' && blockAReconnect) {
        await new Promise<void>((resolve) => {
          releaseA = resolve
        })
      }
      return {
        ev: { removeAllListeners: vi.fn() },
        end: vi.fn(async () => undefined),
      }
    })

    const { start } = await import('../src/bootstrap/start.ts')
    await start()

    const reconnectA = registerEventsMock.mock.calls[0]?.[0]?.reconnect as () => Promise<void>
    const reconnectB = registerEventsMock.mock.calls[1]?.[0]?.reconnect as () => Promise<void>
    blockAReconnect = true
    const pendingA = reconnectA()
    await Promise.resolve()
    const pendingB = reconnectB()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(2500)

    expect(createSocketMock.mock.calls.filter((call) => call[0] === 'conn-a')).toHaveLength(2)
    expect(createSocketMock.mock.calls.filter((call) => call[0] === 'conn-b')).toHaveLength(2)

    releaseA()
    await Promise.all([pendingA, pendingB])
  })

  it('inicializa o servidor de métricas uma vez e expõe snapshots por conexão', async () => {
    mockConfig.connectionIds = ['conn-a', 'conn-b']
    mockConfig.antibanEnabled = true
    mockConfig.antibanMetricsEnabled = true

    const { start } = await import('../src/bootstrap/start.ts')
    await start()

    expect(startAntiBanMetricsServerMock).toHaveBeenCalledTimes(1)
    const options = startAntiBanMetricsServerMock.mock.calls[0]?.[0] as { getOperationalSnapshots: () => Array<{ connectionId: string }> }
    const snapshots = options.getOperationalSnapshots()
    expect(snapshots.map((snapshot) => snapshot.connectionId)).toEqual(['conn-a', 'conn-b'])
  })

  it('não executa bootstrap de conexões quando desabilitado', async () => {
    mockConfig.bootstrapConnectionsEnabled = false

    const { start } = await import('../src/bootstrap/start.ts')
    await start()

    expect(createSocketMock).not.toHaveBeenCalled()
  })

  it('respeita as flags dos workers de webhook', async () => {
    mockConfig.connectionIds = ['conn-a']
    mockConfig.webhookRetryWorkerEnabled = false
    mockConfig.webhookOutboxEnabled = false

    const { start } = await import('../src/bootstrap/start.ts')
    await start()

    expect(startWebhookRetryWorkerMock).not.toHaveBeenCalled()
    expect(startWebhookOutboxWorkerMock).not.toHaveBeenCalled()
  })
})
