import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionInfo, ConnectionStatus } from '../src/core/connection/manager.js'

type FakeResponse = {
  statusCode: number
  headers: Record<string, string>
  body: string
  headersSent: boolean
  setHeader: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

const createConnectionMock = vi.fn()
const listConnectionsMock = vi.fn()
const getConnectionMock = vi.fn()
const setConnectionLabelMock = vi.fn()
const connectMock = vi.fn(async () => undefined)
const disconnectMock = vi.fn(async () => undefined)
const restartMock = vi.fn(async () => undefined)
const deleteConnectionMock = vi.fn(async () => undefined)
const startPairingMock = vi.fn(async () => ({
  connectionId: 'test-id',
  status: 'pending',
  qrCode: null,
  qrUpdatedAt: null,
  qrExpiresAt: null,
  startedAt: Date.now(),
  finishedAt: null,
  error: null,
}))
const getPairingStateMock = vi.fn(async () => ({
  connectionId: 'test-id',
  status: 'pending',
  qrCode: null,
  qrUpdatedAt: null,
  qrExpiresAt: null,
  startedAt: Date.now(),
  finishedAt: null,
  error: null,
}))
const cancelPairingMock = vi.fn(async () => ({
  connectionId: 'test-id',
  status: 'cancelled',
  qrCode: null,
  qrUpdatedAt: null,
  qrExpiresAt: null,
  startedAt: Date.now(),
  finishedAt: Date.now(),
  error: 'pairing cancelado',
}))

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}

const mockConfig = {
  bootstrapConnectionsEnabled: true,
  webhookSharedSecret: 'test-secret' as string | null,
  apiHost: '127.0.0.1',
  apiPort: 3000,
  webhookTimeoutMs: 5000,
}

vi.mock('../src/config/index.js', () => ({
  config: mockConfig,
}))

vi.mock('../src/core/connection/manager.js', () => ({
  createConnection: (...args: unknown[]) => createConnectionMock(...args),
  listConnections: (...args: unknown[]) => listConnectionsMock(...args),
  getConnection: (...args: unknown[]) => getConnectionMock(...args),
  setConnectionLabel: (...args: unknown[]) => setConnectionLabelMock(...args),
  connect: (...args: unknown[]) => connectMock(...args),
  disconnect: (...args: unknown[]) => disconnectMock(...args),
  restart: (...args: unknown[]) => restartMock(...args),
  deleteConnection: (...args: unknown[]) => deleteConnectionMock(...args),
}))
vi.mock('../src/core/connection/pairing-service.js', () => ({
  startPairing: (...args: unknown[]) => startPairingMock(...args),
  getPairingState: (...args: unknown[]) => getPairingStateMock(...args),
  cancelPairing: (...args: unknown[]) => cancelPairingMock(...args),
}))

const makeInfo = (overrides: Partial<ConnectionInfo> = {}): ConnectionInfo => ({
  connectionId: 'test-id',
  label: null,
  status: 'created' as ConnectionStatus,
  socketGeneration: 0,
  lastReconnectAt: 0,
  reconnectInFlight: false,
  socketActive: false,
  qrCode: null,
  qrCodeAt: null,
  ...overrides,
})

