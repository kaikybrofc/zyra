import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

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

const createWebhookMock = vi.fn()
const listWebhooksMock = vi.fn()
const getWebhookMock = vi.fn()
const updateWebhookMock = vi.fn()
const deleteWebhookMock = vi.fn()
const listDeliveriesMock = vi.fn()
const retryDeliveryMock = vi.fn()
const getDeliveryMock = vi.fn()
const attemptDeliveryMock = vi.fn()
const mockConfig = {
  webhookAllowedTargets: ['https://x.com/', 'https://new.com/'],
}

vi.mock('../src/config/index.js', () => ({
  config: mockConfig,
}))

vi.mock('../src/webhook/store.js', () => ({
  GLOBAL_WEBHOOK_CONNECTION_ID: '__global__',
  createWebhook: (...a: unknown[]) => createWebhookMock(...a),
  listWebhooks: (...a: unknown[]) => listWebhooksMock(...a),
  getWebhook: (...a: unknown[]) => getWebhookMock(...a),
  updateWebhook: (...a: unknown[]) => updateWebhookMock(...a),
  deleteWebhook: (...a: unknown[]) => deleteWebhookMock(...a),
  listDeliveries: (...a: unknown[]) => listDeliveriesMock(...a),
  retryDelivery: (...a: unknown[]) => retryDeliveryMock(...a),
  getDelivery: (...a: unknown[]) => getDeliveryMock(...a),
}))

vi.mock('../src/webhook/delivery.js', () => ({
  attemptDelivery: (...a: unknown[]) => attemptDeliveryMock(...a),
}))

const stubLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }

const makeReq = (method: string, url: string, body: unknown = undefined): FakeRequest => {
  const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null
  const req: FakeRequest = { method, url, headers: { 'content-type': 'application/json' }, on: vi.fn() }
  req.on.mockImplementation((event: string, cb: (chunk?: Buffer) => void) => {
    if (event === 'data' && bodyBuf) cb(bodyBuf)
    if (event === 'end') cb()
  })
  return req
}

const makeRes = (): FakeResponse => {
  const res: FakeResponse = {
    statusCode: 200,
    headers: {},
    body: '',
    headersSent: false,
    setHeader: vi.fn((k: string, v: string) => {
      res.headers[k] = v
    }),
    end: vi.fn((b?: string) => {
      res.body = b ?? ''
      res.headersSent = true
    }),
  }
  return res
}

