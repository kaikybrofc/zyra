import { beforeEach, describe, expect, it, vi } from 'vitest'

type RequestHandler = (req: FakeRequest, res: FakeResponse) => Promise<void> | void

type FakeRequest = {
  method?: string
  url?: string
  headers: Record<string, string>
  on: ReturnType<typeof vi.fn>
}

type FakeResponse = {
  statusCode: number
  headers: Record<string, string>
  body: string
  headersSent: boolean
  setHeader: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

const mockConfig = {
  apiKey: null as string | null,
  apiPort: 3000,
  apiHost: '0.0.0.0',
}

let serverHandler: RequestHandler | null = null
const serverListenMock = vi.fn((_port: number, _host: string, cb?: () => void) => cb?.())
const serverCloseMock = vi.fn((cb?: (error?: Error | null) => void) => cb?.(null))

const handleConnectionsRoutesMock = vi.fn(async () => false)
const handleMessagesRoutesMock = vi.fn(async () => false)
const handleGroupsRoutesMock = vi.fn(async () => false)
const handleWebhooksRoutesMock = vi.fn(async () => false)
const handleGlobalWebhooksRoutesMock = vi.fn(async () => false)
const handleConnectionWebhookRoutesMock = vi.fn(async () => false)
const handleHealthRoutesMock = vi.fn(async () => false)

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
vi.mock('../src/api/routes/connections.js', () => ({
  handleConnectionsRoutes: (...args: unknown[]) => handleConnectionsRoutesMock(...args),
}))
vi.mock('../src/api/routes/messages.js', () => ({
  handleMessagesRoutes: (...args: unknown[]) => handleMessagesRoutesMock(...args),
}))
vi.mock('../src/api/routes/groups.js', () => ({
  handleGroupsRoutes: (...args: unknown[]) => handleGroupsRoutesMock(...args),
}))
vi.mock('../src/api/routes/webhooks.js', () => ({
  handleWebhooksRoutes: (...args: unknown[]) => handleWebhooksRoutesMock(...args),
}))
vi.mock('../src/api/routes/webhooks-global.js', () => ({
  handleGlobalWebhooksRoutes: (...args: unknown[]) => handleGlobalWebhooksRoutesMock(...args),
}))
vi.mock('../src/api/routes/connection-webhook.js', () => ({
  handleConnectionWebhookRoutes: (...args: unknown[]) => handleConnectionWebhookRoutesMock(...args),
}))
vi.mock('../src/api/routes/health.js', () => ({
  handleHealthRoutes: (...args: unknown[]) => handleHealthRoutesMock(...args),
}))

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}

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

const makeReq = (method: string, url: string, headers: Record<string, string> = {}): FakeRequest => ({
  method,
  url,
  headers,
  on: vi.fn(),
})