const createResponse = (): FakeResponse => {
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

const makeReq = (method: string, url: string, body = '') => ({
  method,
  url,
  headers: { 'content-type': 'application/json' },
  on: vi.fn((event: string, cb: (chunk?: unknown) => void) => {
    if (event === 'data' && body) cb(Buffer.from(body))
    if (event === 'end') cb()
  }),
})

describe('handleConnectionsRoutes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    listConnectionsMock.mockReturnValue([])
    getConnectionMock.mockReturnValue(null)
    mockConfig.bootstrapConnectionsEnabled = true
    mockConfig.webhookSharedSecret = 'test-secret'
    mockConfig.apiHost = '127.0.0.1'
    mockConfig.apiPort = 3000
    mockConfig.webhookTimeoutMs = 5000
  })

  it('GET /connections retorna lista vazia', async () => {
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    const handled = await handleConnectionsRoutes(makeReq('GET', '/connections') as never, res as never, '/connections', logger as never)

    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  it('GET /connections retorna lista com itens', async () => {
    listConnectionsMock.mockReturnValue([makeInfo({ connectionId: 'a' }), makeInfo({ connectionId: 'b' })])
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('GET', '/connections') as never, res as never, '/connections', logger as never)

    const data = JSON.parse(res.body) as ConnectionInfo[]
    expect(data).toHaveLength(2)
    expect(data.map((c) => c.connectionId)).toEqual(['a', 'b'])
  })

  it('POST /connections cria conexão com connectionId válido', async () => {
    getConnectionMock.mockReturnValue(null)
    createConnectionMock.mockReturnValue(makeInfo({ connectionId: 'nova' }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    const body = JSON.stringify({ connectionId: 'nova' })
    await handleConnectionsRoutes(makeReq('POST', '/connections', body) as never, res as never, '/connections', logger as never)

    expect(res.statusCode).toBe(201)
    expect(createConnectionMock).toHaveBeenCalledWith('nova')
  })

  it('POST /connections retorna 400 sem connectionId', async () => {
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('POST', '/connections', '{}') as never, res as never, '/connections', logger as never)

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('connectionId') })
  })

  it('POST /connections retorna 400 para connectionId inválido', async () => {
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    const body = JSON.stringify({ connectionId: '../invalido' })
    await handleConnectionsRoutes(makeReq('POST', '/connections', body) as never, res as never, '/connections', logger as never)

    expect(res.statusCode).toBe(400)
    expect(createConnectionMock).not.toHaveBeenCalled()
  })

  it('POST /connections retorna 409 para connectionId duplicado', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'existente' }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    const body = JSON.stringify({ connectionId: 'existente' })
    await handleConnectionsRoutes(makeReq('POST', '/connections', body) as never, res as never, '/connections', logger as never)

    expect(res.statusCode).toBe(409)
  })

  it('GET /connections/:id retorna 404 para id inexistente', async () => {
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('GET', '/connections/nao-existe') as never, res as never, '/connections/nao-existe', logger as never)

    expect(res.statusCode).toBe(404)
  })

  it('GET /connections/:id retorna info da conexão', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-1', status: 'open' }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('GET', '/connections/sess-1') as never, res as never, '/connections/sess-1', logger as never)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body) as ConnectionInfo
    expect(data.connectionId).toBe('sess-1')
    expect(data.status).toBe('open')
  })

  it('PATCH /connections/:id atualiza label', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-patch', label: 'Novo Label' }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    const body = JSON.stringify({ label: 'Novo Label' })
    await handleConnectionsRoutes(makeReq('PATCH', '/connections/sess-patch', body) as never, res as never, '/connections/sess-patch', logger as never)

    expect(res.statusCode).toBe(200)
    expect(setConnectionLabelMock).toHaveBeenCalledWith('sess-patch', 'Novo Label')
  })

  it('DELETE /connections/:id retorna 204', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-del' }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('DELETE', '/connections/sess-del') as never, res as never, '/connections/sess-del', logger as never)

    expect(res.statusCode).toBe(204)
    expect(deleteConnectionMock).toHaveBeenCalledWith('sess-del', logger)
  })

  it('POST /connections/:id/connect chama connect', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-conn', status: 'connecting' }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('POST', '/connections/sess-conn/connect') as never, res as never, '/connections/sess-conn/connect', logger as never)

    expect(res.statusCode).toBe(200)
    expect(connectMock).toHaveBeenCalledWith('sess-conn', logger)
  })

  it('POST /connections/:id/start funciona como alias de connect', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-start', status: 'connecting' }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('POST', '/connections/sess-start/start') as never, res as never, '/connections/sess-start/start', logger as never)

    expect(res.statusCode).toBe(200)
    expect(connectMock).toHaveBeenCalledWith('sess-start', logger)
  })

  it('POST /connections/:id/disconnect chama disconnect', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-disc', status: 'closed' }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('POST', '/connections/sess-disc/disconnect') as never, res as never, '/connections/sess-disc/disconnect', logger as never)

    expect(res.statusCode).toBe(200)
    expect(disconnectMock).toHaveBeenCalledWith('sess-disc', logger)
  })

  it('POST /connections/:id/restart chama restart', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-rest', status: 'connecting' }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('POST', '/connections/sess-rest/restart') as never, res as never, '/connections/sess-rest/restart', logger as never)

    expect(res.statusCode).toBe(200)
    expect(restartMock).toHaveBeenCalledWith('sess-rest', logger)
  })

  it('POST /connections/:id/reconnect funciona como alias de restart', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-reconn', status: 'connecting' }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('POST', '/connections/sess-reconn/reconnect') as never, res as never, '/connections/sess-reconn/reconnect', logger as never)

    expect(res.statusCode).toBe(200)
    expect(restartMock).toHaveBeenCalledWith('sess-reconn', logger)
  })

  it('GET /connections/:id/status retorna status resumido', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-stat', status: 'open', socketActive: true }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('GET', '/connections/sess-stat/status') as never, res as never, '/connections/sess-stat/status', logger as never)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body) as { connectionId: string; status: string; socketActive: boolean }
    expect(data.status).toBe('open')
    expect(data.socketActive).toBe(true)
  })

  it('GET /connections/:id/qr retorna QR disponível', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-qr', qrCode: 'qr-data', qrCodeAt: 1000 }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('GET', '/connections/sess-qr/qr') as never, res as never, '/connections/sess-qr/qr', logger as never)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body) as { qrCode: string }
    expect(data.qrCode).toBe('qr-data')
  })

  it('GET /connections/:id/qr retorna 404 quando QR não disponível', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-no-qr', qrCode: null }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('GET', '/connections/sess-no-qr/qr') as never, res as never, '/connections/sess-no-qr/qr', logger as never)

    expect(res.statusCode).toBe(404)
  })

  it('POST /connections/:id/pairing/start inicia pairing', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-pairing' }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('POST', '/connections/sess-pairing/pairing/start') as never, res as never, '/connections/sess-pairing/pairing/start', logger as never)

    expect(res.statusCode).toBe(202)
    expect(startPairingMock).toHaveBeenCalledWith('sess-pairing')
  })

  it('GET /connections/:id/pairing retorna estado atual', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-pairing' }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('GET', '/connections/sess-pairing/pairing') as never, res as never, '/connections/sess-pairing/pairing', logger as never)

    expect(res.statusCode).toBe(200)
    expect(getPairingStateMock).toHaveBeenCalledWith('sess-pairing')
  })

  it('POST /connections/:id/pairing/cancel cancela pairing', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-pairing' }))
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('POST', '/connections/sess-pairing/pairing/cancel') as never, res as never, '/connections/sess-pairing/pairing/cancel', logger as never)

    expect(res.statusCode).toBe(200)
    expect(cancelPairingMock).toHaveBeenCalledWith('sess-pairing')
  })

  it('POST /connections/:id/webhook/start envia comando assinado para ingress de webhook', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-webhook' }))
    const fetchMock = vi.fn(async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          accepted: true,
          action: 'start',
          connection_id: 'sess-webhook',
        }),
    }))
    vi.stubGlobal('fetch', fetchMock as never)

    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('POST', '/connections/sess-webhook/webhook/start', JSON.stringify({ label: 'Bot X' })) as never, res as never, '/connections/sess-webhook/webhook/start', logger as never)

    expect(res.statusCode).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('http://127.0.0.1:3000/webhooks/connections')
    expect(options['method']).toBe('POST')
    expect(options['headers']).toMatchObject({
      'content-type': 'application/json',
    })
    const payload = JSON.parse(res.body) as { accepted?: boolean }
    expect(payload.accepted).toBe(true)
  })

  it('POST /connections/:id/webhook/start retorna 503 quando segredo do webhook não está configurado', async () => {
    mockConfig.webhookSharedSecret = null
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-no-secret' }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock as never)

    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    await handleConnectionsRoutes(makeReq('POST', '/connections/sess-no-secret/webhook/start') as never, res as never, '/connections/sess-no-secret/webhook/start', logger as never)

    expect(res.statusCode).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.parse(res.body)).toMatchObject({
      error: expect.stringContaining('WA_WEBHOOK_SHARED_SECRET'),
    })
  })

  it('retorna false para rota não reconhecida', async () => {
    const { handleConnectionsRoutes } = await import('../src/api/routes/connections.ts')
    const res = createResponse()
    const handled = await handleConnectionsRoutes(makeReq('GET', '/other') as never, res as never, '/other', logger as never)

    expect(handled).toBe(false)
  })
})
