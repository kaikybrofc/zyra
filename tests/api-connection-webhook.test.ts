import { createHmac } from 'node:crypto'
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

const mockConfig = {
  webhookSharedSecret: 'segredo-webhook',
  webhookMaxBodyBytes: 262_144,
  webhookTimestampToleranceMs: 300_000,
}

const connections = new Map<string, { connectionId: string; status: string; label: string | null }>()

const createConnectionMock = vi.fn((connectionId: string) => {
  const existing = connections.get(connectionId)
  if (existing) return existing
  const created = { connectionId, status: 'created', label: null }
  connections.set(connectionId, created)
  return created
})
const getConnectionMock = vi.fn((connectionId: string) => connections.get(connectionId) ?? null)
const connectMock = vi.fn(async (connectionId: string) => {
  const current = connections.get(connectionId) ?? { connectionId, status: 'created', label: null }
  current.status = 'connecting'
  connections.set(connectionId, current)
})
const restartMock = vi.fn(async (connectionId: string) => {
  const current = connections.get(connectionId) ?? { connectionId, status: 'created', label: null }
  current.status = 'connecting'
  connections.set(connectionId, current)
})
const disconnectMock = vi.fn(async (connectionId: string) => {
  const current = connections.get(connectionId) ?? { connectionId, status: 'created', label: null }
  current.status = 'closed'
  connections.set(connectionId, current)
})
const pauseMock = vi.fn(async (connectionId: string) => {
  const current = connections.get(connectionId) ?? { connectionId, status: 'created', label: null }
  current.status = 'paused'
  connections.set(connectionId, current)
})
const resumeMock = vi.fn(async (connectionId: string) => {
  const current = connections.get(connectionId) ?? { connectionId, status: 'created', label: null }
  current.status = 'connecting'
  connections.set(connectionId, current)
})
const deleteConnectionMock = vi.fn(async (connectionId: string) => {
  connections.delete(connectionId)
})
const setConnectionLabelMock = vi.fn((connectionId: string, label: string | null) => {
  const current = connections.get(connectionId) ?? { connectionId, status: 'created', label: null }
  current.label = label
  connections.set(connectionId, current)
})

