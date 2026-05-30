import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = {
  webhookOutboxEnabled: true,
  webhookOutboxBatchSize: 50,
  webhookOutboxRetryBaseMs: 5_000,
  webhookOutboxRetryMaxMs: 300_000,
  webhookTimeoutMs: 10_000,
  webhookMaxAttempts: 4,
  webhookAllowedTargets: ['https://example.com/hook'],
}

const getActiveWebhooksForEventMock = vi.fn()
const getWebhookMock = vi.fn()
const createWebhookOutboxEntryMock = vi.fn(async () => undefined)
const getDueWebhookOutboxEntriesMock = vi.fn()
const updateWebhookOutboxEntryMock = vi.fn(async () => undefined)

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/webhook/store.js', () => ({
  GLOBAL_WEBHOOK_CONNECTION_ID: '__global__',
  getActiveWebhooksForEvent: (...args: unknown[]) => getActiveWebhooksForEventMock(...args),
  getWebhook: (...args: unknown[]) => getWebhookMock(...args),
}))
vi.mock('../src/store/connection-admin-store.js', () => ({
  createWebhookOutboxEntry: (...args: unknown[]) => createWebhookOutboxEntryMock(...args),
  getDueWebhookOutboxEntries: (...args: unknown[]) => getDueWebhookOutboxEntriesMock(...args),
  updateWebhookOutboxEntry: (...args: unknown[]) => updateWebhookOutboxEntryMock(...args),
}))

const fetchMock = vi.fn()
global.fetch = fetchMock

describe('outbox-dispatcher', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useRealTimers()
    getActiveWebhooksForEventMock.mockResolvedValue([])
    getWebhookMock.mockResolvedValue(null)
    getDueWebhookOutboxEntriesMock.mockResolvedValue([])
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
  })

  it('enfileira eventos para webhooks ativos', async () => {
    getActiveWebhooksForEventMock.mockResolvedValue([
      {
        id: 'wh-1',
        connectionId: 'conn-1',
        url: 'https://example.com/hook',
      },
    ])

    const mod = await import('../src/core/webhooks/outbox-dispatcher.ts')
    await mod.enqueueConnectionOutboxEvent('conn-1', 'connection.status.changed', { current: 'open' })

    expect(createWebhookOutboxEntryMock).toHaveBeenCalledTimes(1)
    expect(createWebhookOutboxEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookId: 'wh-1',
        connectionId: 'conn-1',
        eventType: 'connection.status.changed',
      })
    )
  })

  it('worker processa item pendente e marca como delivered', async () => {
    vi.useFakeTimers()
    getDueWebhookOutboxEntriesMock.mockResolvedValueOnce([
      {
        id: 'out-1',
        webhookId: 'wh-1',
        connectionId: 'conn-1',
        eventType: 'connection.status.changed',
        targetUrl: 'https://example.com/hook',
        payload: { event: 'connection.status.changed' },
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: Date.now(),
      },
    ])
    getDueWebhookOutboxEntriesMock.mockResolvedValue([])
    getWebhookMock.mockResolvedValue({
      id: 'wh-1',
      connectionId: 'conn-1',
      secret: null,
    })
    fetchMock.mockResolvedValue({ ok: true, status: 200 })

    const mod = await import('../src/core/webhooks/outbox-dispatcher.ts')
    const handle = mod.startWebhookOutboxWorker({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as never)

    await vi.advanceTimersByTimeAsync(5_100)
    handle.stop()

    expect(fetchMock).toHaveBeenCalled()
    expect(updateWebhookOutboxEntryMock).toHaveBeenCalledWith('out-1', expect.objectContaining({ status: 'delivered', attemptCount: 1, responseStatus: 200 }))
  })
})
