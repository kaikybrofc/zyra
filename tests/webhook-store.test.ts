import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeMock = vi.fn()
const queryMock = vi.fn()

vi.mock('../src/core/db/mysql.js', () => ({
  getMysqlPool: () => ({ execute: executeMock, query: queryMock }),
}))

// dynamic import to get fresh module state per test
let store: typeof import('../src/webhook/store.js')

describe('webhook store', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    store = await import('../src/webhook/store.ts')
    store._resetStore()

    // default: no rows returned for SELECT
    executeMock.mockResolvedValue([[]])
    queryMock.mockResolvedValue([[]])
  })

  describe('createWebhook', () => {
    it('cria webhook e retorna o registro', async () => {
      executeMock.mockResolvedValueOnce([[]]) // load SELECT
      executeMock.mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT

      const wh = await store.createWebhook('conn1', {
        url: 'https://example.com/hook',
        eventsFilter: ['connection.update'],
      })

      expect(wh.connectionId).toBe('conn1')
      expect(wh.url).toBe('https://example.com/hook')
      expect(wh.eventsFilter).toEqual(['connection.update'])
      expect(wh.active).toBe(true)
      expect(wh.secret).toBeNull()
      expect(wh.id).toBeTruthy()
    })

    it('persiste secret quando fornecido', async () => {
      executeMock.mockResolvedValue([[]])

      const wh = await store.createWebhook('conn1', {
        url: 'https://example.com/hook',
        eventsFilter: ['messages.upsert'],
        secret: 'minha-chave',
      })

      expect(wh.secret).toBe('minha-chave')
    })
  })

  describe('listWebhooks', () => {
    it('retorna lista vazia quando não há webhooks', async () => {
      const list = await store.listWebhooks('conn1')
      expect(list).toEqual([])
    })

    it('retorna apenas webhooks da conexão especificada', async () => {
      executeMock.mockResolvedValue([[]])

      await store.createWebhook('conn1', { url: 'https://a.com', eventsFilter: ['*'] })
      await store.createWebhook('conn2', { url: 'https://b.com', eventsFilter: ['*'] })

      const list = await store.listWebhooks('conn1')
      expect(list).toHaveLength(1)
      expect(list[0]!.connectionId).toBe('conn1')
    })
  })

  describe('getWebhook', () => {
    it('retorna null quando não encontrado', async () => {
      const result = await store.getWebhook('inexistente', 'conn1')
      expect(result).toBeNull()
    })

    it('retorna null quando connectionId não bate', async () => {
      executeMock.mockResolvedValue([[]])
      const wh = await store.createWebhook('conn1', { url: 'https://x.com', eventsFilter: ['*'] })
      const result = await store.getWebhook(wh.id, 'conn2')
      expect(result).toBeNull()
    })

    it('retorna webhook correto', async () => {
      executeMock.mockResolvedValue([[]])
      const created = await store.createWebhook('conn1', { url: 'https://x.com', eventsFilter: ['*'] })
      const found = await store.getWebhook(created.id, 'conn1')
      expect(found?.id).toBe(created.id)
    })
  })

  describe('updateWebhook', () => {
    it('retorna null se webhook não existe', async () => {
      const result = await store.updateWebhook('nope', 'conn1', { active: false })
      expect(result).toBeNull()
    })

    it('atualiza campos corretamente', async () => {
      executeMock.mockResolvedValue([[]])
      const wh = await store.createWebhook('conn1', { url: 'https://old.com', eventsFilter: ['*'] })
      const updated = await store.updateWebhook(wh.id, 'conn1', {
        url: 'https://new.com',
        active: false,
      })
      expect(updated?.url).toBe('https://new.com')
      expect(updated?.active).toBe(false)
    })
  })

  describe('deleteWebhook', () => {
    it('retorna false se não existe', async () => {
      const result = await store.deleteWebhook('nope', 'conn1')
      expect(result).toBe(false)
    })

    it('remove o webhook existente', async () => {
      executeMock.mockResolvedValue([[]])
      executeMock.mockResolvedValueOnce([[]]) // load
      executeMock.mockResolvedValueOnce([{ affectedRows: 1 }]) // INSERT
      executeMock.mockResolvedValueOnce([{ affectedRows: 1 }]) // DELETE
      const wh = await store.createWebhook('conn1', { url: 'https://x.com', eventsFilter: ['*'] })
      const deleted = await store.deleteWebhook(wh.id, 'conn1')
      expect(deleted).toBe(true)
      const found = await store.getWebhook(wh.id, 'conn1')
      expect(found).toBeNull()
    })
  })

  describe('createDelivery / updateDelivery', () => {
    it('cria entrega com status pending', async () => {
      executeMock.mockResolvedValue([[]])
      const delivery = await store.createDelivery({
        webhookId: 'wh1',
        connectionId: 'conn1',
        eventType: 'messages.upsert',
        payload: { hello: 'world' },
      })
      expect(delivery.status).toBe('pending')
      expect(delivery.attempts).toBe(0)
    })

    it('atualiza status da entrega', async () => {
      executeMock.mockResolvedValue([[]])
      const d = await store.createDelivery({
        webhookId: 'wh1',
        connectionId: 'conn1',
        eventType: 'connection.update',
        payload: {},
      })
      await store.updateDelivery(d.id, {
        status: 'delivered',
        attempts: 1,
        lastAttemptAt: Date.now(),
        nextRetryAt: null,
        responseStatus: 200,
        responseBody: 'ok',
      })
      const updated = store.getDelivery(d.id)
      expect(updated?.status).toBe('delivered')
      expect(updated?.attempts).toBe(1)
    })
  })

  describe('getActiveWebhooksForEvent', () => {
    it('retorna apenas webhooks ativos que batem com o evento', async () => {
      executeMock.mockResolvedValue([[]])
      await store.createWebhook('conn1', { url: 'https://a.com', eventsFilter: ['connection'] })
      await store.createWebhook('conn1', { url: 'https://b.com', eventsFilter: ['messages.upsert'] })

      const matches = await store.getActiveWebhooksForEvent('conn1', 'connection.update')
      expect(matches).toHaveLength(1)
      expect(matches[0]!.url).toBe('https://a.com')
    })

    it('retorna webhook com filtro wildcard *', async () => {
      executeMock.mockResolvedValue([[]])
      await store.createWebhook('conn1', { url: 'https://all.com', eventsFilter: ['*'] })
      const matches = await store.getActiveWebhooksForEvent('conn1', 'groups.update')
      expect(matches).toHaveLength(1)
    })

    it('não retorna webhook inativo', async () => {
      executeMock.mockResolvedValue([[]])
      const wh = await store.createWebhook('conn1', { url: 'https://a.com', eventsFilter: ['*'] })
      await store.updateWebhook(wh.id, 'conn1', { active: false })
      const matches = await store.getActiveWebhooksForEvent('conn1', 'connection.update')
      expect(matches).toHaveLength(0)
    })

    it('inclui webhook global (__global__) no dispatch de qualquer instância', async () => {
      executeMock.mockResolvedValue([[]])
      await store.createWebhook(store.GLOBAL_WEBHOOK_CONNECTION_ID, { url: 'https://global.com', eventsFilter: ['*'] })
      await store.createWebhook('conn1', { url: 'https://local.com', eventsFilter: ['*'] })

      const matches = await store.getActiveWebhooksForEvent('conn1', 'messages.upsert')
      expect(matches).toHaveLength(2)
      expect(matches.map((w) => w.url).sort()).toEqual(['https://global.com', 'https://local.com'])
    })

    it('webhook global não aparece em instância diferente da que o criou', async () => {
      executeMock.mockResolvedValue([[]])
      await store.createWebhook(store.GLOBAL_WEBHOOK_CONNECTION_ID, { url: 'https://global.com', eventsFilter: ['*'] })

      const matchesConn2 = await store.getActiveWebhooksForEvent('conn2', 'messages.upsert')
      expect(matchesConn2.some((w) => w.url === 'https://global.com')).toBe(true)

      const matchesConn1 = await store.getActiveWebhooksForEvent('conn1', 'messages.upsert')
      expect(matchesConn1.some((w) => w.url === 'https://global.com')).toBe(true)
    })

    it('webhook global inativo não é disparado', async () => {
      executeMock.mockResolvedValue([[]])
      const wh = await store.createWebhook(store.GLOBAL_WEBHOOK_CONNECTION_ID, { url: 'https://global.com', eventsFilter: ['*'] })
      await store.updateWebhook(wh.id, store.GLOBAL_WEBHOOK_CONNECTION_ID, { active: false })

      const matches = await store.getActiveWebhooksForEvent('conn1', 'connection.update')
      expect(matches).toHaveLength(0)
    })
  })
})
