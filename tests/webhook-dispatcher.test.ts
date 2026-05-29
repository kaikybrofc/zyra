import { beforeEach, describe, expect, it, vi } from 'vitest'

const getActiveWebhooksForEventMock = vi.fn()
const sendWebhookEventMock = vi.fn()

vi.mock('../src/webhook/store.js', () => ({
  getActiveWebhooksForEvent: (...args: unknown[]) => getActiveWebhooksForEventMock(...args),
}))

vi.mock('../src/webhook/delivery.js', () => ({
  sendWebhookEvent: (...args: unknown[]) => sendWebhookEventMock(...args),
}))

describe('webhook dispatcher', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    getActiveWebhooksForEventMock.mockResolvedValue([])
    sendWebhookEventMock.mockResolvedValue(undefined)
  })

  it('não dispara quando evento não é suportado', async () => {
    const { dispatchWebhookEvent } = await import('../src/webhook/dispatcher.ts')
    await dispatchWebhookEvent('conn1', 'chats.update', {})
    expect(getActiveWebhooksForEventMock).not.toHaveBeenCalled()
    expect(sendWebhookEventMock).not.toHaveBeenCalled()
  })

  it('não dispara quando não há webhooks ativos', async () => {
    const { dispatchWebhookEvent } = await import('../src/webhook/dispatcher.ts')
    await dispatchWebhookEvent('conn1', 'connection.update', { connection: 'open' })
    expect(sendWebhookEventMock).not.toHaveBeenCalled()
  })

  it('dispara para todos os webhooks ativos', async () => {
    const wh1 = { id: 'w1', connectionId: 'conn1', url: 'https://a.com', eventsFilter: ['*'], active: true, secret: null, createdAt: 0, updatedAt: 0 }
    const wh2 = { id: 'w2', connectionId: 'conn1', url: 'https://b.com', eventsFilter: ['connection'], active: true, secret: null, createdAt: 0, updatedAt: 0 }
    getActiveWebhooksForEventMock.mockResolvedValue([wh1, wh2])

    const { dispatchWebhookEvent } = await import('../src/webhook/dispatcher.ts')
    await dispatchWebhookEvent('conn1', 'connection.update', { connection: 'open' })

    expect(sendWebhookEventMock).toHaveBeenCalledTimes(2)
  })

  it('payload contém event, connectionId, timestamp e data', async () => {
    const wh = { id: 'w1', connectionId: 'conn1', url: 'https://a.com', eventsFilter: ['*'], active: true, secret: null, createdAt: 0, updatedAt: 0 }
    getActiveWebhooksForEventMock.mockResolvedValue([wh])

    const { dispatchWebhookEvent } = await import('../src/webhook/dispatcher.ts')
    const data = { messages: [] }
    await dispatchWebhookEvent('conn1', 'messages.upsert', data)

    const [, payload] = sendWebhookEventMock.mock.calls[0]!
    expect(payload.event).toBe('messages.upsert')
    expect(payload.connectionId).toBe('conn1')
    expect(payload.timestamp).toBeTypeOf('number')
    expect(payload.data).toEqual(data)
  })

  it('suporta todos os 9 eventos definidos', async () => {
    const { WEBHOOK_SUPPORTED_EVENTS } = await import('../src/webhook/dispatcher.ts')
    expect(WEBHOOK_SUPPORTED_EVENTS.has('connection.update')).toBe(true)
    expect(WEBHOOK_SUPPORTED_EVENTS.has('messages.upsert')).toBe(true)
    expect(WEBHOOK_SUPPORTED_EVENTS.has('messages.update')).toBe(true)
    expect(WEBHOOK_SUPPORTED_EVENTS.has('messages.delete')).toBe(true)
    expect(WEBHOOK_SUPPORTED_EVENTS.has('message-receipt.update')).toBe(true)
    expect(WEBHOOK_SUPPORTED_EVENTS.has('messages.reaction')).toBe(true)
    expect(WEBHOOK_SUPPORTED_EVENTS.has('groups.upsert')).toBe(true)
    expect(WEBHOOK_SUPPORTED_EVENTS.has('groups.update')).toBe(true)
    expect(WEBHOOK_SUPPORTED_EVENTS.has('group-participants.update')).toBe(true)
    expect(WEBHOOK_SUPPORTED_EVENTS.size).toBe(9)
  })
})
