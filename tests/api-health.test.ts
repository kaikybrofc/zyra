import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

type FakeResponse = {
  statusCode: number
  headers: Record<string, string>
  body: string
  headersSent: boolean
  setHeader: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

const mockConfig = {
  healthEnabled: true,
  mysqlUrl: null as string | null,
  redisUrl: null as string | null,
  bootstrapConnectionsEnabled: true,
  apiEnabled: true,
  webhookSharedSecret: 'segredo-webhook' as string | null,
}

const listConnectionsMock = vi.fn()
const listManagedConnectionsMock = vi.fn()
const getMysqlPoolMock = vi.fn()
const getRedisClientMock = vi.fn()

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/core/connection/manager.js', () => ({
  listConnections: (...args: unknown[]) => listConnectionsMock(...args),
}))
vi.mock('../src/store/connection-admin-store.js', () => ({
  listManagedConnections: (...args: unknown[]) => listManagedConnectionsMock(...args),
}))
vi.mock('../src/core/db/mysql.js', () => ({
  getMysqlPool: (...args: unknown[]) => getMysqlPoolMock(...args),
}))
vi.mock('../src/core/redis/client.js', () => ({
  getRedisClient: (...args: unknown[]) => getRedisClientMock(...args),
}))

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}

const makeRes = (): FakeResponse => {
  const res: FakeResponse = {
    statusCode: 200,
    headers: {},
    body: '',
    headersSent: false,
    setHeader: vi.fn((key: string, value: string) => {
      res.headers[key] = value
    }),
    end: vi.fn((body?: string) => {
      res.body = body ?? ''
      res.headersSent = true
    }),
  }
  return res
}

describe('handleHealthRoutes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConfig.healthEnabled = true
    mockConfig.mysqlUrl = null
    mockConfig.redisUrl = null
    mockConfig.bootstrapConnectionsEnabled = true
    mockConfig.apiEnabled = true
    mockConfig.webhookSharedSecret = 'segredo-webhook'
    listConnectionsMock.mockReturnValue([])
    listManagedConnectionsMock.mockResolvedValue([])
    getMysqlPoolMock.mockReturnValue(null)
    getRedisClientMock.mockResolvedValue({ ping: vi.fn(async () => 'PONG') })
  })

  it('retorna false para rota não-health', async () => {
    const { handleHealthRoutes } = await import('../src/api/routes/health.ts')
    const res = makeRes()
    const handled = await handleHealthRoutes({ method: 'GET', url: '/connections' } as IncomingMessage, res as unknown as ServerResponse, '/connections', logger)
    expect(handled).toBe(false)
  })

  it('responde /health/live com 200', async () => {
    const { handleHealthRoutes } = await import('../src/api/routes/health.ts')
    const res = makeRes()
    const handled = await handleHealthRoutes({ method: 'GET', url: '/health/live' } as IncomingMessage, res as unknown as ServerResponse, '/health/live', logger)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body) as { ok: boolean; live: boolean }
    expect(data.ok).toBe(true)
    expect(data.live).toBe(true)
  })

  it('responde /health/ready com 200 quando checks estão saudáveis', async () => {
    const { handleHealthRoutes } = await import('../src/api/routes/health.ts')
    const res = makeRes()
    const handled = await handleHealthRoutes({ method: 'GET', url: '/health/ready' } as IncomingMessage, res as unknown as ServerResponse, '/health/ready', logger)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body) as { ready: boolean }
    expect(data.ready).toBe(true)
  })

  it('responde /health/ready com 503 quando mysql falha', async () => {
    mockConfig.mysqlUrl = 'mysql://user:pass@localhost:3306/zyra'
    getMysqlPoolMock.mockReturnValue({
      query: vi.fn(async () => {
        throw new Error('mysql indisponível')
      }),
    })
    const { handleHealthRoutes } = await import('../src/api/routes/health.ts')
    const res = makeRes()
    const handled = await handleHealthRoutes({ method: 'GET', url: '/health/ready' } as IncomingMessage, res as unknown as ServerResponse, '/health/ready', logger)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(503)
    const data = JSON.parse(res.body) as { ready: boolean }
    expect(data.ready).toBe(false)
  })

  it('responde /health/connections com resumo por estado', async () => {
    listConnectionsMock.mockReturnValue([
      {
        connectionId: 'conn-open',
        label: null,
        status: 'open',
        socketGeneration: 1,
        lastReconnectAt: 0,
        reconnectInFlight: false,
        socketActive: true,
        qrCode: null,
        qrCodeAt: null,
      },
      {
        connectionId: 'conn-connecting',
        label: null,
        status: 'connecting',
        socketGeneration: 2,
        lastReconnectAt: 0,
        reconnectInFlight: true,
        socketActive: false,
        qrCode: null,
        qrCodeAt: null,
      },
    ])
    listManagedConnectionsMock.mockResolvedValue([
      {
        connectionId: 'conn-paused',
        displayName: 'Paused',
        status: 'paused',
        desiredState: 'paused',
        enabled: true,
        pairingState: 'not_required',
        pairingCode: null,
        lastSeenAt: null,
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        lastDisconnectCode: null,
        lastError: null,
        webhookSource: null,
        metadata: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ])

    const { handleHealthRoutes } = await import('../src/api/routes/health.ts')
    const res = makeRes()
    const handled = await handleHealthRoutes({ method: 'GET', url: '/health/connections' } as IncomingMessage, res as unknown as ServerResponse, '/health/connections', logger)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body) as { total: number; open: number; connecting: number; paused: number; error: number }
    expect(data.total).toBe(3)
    expect(data.open).toBe(1)
    expect(data.connecting).toBe(1)
    expect(data.paused).toBe(1)
    expect(data.error).toBe(0)
  })
})