const getWebhookCommandMock = vi.fn()
const saveWebhookCommandReceivedMock = vi.fn()
const finishWebhookCommandMock = vi.fn()
const startPairingMock = vi.fn(async () => ({
  connectionId: 'conn-pair',
  status: 'pending',
  qrCode: null,
  qrUpdatedAt: null,
  qrExpiresAt: null,
  startedAt: Date.now(),
  finishedAt: null,
  error: null,
}))
const cancelPairingMock = vi.fn(async () => ({
  connectionId: 'conn-pair',
  status: 'cancelled',
  qrCode: null,
  qrUpdatedAt: null,
  qrExpiresAt: null,
  startedAt: Date.now(),
  finishedAt: Date.now(),
  error: 'pairing cancelado',
}))

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/core/connection/manager.js', () => ({
  createConnection: (...args: unknown[]) => createConnectionMock(...args),
  getConnection: (...args: unknown[]) => getConnectionMock(...args),
  connect: (...args: unknown[]) => connectMock(...args),
  restart: (...args: unknown[]) => restartMock(...args),
  disconnect: (...args: unknown[]) => disconnectMock(...args),
  pause: (...args: unknown[]) => pauseMock(...args),
  resume: (...args: unknown[]) => resumeMock(...args),
  deleteConnection: (...args: unknown[]) => deleteConnectionMock(...args),
  setConnectionLabel: (...args: unknown[]) => setConnectionLabelMock(...args),
}))
vi.mock('../src/core/connection/pairing-service.js', () => ({
  startPairing: (...args: unknown[]) => startPairingMock(...args),
  cancelPairing: (...args: unknown[]) => cancelPairingMock(...args),
}))
vi.mock('../src/store/connection-admin-store.js', () => ({
  getWebhookCommand: (...args: unknown[]) => getWebhookCommandMock(...args),
  saveWebhookCommandReceived: (...args: unknown[]) => saveWebhookCommandReceivedMock(...args),
  finishWebhookCommand: (...args: unknown[]) => finishWebhookCommandMock(...args),
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

const signBody = (timestamp: string, body: string) =>
  createHmac('sha256', mockConfig.webhookSharedSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex')

const makeReq = (body: string, headers: Record<string, string> = {}): FakeRequest => {
  const req: FakeRequest = {
    method: 'POST',
    url: '/webhooks/connections',
    headers: { 'content-type': 'application/json', ...headers },
    on: vi.fn(),
  }
  req.on.mockImplementation((event: string, cb: (chunk?: Buffer) => void) => {
    if (event === 'data' && body.length > 0) cb(Buffer.from(body))
    if (event === 'end') cb()
  })
  return req
}

describe('handleConnectionWebhookRoutes', () => {
  let handleConnectionWebhookRoutes: (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    logger: typeof logger
  ) => Promise<boolean>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    connections.clear()
    mockConfig.webhookSharedSecret = 'segredo-webhook'
    mockConfig.webhookMaxBodyBytes = 262_144
    mockConfig.webhookTimestampToleranceMs = 300_000
    getWebhookCommandMock.mockResolvedValue(null)
    saveWebhookCommandReceivedMock.mockImplementation(async (input: { commandId: string }) => ({
      created: true,
      record: {
        commandId: input.commandId,
        status: 'received',
        response: null,
      },
    }))
    finishWebhookCommandMock.mockResolvedValue(null)

    const mod = await import('../src/api/routes/connection-webhook.ts')
    handleConnectionWebhookRoutes = mod.handleConnectionWebhookRoutes as never
  })

  it('retorna false para rota não reconhecida', async () => {
    const res = makeRes()
    const handled = await handleConnectionWebhookRoutes(makeReq('{}') as never, res as never, '/outra', logger as never)
    expect(handled).toBe(false)
  })

  it('retorna 401 sem headers de assinatura', async () => {
    const res = makeRes()
    const handled = await handleConnectionWebhookRoutes(makeReq('{}') as never, res as never, '/webhooks/connections', logger as never)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(401)
  })

  it('retorna 401 com assinatura inválida', async () => {
    const timestamp = String(Date.now())
    const body = JSON.stringify({
      event: 'connection.command',
      command_id: 'cmd-1',
      connection: { id: 'conn-1' },
      action: { type: 'register' },
    })
    const res = makeRes()
    await handleConnectionWebhookRoutes(
      makeReq(body, {
        'x-zyra-timestamp': timestamp,
        'x-zyra-delivery-id': 'delivery-1',
        'x-zyra-signature': 'assinatura-invalida',
      }) as never,
      res as never,
      '/webhooks/connections',
      logger as never
    )
    expect(res.statusCode).toBe(401)
  })

  it('processa ação register com sucesso', async () => {
    const timestamp = String(Date.now())
    const body = JSON.stringify({
      event: 'connection.command',
      command_id: 'cmd-register',
      connection: { id: 'conn-r', display_name: 'Conexao R' },
      action: { type: 'register' },
    })
    const signature = signBody(timestamp, body)

    const res = makeRes()
    await handleConnectionWebhookRoutes(
      makeReq(body, {
        'x-zyra-timestamp': timestamp,
        'x-zyra-delivery-id': 'delivery-register',
        'x-zyra-signature': signature,
      }) as never,
      res as never,
      '/webhooks/connections',
      logger as never
    )

    expect(res.statusCode).toBe(200)
    expect(createConnectionMock).toHaveBeenCalledWith('conn-r')
    expect(setConnectionLabelMock).toHaveBeenCalledWith('conn-r', 'Conexao R')
    expect(saveWebhookCommandReceivedMock).toHaveBeenCalled()
    expect(finishWebhookCommandMock).toHaveBeenCalledWith(
      'cmd-register',
      expect.objectContaining({ status: 'accepted' })
    )
  })

  it('retorna resposta anterior quando command_id é duplicado', async () => {
    getWebhookCommandMock.mockResolvedValue({
      commandId: 'cmd-dup',
      response: {
        ok: true,
        command_id: 'cmd-dup',
        connection_id: 'conn-dup',
        accepted: true,
        action: 'register',
      },
    })

    const timestamp = String(Date.now())
    const body = JSON.stringify({
      event: 'connection.command',
      command_id: 'cmd-dup',
      connection: { id: 'conn-dup' },
      action: { type: 'register' },
    })
    const signature = signBody(timestamp, body)
    const res = makeRes()

    await handleConnectionWebhookRoutes(
      makeReq(body, {
        'x-zyra-timestamp': timestamp,
        'x-zyra-delivery-id': 'delivery-dup',
        'x-zyra-signature': signature,
      }) as never,
      res as never,
      '/webhooks/connections',
      logger as never
    )

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ command_id: 'cmd-dup', duplicate: true })
    expect(saveWebhookCommandReceivedMock).not.toHaveBeenCalled()
  })

  it('retorna 422 para action inválida', async () => {
    const timestamp = String(Date.now())
    const body = JSON.stringify({
      event: 'connection.command',
      command_id: 'cmd-invalid-action',
      connection: { id: 'conn-1' },
      action: { type: 'inexistente' },
    })
    const signature = signBody(timestamp, body)
    const res = makeRes()

    await handleConnectionWebhookRoutes(
      makeReq(body, {
        'x-zyra-timestamp': timestamp,
        'x-zyra-delivery-id': 'delivery-invalid',
        'x-zyra-signature': signature,
      }) as never,
      res as never,
      '/webhooks/connections',
      logger as never
    )

    expect(res.statusCode).toBe(422)
  })

  it('processa action pairing_start', async () => {
    const timestamp = String(Date.now())
    const body = JSON.stringify({
      event: 'connection.command',
      command_id: 'cmd-pair-start',
      connection: { id: 'conn-pair' },
      action: { type: 'pairing_start' },
    })
    const signature = signBody(timestamp, body)
    const res = makeRes()

    await handleConnectionWebhookRoutes(
      makeReq(body, {
        'x-zyra-timestamp': timestamp,
        'x-zyra-delivery-id': 'delivery-pair-start',
        'x-zyra-signature': signature,
      }) as never,
      res as never,
      '/webhooks/connections',
      logger as never
    )

    expect(res.statusCode).toBe(200)
    expect(startPairingMock).toHaveBeenCalledWith('conn-pair')
  })

  it('retorna 413 quando payload excede limite configurado', async () => {
    mockConfig.webhookMaxBodyBytes = 16
    const timestamp = String(Date.now())
    const body = JSON.stringify({
      event: 'connection.command',
      command_id: 'cmd-large',
      connection: { id: 'conn-1' },
      action: { type: 'register' },
      metadata: { a: 'x'.repeat(500) },
    })
    const signature = signBody(timestamp, body)
    const res = makeRes()

    await handleConnectionWebhookRoutes(
      makeReq(body, {
        'x-zyra-timestamp': timestamp,
        'x-zyra-delivery-id': 'delivery-large',
        'x-zyra-signature': signature,
      }) as never,
      res as never,
      '/webhooks/connections',
      logger as never
    )

    expect(res.statusCode).toBe(413)
  })
})