describe('handleGlobalWebhooksRoutes', () => {
  let handleGlobalWebhooksRoutes: (req: IncomingMessage, res: ServerResponse, pathname: string, logger: typeof stubLogger) => Promise<boolean>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()

    listWebhooksMock.mockResolvedValue([])
    getWebhookMock.mockResolvedValue(null)
    createWebhookMock.mockResolvedValue({
      id: 'wh1',
      connectionId: '__global__',
      url: 'https://x.com',
      eventsFilter: ['*'],
      active: true,
      secret: null,
      createdAt: 0,
      updatedAt: 0,
    })
    updateWebhookMock.mockResolvedValue(null)
    deleteWebhookMock.mockResolvedValue(false)
    listDeliveriesMock.mockResolvedValue([])
    retryDeliveryMock.mockResolvedValue(null)
    getDeliveryMock.mockReturnValue(null)
    attemptDeliveryMock.mockResolvedValue(undefined)

    const mod = await import('../src/api/routes/webhooks-global.ts')
    handleGlobalWebhooksRoutes = mod.handleGlobalWebhooksRoutes as never
  })

  it('GET /webhooks — lista webhooks globais', async () => {
    listWebhooksMock.mockResolvedValue([{ id: 'w1', connectionId: '__global__' }])
    const res = makeRes()
    const handled = await handleGlobalWebhooksRoutes(makeReq('GET', '/webhooks') as never, res as never, '/webhooks', stubLogger as never)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(1)
    expect(listWebhooksMock).toHaveBeenCalledWith('__global__')
  })

  it('POST /webhooks — cria webhook global', async () => {
    const res = makeRes()
    const handled = await handleGlobalWebhooksRoutes(makeReq('POST', '/webhooks', { url: 'https://x.com', eventsFilter: ['*'] }) as never, res as never, '/webhooks', stubLogger as never)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(201)
    expect(createWebhookMock).toHaveBeenCalledWith('__global__', expect.objectContaining({ url: 'https://x.com/' }))
  })

  it('POST /webhooks — retorna 400 sem url', async () => {
    const res = makeRes()
    await handleGlobalWebhooksRoutes(makeReq('POST', '/webhooks', { eventsFilter: ['*'] }) as never, res as never, '/webhooks', stubLogger as never)
    expect(res.statusCode).toBe(400)
  })

  it('POST /webhooks — retorna 400 sem eventsFilter', async () => {
    const res = makeRes()
    await handleGlobalWebhooksRoutes(makeReq('POST', '/webhooks', { url: 'https://x.com' }) as never, res as never, '/webhooks', stubLogger as never)
    expect(res.statusCode).toBe(400)
  })

  it('POST /webhooks — retorna 400 com url local', async () => {
    const res = makeRes()
    await handleGlobalWebhooksRoutes(makeReq('POST', '/webhooks', { url: 'http://localhost:3000/hook', eventsFilter: ['*'] }) as never, res as never, '/webhooks', stubLogger as never)
    expect(res.statusCode).toBe(400)
    expect(createWebhookMock).not.toHaveBeenCalled()
  })

  it('GET /webhooks/:wid — 404 quando não encontrado', async () => {
    const res = makeRes()
    const handled = await handleGlobalWebhooksRoutes(makeReq('GET', '/webhooks/nope') as never, res as never, '/webhooks/nope', stubLogger as never)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(getWebhookMock).toHaveBeenCalledWith('nope', '__global__')
  })

  it('GET /webhooks/:wid — retorna webhook existente', async () => {
    const wh = { id: 'wh1', connectionId: '__global__', url: 'https://x.com', eventsFilter: ['*'], active: true, secret: null, createdAt: 0, updatedAt: 0 }
    getWebhookMock.mockResolvedValue(wh)
    const res = makeRes()
    await handleGlobalWebhooksRoutes(makeReq('GET', '/webhooks/wh1') as never, res as never, '/webhooks/wh1', stubLogger as never)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'wh1', connectionId: '__global__' })
  })

  it('PATCH /webhooks/:wid — atualiza webhook global', async () => {
    const updated = { id: 'wh1', connectionId: '__global__', url: 'https://new.com', eventsFilter: ['*'], active: true, secret: null, createdAt: 0, updatedAt: 1 }
    updateWebhookMock.mockResolvedValue(updated)
    const res = makeRes()
    await handleGlobalWebhooksRoutes(makeReq('PATCH', '/webhooks/wh1', { url: 'https://new.com' }) as never, res as never, '/webhooks/wh1', stubLogger as never)
    expect(res.statusCode).toBe(200)
    expect(updateWebhookMock).toHaveBeenCalledWith('wh1', '__global__', expect.any(Object))
  })

  it('PATCH /webhooks/:wid — retorna 400 com url local', async () => {
    const res = makeRes()
    await handleGlobalWebhooksRoutes(makeReq('PATCH', '/webhooks/wh1', { url: 'http://127.0.0.1/hook' }) as never, res as never, '/webhooks/wh1', stubLogger as never)
    expect(res.statusCode).toBe(400)
    expect(updateWebhookMock).not.toHaveBeenCalled()
  })

  it('PATCH /webhooks/:wid — 404 quando não encontrado', async () => {
    updateWebhookMock.mockResolvedValue(null)
    const res = makeRes()
    await handleGlobalWebhooksRoutes(makeReq('PATCH', '/webhooks/nope', { active: false }) as never, res as never, '/webhooks/nope', stubLogger as never)
    expect(res.statusCode).toBe(404)
  })

  it('DELETE /webhooks/:wid — 204 ao deletar', async () => {
    deleteWebhookMock.mockResolvedValue(true)
    const res = makeRes()
    await handleGlobalWebhooksRoutes(makeReq('DELETE', '/webhooks/wh1') as never, res as never, '/webhooks/wh1', stubLogger as never)
    expect(res.statusCode).toBe(204)
    expect(deleteWebhookMock).toHaveBeenCalledWith('wh1', '__global__')
  })

  it('DELETE /webhooks/:wid — 404 quando não encontrado', async () => {
    deleteWebhookMock.mockResolvedValue(false)
    const res = makeRes()
    await handleGlobalWebhooksRoutes(makeReq('DELETE', '/webhooks/nope') as never, res as never, '/webhooks/nope', stubLogger as never)
    expect(res.statusCode).toBe(404)
  })

  it('GET /webhooks/:wid/deliveries — lista entregas', async () => {
    const wh = { id: 'wh1', connectionId: '__global__', url: 'https://x.com', eventsFilter: ['*'], active: true, secret: null, createdAt: 0, updatedAt: 0 }
    getWebhookMock.mockResolvedValue(wh)
    listDeliveriesMock.mockResolvedValue([{ id: 'd1', status: 'delivered' }])
    const res = makeRes()
    const handled = await handleGlobalWebhooksRoutes(makeReq('GET', '/webhooks/wh1/deliveries') as never, res as never, '/webhooks/wh1/deliveries', stubLogger as never)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(1)
  })

  it('retorna false para rotas não reconhecidas', async () => {
    const res = makeRes()
    const handled = await handleGlobalWebhooksRoutes(makeReq('GET', '/outra-rota') as never, res as never, '/outra-rota', stubLogger as never)
    expect(handled).toBe(false)
  })

  it('retorna false para /connections/:id/webhooks (rota por instância)', async () => {
    const res = makeRes()
    const handled = await handleGlobalWebhooksRoutes(makeReq('GET', '/connections/sess/webhooks') as never, res as never, '/connections/sess/webhooks', stubLogger as never)
    expect(handled).toBe(false)
  })
})
