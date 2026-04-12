import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createSqlStoreMock = vi.fn()
const handleIncomingMessagesMock = vi.fn()

vi.mock('../src/config/index.js', () => ({
  config: {
    printQRInTerminal: false,
  },
}))

vi.mock('../src/router/index.js', () => ({
  handleIncomingMessages: (...args: unknown[]) => handleIncomingMessagesMock(...args),
}))

vi.mock('../src/store/sql-store.js', () => ({
  createSqlStore: (...args: unknown[]) => createSqlStoreMock(...args),
}))

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
})

const createSqlStoreStub = () => ({
  enabled: true,
  recordEvent: vi.fn(),
  recordNewsletter: vi.fn(),
  recordNewsletterParticipant: vi.fn(),
  recordNewsletterEvent: vi.fn(),
  recordMessageFailure: vi.fn(),
})

describe('registerEvents newsletter persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handleIncomingMessagesMock.mockResolvedValue(undefined)
  })

  it('preenche newsletters e eventos quando chega mensagem em chat @newsletter', async () => {
    const sqlStore = createSqlStoreStub()
    createSqlStoreMock.mockReturnValue(sqlStore)

    const { registerEvents } = await import('../src/events/register.ts')
    const sock = {
      ev: new EventEmitter(),
      user: { id: 'bot@s.whatsapp.net' },
    }
    const logger = createLogger()

    registerEvents({ sock: sock as never, logger: logger as never, reconnect: vi.fn(), connectionId: 'conn' })

    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: '120363111111111111@newsletter',
            id: 'msg-1',
            fromMe: false,
          },
          pushName: 'Canal Teste',
          messageTimestamp: 123,
          message: {
            conversation: 'conteudo',
          },
        },
      ],
    })

    await new Promise((resolve) => setImmediate(resolve))

    expect(sqlStore.recordNewsletter).toHaveBeenCalledWith({
      newsletterId: '120363111111111111@newsletter',
      data: expect.objectContaining({
        id: '120363111111111111@newsletter',
        lastMessageId: 'msg-1',
        pushName: 'Canal Teste',
        messageType: 'conversation',
      }),
    })
    expect(sqlStore.recordNewsletterEvent).toHaveBeenCalledWith({
      newsletterId: '120363111111111111@newsletter',
      eventType: 'message.notify',
      data: expect.objectContaining({
        id: '120363111111111111@newsletter',
        messageId: 'msg-1',
        pushName: 'Canal Teste',
        messageType: 'conversation',
        text: 'conteudo',
      }),
    })
  })

  it('sincroniza metadados da newsletter e registra o owner como participante', async () => {
    const sqlStore = createSqlStoreStub()
    createSqlStoreMock.mockReturnValue(sqlStore)

    const newsletterMetadata = vi.fn().mockResolvedValue({
      id: '120363444444444444@newsletter',
      owner: 'owner@s.whatsapp.net',
      name: 'Canal Oficial',
      description: 'Atualizacoes do projeto',
      subscribers: 42,
      verification: 'VERIFIED',
    })

    const { registerEvents } = await import('../src/events/register.ts')
    const sock = {
      ev: new EventEmitter(),
      user: { id: 'bot@s.whatsapp.net' },
      newsletterMetadata,
    }
    const logger = createLogger()

    registerEvents({ sock: sock as never, logger: logger as never, reconnect: vi.fn(), connectionId: 'conn' })

    sock.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: '120363444444444444@newsletter',
            id: 'msg-2',
            fromMe: false,
          },
          pushName: 'Canal Oficial',
          messageTimestamp: 456,
          message: {
            conversation: 'novo post',
          },
        },
      ],
    })

    await new Promise((resolve) => setImmediate(resolve))

    expect(newsletterMetadata).toHaveBeenCalledWith('jid', '120363444444444444@newsletter')
    expect(sqlStore.recordNewsletter).toHaveBeenCalledWith({
      newsletterId: '120363444444444444@newsletter',
      data: expect.objectContaining({
        id: '120363444444444444@newsletter',
        owner: 'owner@s.whatsapp.net',
        name: 'Canal Oficial',
        description: 'Atualizacoes do projeto',
        subscribers: 42,
        verification: 'VERIFIED',
      }),
    })
    expect(sqlStore.recordNewsletterParticipant).toHaveBeenCalledWith({
      newsletterId: '120363444444444444@newsletter',
      userJid: 'owner@s.whatsapp.net',
      role: 'OWNER',
      status: 'ACTIVE',
    })
  })

  it('atualiza a tabela base nos eventos de participantes e configuracoes', async () => {
    const sqlStore = createSqlStoreStub()
    createSqlStoreMock.mockReturnValue(sqlStore)

    const { registerEvents } = await import('../src/events/register.ts')
    const sock = {
      ev: new EventEmitter(),
      user: { id: 'bot@s.whatsapp.net' },
    }
    const logger = createLogger()

    registerEvents({ sock: sock as never, logger: logger as never, reconnect: vi.fn(), connectionId: 'conn' })

    sock.ev.emit('newsletter-participants.update', {
      id: '120363222222222222@newsletter',
      author: 'admin@s.whatsapp.net',
      user: 'member@s.whatsapp.net',
      new_role: 'subscriber',
      action: 'add',
    })
    sock.ev.emit('newsletter-settings.update', {
      id: '120363333333333333@newsletter',
    })

    await new Promise((resolve) => setImmediate(resolve))

    expect(sqlStore.recordNewsletter).toHaveBeenCalledWith({
      newsletterId: '120363222222222222@newsletter',
      data: expect.objectContaining({
        id: '120363222222222222@newsletter',
        author: 'admin@s.whatsapp.net',
        user: 'member@s.whatsapp.net',
      }),
    })
    expect(sqlStore.recordNewsletter).toHaveBeenCalledWith({
      newsletterId: '120363333333333333@newsletter',
      data: { id: '120363333333333333@newsletter', update: null },
    })
  })
})
