import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeMock = vi.fn()

vi.mock('../src/core/db/mysql.js', () => ({
  getMysqlPool: () => ({ execute: executeMock }),
}))

vi.mock('../src/config/index.js', () => ({
  config: {
    webhookTimeoutMs: 5000,
    webhookMaxAttempts: 4,
    webhookAllowedTargets: ['https://example.com/hook'],
  },
}))

const fetchMock = vi.fn()
global.fetch = fetchMock

describe('webhook delivery', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    executeMock.mockResolvedValue([[]])
  })

  const makeWebhook = (overrides = {}) => ({
    id: 'wh1',
    connectionId: 'conn1',
    url: 'https://example.com/hook',
    eventsFilter: ['*'],
    active: true,
    secret: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  })

  const makeDelivery = (overrides = {}) => ({
    id: 'del1',
    webhookId: 'wh1',
    connectionId: 'conn1',
    eventType: 'connection.update',
    payload: { event: 'connection.update', connectionId: 'conn1', timestamp: Date.now(), data: {} },
    status: 'pending' as const,
    attempts: 0,
    lastAttemptAt: null,
    nextRetryAt: null,
    responseStatus: null,
    responseBody: null,
    createdAt: Date.now(),
    ...overrides,
  })

  it('marca como delivered quando fetch retorna 2xx', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' })
    executeMock.mockResolvedValue([[]])

    const { attemptDelivery } = await import('../src/webhook/delivery.ts')
    const delivery = makeDelivery()
    const webhook = makeWebhook()

    await attemptDelivery(delivery, webhook)

    const updateCall = executeMock.mock.calls.find((c) => String(c[0]).includes('UPDATE'))
    expect(updateCall).toBeDefined()
    expect(updateCall?.[1]?.[0]).toBe('delivered')
  })

  it('marca como failed quando fetch retorna 5xx e attempts < max', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'error' })
    executeMock.mockResolvedValue([[]])

    const { attemptDelivery } = await import('../src/webhook/delivery.ts')
    const delivery = makeDelivery()
    const webhook = makeWebhook()

    await attemptDelivery(delivery, webhook)

    const updateCall = executeMock.mock.calls.find((c) => String(c[0]).includes('UPDATE'))
    expect(updateCall?.[1]?.[0]).toBe('failed')
  })

  it('marca como dead_letter quando atinge max attempts', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'error' })
    executeMock.mockResolvedValue([[]])

    const { attemptDelivery } = await import('../src/webhook/delivery.ts')
    const delivery = makeDelivery({ attempts: 3 }) // 3 + 1 = 4 = max
    const webhook = makeWebhook()

    await attemptDelivery(delivery, webhook)

    const updateCall = executeMock.mock.calls.find((c) => String(c[0]).includes('UPDATE'))
    expect(updateCall?.[1]?.[0]).toBe('dead_letter')
  })

  it('marca como failed quando fetch lança (erro de rede)', async () => {
    fetchMock.mockRejectedValue(new Error('network error'))
    executeMock.mockResolvedValue([[]])

    const { attemptDelivery } = await import('../src/webhook/delivery.ts')
    const delivery = makeDelivery()
    const webhook = makeWebhook()

    await expect(attemptDelivery(delivery, webhook)).resolves.not.toThrow()

    const updateCall = executeMock.mock.calls.find((c) => String(c[0]).includes('UPDATE'))
    expect(updateCall?.[1]?.[0]).toBe('failed')
  })

  it('não envia requisição para URL local e marca como failed', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' })
    executeMock.mockResolvedValue([[]])

    const { attemptDelivery } = await import('../src/webhook/delivery.ts')
    await attemptDelivery(makeDelivery(), makeWebhook({ url: 'http://127.0.0.1:3000/hook' }))

    expect(fetchMock).not.toHaveBeenCalled()
    const updateCall = executeMock.mock.calls.find((c) => String(c[0]).includes('UPDATE'))
    expect(updateCall?.[1]?.[0]).toBe('failed')
  })

  it('não envia requisição para URL fora da allowlist e marca como failed', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' })
    executeMock.mockResolvedValue([[]])

    const { attemptDelivery } = await import('../src/webhook/delivery.ts')
    await attemptDelivery(makeDelivery(), makeWebhook({ url: 'https://nao-autorizado.com/hook' }))

    expect(fetchMock).not.toHaveBeenCalled()
    const updateCall = executeMock.mock.calls.find((c) => String(c[0]).includes('UPDATE'))
    expect(updateCall?.[1]?.[0]).toBe('failed')
  })

  it('adiciona header x-webhook-signature quando secret presente', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' })
    executeMock.mockResolvedValue([[]])

    const { attemptDelivery } = await import('../src/webhook/delivery.ts')
    await attemptDelivery(makeDelivery(), makeWebhook({ secret: 'meu-segredo' }))

    const [, fetchOptions] = fetchMock.mock.calls[0]!
    expect((fetchOptions as RequestInit).headers).toHaveProperty('x-webhook-signature')
    const sig = ((fetchOptions as RequestInit).headers as Record<string, string>)['x-webhook-signature']
    expect(sig).toMatch(/^sha256=/)
  })

  it('não adiciona x-webhook-signature quando secret é null', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => 'ok' })
    executeMock.mockResolvedValue([[]])

    const { attemptDelivery } = await import('../src/webhook/delivery.ts')
    await attemptDelivery(makeDelivery(), makeWebhook({ secret: null }))

    const [, fetchOptions] = fetchMock.mock.calls[0]!
    expect((fetchOptions as RequestInit).headers).not.toHaveProperty('x-webhook-signature')
  })
})
