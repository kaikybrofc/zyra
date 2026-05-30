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

describe('handleWebhooksRoutes', () => {
  let handleWebhooksRoutes: (req: IncomingMessage, res: ServerResponse, pathname: string, logger: typeof stubLogger) => Promise<boolean>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()

    listWebhooksMock.mockResolvedValue([])
    getWebhookMock.mockResolvedValue(null)
    createWebhookMock.mockResolvedValue({
      id: 'wh1',
      connectionId: 'conn1',
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

    const mod = await import('../src/api/routes/webhooks.ts')
    handleWebhooksRoutes = mod.handleWebhooksRoutes as never
  })

  it('GET /connections/:id/webhooks — lista webhooks', async () => {
    listWebhooksMock.mockResolvedValue([{ id: 'w1' }])
    const res = makeRes()
    const handled = await handleWebhooksRoutes(makeReq('GET', '/connections/conn1/webhooks') as never, res as never, '/connections/conn1/webhooks', stubLogger as never)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual([{ id: 'w1' }])
  })

  it('POST /connections/:id/webhooks — cria webhook', async () => {
    const res = makeRes()
    const handled = await handleWebhooksRoutes(makeReq('POST', '/connections/conn1/webhooks', { url: 'https://x.com', eventsFilter: ['*'] }) as never, res as never, '/connections/conn1/webhooks', stubLogger as never)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(201)
  })

  it('POST /connections/:id/webhooks — retorna 400 sem url', async () => {
    const res = makeRes()
    await handleWebhooksRoutes(makeReq('POST', '/connections/conn1/webhooks', { eventsFilter: ['*'] }) as never, res as never, '/connections/conn1/webhooks', stubLogger as never)
    expect(res.statusCode).toBe(400)
  })

  it('POST /connections/:id/webhooks — retorna 400 sem eventsFilter', async () => {
    const res = makeRes()
    await handleWebhooksRoutes(makeReq('POST', '/connections/conn1/webhooks', { url: 'https://x.com' }) as never, res as never, '/connections/conn1/webhooks', stubLogger as never)
    expect(res.statusCode).toBe(400)
  })

  it('POST /connections/:id/webhooks — retorna 400 com url local', async () => {
    const res = makeRes()
    await handleWebhooksRoutes(makeReq('POST', '/connections/conn1/webhooks', { url: 'http://localhost:3000/hook', eventsFilter: ['*'] }) as never, res as never, '/connections/conn1/webhooks', stubLogger as never)
    expect(res.statusCode).toBe(400)
    expect(createWebhookMock).not.toHaveBeenCalled()
  })

  it('GET /connections/:id/webhooks/:wid — 404 quando não encontrado', async () => {
    const res = makeRes()
    const handled = await handleWebhooksRoutes(makeReq('GET', '/connections/conn1/webhooks/nope') as never, res as never, '/connections/conn1/webhooks/nope', stubLogger as never)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
  })

  it('GET /connections/:id/webhooks/:wid — retorna webhook existente', async () => {
    const wh = { id: 'wh1', connectionId: 'conn1', url: 'https://x.com', eventsFilter: ['*'], active: true, secret: null, createdAt: 0, updatedAt: 0 }
    getWebhookMock.mockResolvedValue(wh)
    const res = makeRes()
    await handleWebhooksRoutes(makeReq('GET', '/connections/conn1/webhooks/wh1') as never, res as never, '/connections/conn1/webhooks/wh1', stubLogger as never)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'wh1' })
  })

  it('PATCH /connections/:id/webhooks/:wid — atualiza webhook', async () => {
    const updated = { id: 'wh1', connectionId: 'conn1', url: 'https://new.com', eventsFilter: ['*'], active: true, secret: null, createdAt: 0, updatedAt: 1 }
    updateWebhookMock.mockResolvedValue(updated)
    const res = makeRes()
    await handleWebhooksRoutes(makeReq('PATCH', '/connections/conn1/webhooks/wh1', { url: 'https://new.com' }) as never, res as never, '/connections/conn1/webhooks/wh1', stubLogger as never)
    expect(res.statusCode).toBe(200)
  })

  it('PATCH /connections/:id/webhooks/:wid — retorna 400 com url local', async () => {
    const res = makeRes()
    await handleWebhooksRoutes(makeReq('PATCH', '/connections/conn1/webhooks/wh1', { url: 'http://127.0.0.1/hook' }) as never, res as never, '/connections/conn1/webhooks/wh1', stubLogger as never)
    expect(res.statusCode).toBe(400)
    expect(updateWebhookMock).not.toHaveBeenCalled()
  })

  it('PATCH /connections/:id/webhooks/:wid — 404 quando não encontrado', async () => {
    updateWebhookMock.mockResolvedValue(null)
    const res = makeRes()
    await handleWebhooksRoutes(makeReq('PATCH', '/connections/conn1/webhooks/nope', { active: false }) as never, res as never, '/connections/conn1/webhooks/nope', stubLogger as never)
    expect(res.statusCode).toBe(404)
  })

  it('DELETE /connections/:id/webhooks/:wid — 204 ao deletar', async () => {
    deleteWebhookMock.mockResolvedValue(true)
    const res = makeRes()
    await handleWebhooksRoutes(makeReq('DELETE', '/connections/conn1/webhooks/wh1') as never, res as never, '/connections/conn1/webhooks/wh1', stubLogger as never)
    expect(res.statusCode).toBe(204)
  })

  it('DELETE /connections/:id/webhooks/:wid — 404 quando não encontrado', async () => {
    deleteWebhookMock.mockResolvedValue(false)
    const res = makeRes()
    await handleWebhooksRoutes(makeReq('DELETE', '/connections/conn1/webhooks/nope') as never, res as never, '/connections/conn1/webhooks/nope', stubLogger as never)
    expect(res.statusCode).toBe(404)
  })

  it('GET /connections/:id/webhooks/:wid/deliveries — lista entregas', async () => {
    const wh = { id: 'wh1', connectionId: 'conn1', url: 'https://x.com', eventsFilter: ['*'], active: true, secret: null, createdAt: 0, updatedAt: 0 }
    getWebhookMock.mockResolvedValue(wh)
    listDeliveriesMock.mockResolvedValue([{ id: 'd1', status: 'delivered' }])
    const res = makeRes()
    const handled = await handleWebhooksRoutes(makeReq('GET', '/connections/conn1/webhooks/wh1/deliveries') as never, res as never, '/connections/conn1/webhooks/wh1/deliveries', stubLogger as never)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toHaveLength(1)
  })

  it('retorna false para rotas não reconhecidas', async () => {
    const res = makeRes()
    const handled = await handleWebhooksRoutes(makeReq('GET', '/outra-rota') as never, res as never, '/outra-rota', stubLogger as never)
    expect(handled).toBe(false)
  })
})
