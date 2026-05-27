import { beforeEach, describe, expect, it, vi } from 'vitest'

const getMysqlPoolMock = vi.fn(() => null)

vi.mock('../src/core/db/mysql.js', () => ({
  getMysqlPool: (...args: unknown[]) => getMysqlPoolMock(...args),
}))

vi.mock('../src/core/db/connection.js', () => ({
  ensureMysqlConnection: vi.fn(async () => undefined),
}))

describe('connection-admin-store', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    getMysqlPoolMock.mockReturnValue(null)
  })

  it('upsert/get/list de managed_connections em memória', async () => {
    const store = await import('../src/store/connection-admin-store.ts')
    store._resetConnectionAdminStore()

    await store.upsertManagedConnection({
      connectionId: 'conn-a',
      status: 'open',
      desiredState: 'running',
      displayName: 'Conexao A',
      metadata: { source: 'test' },
    })

    const single = await store.getManagedConnection('conn-a')
    expect(single?.connectionId).toBe('conn-a')
    expect(single?.status).toBe('open')
    expect(single?.desiredState).toBe('running')
    expect(single?.displayName).toBe('Conexao A')

    const list = await store.listManagedConnections()
    expect(list).toHaveLength(1)
    expect(list[0]?.connectionId).toBe('conn-a')
  })

  it('registra eventos administrativos e lista em ordem reversa', async () => {
    const store = await import('../src/store/connection-admin-store.ts')
    store._resetConnectionAdminStore()

    await store.recordConnectionAdminEvent({
      connectionId: 'conn-ev',
      eventType: 'connection.registered',
      source: 'test',
    })
    await store.recordConnectionAdminEvent({
      connectionId: 'conn-ev',
      eventType: 'connection.started',
      source: 'test',
    })

    const events = await store.listConnectionAdminEvents('conn-ev')
    expect(events).toHaveLength(2)
    expect(events[0]?.eventType).toBe('connection.started')
    expect(events[1]?.eventType).toBe('connection.registered')
  })

  it('deduplica webhook_commands por command_id e finaliza resposta', async () => {
    const store = await import('../src/store/connection-admin-store.ts')
    store._resetConnectionAdminStore()

    const first = await store.saveWebhookCommandReceived({
      commandId: 'cmd-1',
      connectionId: 'conn-1',
      actionType: 'register',
      payload: { ok: true },
      deliveryId: 'delivery-1',
    })
    expect(first.created).toBe(true)

    const duplicate = await store.saveWebhookCommandReceived({
      commandId: 'cmd-1',
      connectionId: 'conn-1',
      actionType: 'register',
      payload: { ok: true },
      deliveryId: 'delivery-1',
    })
    expect(duplicate.created).toBe(false)

    await store.finishWebhookCommand('cmd-1', {
      status: 'accepted',
      response: { ok: true, command_id: 'cmd-1' },
    })
    const stored = await store.getWebhookCommand('cmd-1')
    expect(stored?.status).toBe('accepted')
    expect(stored?.response).toMatchObject({ ok: true, command_id: 'cmd-1' })
  })

  it('cria e atualiza webhook_outbox em memória', async () => {
    const store = await import('../src/store/connection-admin-store.ts')
    store._resetConnectionAdminStore()

    await store.createWebhookOutboxEntry({
      id: 'out-1',
      webhookId: 'wh-1',
      connectionId: 'conn-1',
      eventType: 'connection.status.changed',
      targetUrl: 'https://example.com/hook',
      payload: { event: 'connection.status.changed' },
    })

    const due = await store.getDueWebhookOutboxEntries(10)
    expect(due).toHaveLength(1)
    expect(due[0]?.id).toBe('out-1')

    const updated = await store.updateWebhookOutboxEntry('out-1', {
      status: 'delivered',
      attemptCount: 1,
      nextAttemptAt: null,
      lastError: null,
      responseStatus: 200,
    })
    expect(updated?.status).toBe('delivered')
    expect(updated?.attemptCount).toBe(1)
  })
})