describe('startApiServer', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    serverHandler = null
    mockConfig.apiKey = null
    mockConfig.apiPort = 3000
    mockConfig.apiHost = '0.0.0.0'
    handleConnectionsRoutesMock.mockResolvedValue(false)
    handleMessagesRoutesMock.mockResolvedValue(false)
    handleGroupsRoutesMock.mockResolvedValue(false)
    handleWebhooksRoutesMock.mockResolvedValue(false)
    handleGlobalWebhooksRoutesMock.mockResolvedValue(false)
    handleConnectionWebhookRoutesMock.mockResolvedValue(false)
    handleHealthRoutesMock.mockResolvedValue(false)
  })

  it('sobe servidor na porta e host configurados', async () => {
    mockConfig.apiPort = 4000
    mockConfig.apiHost = '127.0.0.1'
    const { startApiServer } = await import('../src/api/server.ts')
    startApiServer({ logger: logger as never })

    expect(serverListenMock).toHaveBeenCalledWith(4000, '127.0.0.1', expect.any(Function))
  })

  it('encaminha para handleConnectionsRoutes', async () => {
    handleConnectionsRoutesMock.mockResolvedValue(true)
    const { startApiServer } = await import('../src/api/server.ts')
    startApiServer({ logger: logger as never })

    const res = createResponse()
    await serverHandler?.(makeReq('GET', '/connections'), res)

    expect(handleConnectionsRoutesMock).toHaveBeenCalled()
    expect(res.statusCode).not.toBe(404)
  })

  it('encaminha para handleMessagesRoutes', async () => {
    handleMessagesRoutesMock.mockResolvedValue(true)
    const { startApiServer } = await import('../src/api/server.ts')
    startApiServer({ logger: logger as never })

    const res = createResponse()
    await serverHandler?.(makeReq('POST', '/connections/sess/messages/send'), res)

    expect(handleMessagesRoutesMock).toHaveBeenCalled()
  })

  it('encaminha para handleGroupsRoutes', async () => {
    handleGroupsRoutesMock.mockResolvedValue(true)
    const { startApiServer } = await import('../src/api/server.ts')
    startApiServer({ logger: logger as never })

    const res = createResponse()
    await serverHandler?.(makeReq('GET', '/connections/sess/groups'), res)

    expect(handleGroupsRoutesMock).toHaveBeenCalled()
  })

  it('retorna 404 quando nenhuma rota reconhece o path', async () => {
    const { startApiServer } = await import('../src/api/server.ts')
    startApiServer({ logger: logger as never })

    const res = createResponse()
    await serverHandler?.(makeReq('GET', '/rota-inexistente'), res)

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.any(String) })
  })

  it('retorna 401 sem token quando apiKey está configurada', async () => {
    mockConfig.apiKey = 'minha-chave'
    const { startApiServer } = await import('../src/api/server.ts')
    startApiServer({ logger: logger as never })

    const res = createResponse()
    await serverHandler?.(makeReq('GET', '/connections'), res)

    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'não autorizado' })
  })

  it('processa webhook de conexões sem exigir Bearer token', async () => {
    mockConfig.apiKey = 'minha-chave'
    handleConnectionWebhookRoutesMock.mockResolvedValue(true)
    const { startApiServer } = await import('../src/api/server.ts')
    startApiServer({ logger: logger as never })

    const res = createResponse()
    await serverHandler?.(makeReq('POST', '/webhooks/connections'), res)

    expect(handleConnectionWebhookRoutesMock).toHaveBeenCalled()
    expect(res.statusCode).not.toBe(401)
  })

  it('processa health sem exigir Bearer token', async () => {
    mockConfig.apiKey = 'minha-chave'
    handleHealthRoutesMock.mockResolvedValue(true)
    const { startApiServer } = await import('../src/api/server.ts')
    startApiServer({ logger: logger as never })

    const res = createResponse()
    await serverHandler?.(makeReq('GET', '/health/live'), res)

    expect(handleHealthRoutesMock).toHaveBeenCalled()
    expect(res.statusCode).not.toBe(401)
  })

  it('retorna 401 com token incorreto', async () => {
    mockConfig.apiKey = 'chave-correta'
    const { startApiServer } = await import('../src/api/server.ts')
    startApiServer({ logger: logger as never })

    const res = createResponse()
    await serverHandler?.(makeReq('GET', '/connections', { authorization: 'Bearer chave-errada' }), res)

    expect(res.statusCode).toBe(401)
  })

  it('permite acesso com token correto', async () => {
    mockConfig.apiKey = 'minha-chave'
    handleConnectionsRoutesMock.mockResolvedValue(true)
    const { startApiServer } = await import('../src/api/server.ts')
    startApiServer({ logger: logger as never })

    const res = createResponse()
    await serverHandler?.(makeReq('GET', '/connections', { authorization: 'Bearer minha-chave' }), res)

    expect(handleConnectionsRoutesMock).toHaveBeenCalled()
    expect(res.statusCode).not.toBe(401)
  })

  it('retorna 500 e loga quando um handler lança erro', async () => {
    handleConnectionsRoutesMock.mockRejectedValue(new Error('crash interno'))
    const { startApiServer } = await import('../src/api/server.ts')
    startApiServer({ logger: logger as never })

    const res = createResponse()
    await serverHandler?.(makeReq('GET', '/connections'), res)

    expect(res.statusCode).toBe(500)
    expect(logger.error).toHaveBeenCalled()
  })

  it('stop encerra o servidor HTTP', async () => {
    const { startApiServer } = await import('../src/api/server.ts')
    const handle = startApiServer({ logger: logger as never })

    await expect(handle.stop()).resolves.toBeUndefined()
    expect(serverCloseMock).toHaveBeenCalled()
  })

  it('encaminha para handleWebhooksRoutes', async () => {
    handleWebhooksRoutesMock.mockResolvedValue(true)
    const { startApiServer } = await import('../src/api/server.ts')
    startApiServer({ logger: logger as never })

    const res = createResponse()
    await serverHandler?.(makeReq('GET', '/connections/sess/webhooks'), res)

    expect(handleWebhooksRoutesMock).toHaveBeenCalled()
    expect(res.statusCode).not.toBe(404)
  })

  it('encaminha para handleGlobalWebhooksRoutes', async () => {
    handleGlobalWebhooksRoutesMock.mockResolvedValue(true)
    const { startApiServer } = await import('../src/api/server.ts')
    startApiServer({ logger: logger as never })

    const res = createResponse()
    await serverHandler?.(makeReq('GET', '/webhooks'), res)

    expect(handleGlobalWebhooksRoutesMock).toHaveBeenCalled()
    expect(res.statusCode).not.toBe(404)
  })
})
