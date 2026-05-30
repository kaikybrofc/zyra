import { beforeEach, describe, expect, it, vi } from 'vitest'

type RequestHandler = (req: { url?: string }, res: FakeResponse) => Promise<void> | void

type FakeResponse = {
  statusCode: number
  headers: Record<string, string>
  body: string
  setHeader: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

const mockConfig = {
  antibanEnabled: true,
  antibanMetricsEnabled: true,
  antibanMetricsPath: '/metrics',
  antibanMetricsPort: 9108,
  antibanMetricsHost: '127.0.0.1',
}

let serverHandler: RequestHandler | null = null
const serverListenMock = vi.fn((_port: number, _host: string, cb?: () => void) => cb?.())
const serverCloseMock = vi.fn((cb?: (error?: Error | null) => void) => cb?.(null))
const metricsHandleMock = vi.fn(async (_req, res: FakeResponse) => {
  res.statusCode = 200
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end('metrics-body')
})
const createMetricsHandlerMock = vi.fn(() => ({
  handle: (...args: Parameters<typeof metricsHandleMock>) => metricsHandleMock(...args),
}))

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('node:http', () => ({
  createServer: (handler: RequestHandler) => {
    serverHandler = handler
    return {
      listen: (...args: Parameters<typeof serverListenMock>) => serverListenMock(...args),
      close: (...args: Parameters<typeof serverCloseMock>) => serverCloseMock(...args),
    }
  },
}))
vi.mock('baileys-antiban', () => ({
  createMetricsHandler: (...args: Parameters<typeof createMetricsHandlerMock>) => createMetricsHandlerMock(...args),
}))

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}

const createResponse = (): FakeResponse => {
  const response: FakeResponse = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader: vi.fn((key: string, value: string) => {
      response.headers[key] = value
    }),
    end: vi.fn((body?: string) => {
      response.body = body ?? ''
    }),
  }
  return response
}

describe('antiban metrics server', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    serverHandler = null
    mockConfig.antibanEnabled = true
    mockConfig.antibanMetricsEnabled = true
    mockConfig.antibanMetricsPath = '/metrics'
    mockConfig.antibanMetricsPort = 9108
    mockConfig.antibanMetricsHost = '127.0.0.1'
    metricsHandleMock.mockImplementation(async (_req, res: FakeResponse) => {
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end('metrics-body')
    })
  })

  it('renderiza /ops com múltiplos connection_ids', async () => {
    const { startAntiBanMetricsServer } = await import('../src/observability/antiban-metrics.ts')
    startAntiBanMetricsServer({
      logger: logger as never,
      getStats: () => ({}),
      getOperationalSnapshots: () => [
        { connectionId: 'conn-a', socketActive: true, reconnectInFlight: false, socketGeneration: 1 },
        { connectionId: 'conn-b', socketActive: false, reconnectInFlight: true, socketGeneration: 2 },
      ],
    })

    const res = createResponse()
    await serverHandler?.({ url: '/metrics/ops' }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('zyra_antiban_socket_active{connection_id="conn-a"} 1')
    expect(res.body).toContain('zyra_antiban_reconnect_in_flight{connection_id="conn-b"} 1')
  })

  it('retorna JSON com operations para múltiplas conexões', async () => {
    const { startAntiBanMetricsServer } = await import('../src/observability/antiban-metrics.ts')
    startAntiBanMetricsServer({
      logger: logger as never,
      getStats: () => ({ ok: true }),
      getStatsByConnection: () => ({
        'conn-a': { sent: 2 },
        'conn-b': { sent: 4 },
      }),
      getOperationalSnapshots: () => [
        { connectionId: 'conn-a', socketActive: true },
        { connectionId: 'conn-b', socketActive: false },
      ],
    })

    const res = createResponse()
    await serverHandler?.({ url: '/metrics?format=json' }, res)

    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(res.body) as {
      stats: { ok: boolean }
      statsByConnection: Record<string, { sent: number }>
      operations: Array<{ connectionId: string }>
    }
    expect(payload.stats.ok).toBe(true)
    expect(payload.statsByConnection['conn-a']?.sent).toBe(2)
    expect(payload.statsByConnection['conn-b']?.sent).toBe(4)
    expect(payload.operations.map((entry) => entry.connectionId)).toEqual(['conn-a', 'conn-b'])
  })

  it('escapa caracteres especiais no connection_id do Prometheus', async () => {
    const { startAntiBanMetricsServer } = await import('../src/observability/antiban-metrics.ts')
    startAntiBanMetricsServer({
      logger: logger as never,
      getStats: () => ({}),
      getOperationalSnapshots: () => [{ connectionId: 'conn"a\\b', socketActive: true }],
    })

    const res = createResponse()
    await serverHandler?.({ url: '/metrics/ops' }, res)

    expect(res.body).toContain('connection_id="conn\\"a\\\\b"')
  })

  it('mantém snapshots operacionais mesmo quando stats estão vazios', async () => {
    const { startAntiBanMetricsServer } = await import('../src/observability/antiban-metrics.ts')
    startAntiBanMetricsServer({
      logger: logger as never,
      getStats: () => ({}),
      getOperationalSnapshots: () => [
        { connectionId: 'conn-a', socketActive: false },
        { connectionId: 'conn-b', socketActive: true },
      ],
    })

    const res = createResponse()
    await serverHandler?.({ url: '/metrics?format=json' }, res)

    const payload = JSON.parse(res.body) as { operations: Array<{ connectionId: string; socketActive?: boolean }> }
    expect(payload.operations).toEqual([expect.objectContaining({ connectionId: 'conn-a', socketActive: false }), expect.objectContaining({ connectionId: 'conn-b', socketActive: true })])
  })

  it('responde 404 para rotas desconhecidas', async () => {
    const { startAntiBanMetricsServer } = await import('../src/observability/antiban-metrics.ts')
    startAntiBanMetricsServer({
      logger: logger as never,
      getStats: () => ({}),
    })

    const res = createResponse()
    await serverHandler?.({ url: '/other' }, res)

    expect(res.statusCode).toBe(404)
    expect(res.body).toBe('not found')
  })

  it('retorna 500 quando metrics.handle falha', async () => {
    metricsHandleMock.mockRejectedValueOnce(new Error('boom'))
    const { startAntiBanMetricsServer } = await import('../src/observability/antiban-metrics.ts')
    startAntiBanMetricsServer({
      logger: logger as never,
      getStats: () => ({}),
    })

    const res = createResponse()
    await serverHandler?.({ url: '/metrics' }, res)

    expect(res.statusCode).toBe(500)
    expect(res.body).toBe('internal server error')
    expect(logger.error).toHaveBeenCalled()
  })

  it('não sobe o servidor quando métricas estão desabilitadas', async () => {
    mockConfig.antibanMetricsEnabled = false
    const { startAntiBanMetricsServer } = await import('../src/observability/antiban-metrics.ts')
    const handle = startAntiBanMetricsServer({
      logger: logger as never,
      getStats: () => ({}),
    })

    expect(serverListenMock).not.toHaveBeenCalled()
    await expect(handle.stop()).resolves.toBeUndefined()
  })
})
