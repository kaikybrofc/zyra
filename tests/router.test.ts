import { beforeEach, describe, expect, it, vi } from 'vitest'

const createCommandProcessorMock = vi.fn()
const createSqlStoreMock = vi.fn()

vi.mock('../src/core/command-runtime/processor.js', () => ({
  createCommandProcessor: (...args: unknown[]) => createCommandProcessorMock(...args),
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

beforeEach(() => {
  vi.resetModules()
  createCommandProcessorMock.mockReset()
  createSqlStoreMock.mockReset()
})

describe('router', () => {
  it('encaminha mensagens para o processor do core usando a sqlStore resolvida', async () => {
    const process = vi.fn().mockResolvedValue(undefined)
    const sqlStore = { enabled: true, recordCommandLog: vi.fn() }
    createSqlStoreMock.mockReturnValue(sqlStore)
    createCommandProcessorMock.mockReturnValue({ process })

    const logger = createLogger()
    const sock = { user: { id: 'bot@s.whatsapp.net' } }
    const messages = [
      { key: { id: '1', remoteJid: 'chat-1@s.whatsapp.net' } },
      { key: { id: '2', remoteJid: 'chat-2@s.whatsapp.net' } },
    ]

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages(sock as never, messages as never, logger)

    await vi.waitFor(() => {
      expect(process).toHaveBeenCalledTimes(2)
    })

    expect(createSqlStoreMock).toHaveBeenCalledTimes(1)
    expect(createCommandProcessorMock).toHaveBeenCalledWith({ logger, sqlStore })
    expect(process).toHaveBeenCalledTimes(2)
    expect(process).toHaveBeenNthCalledWith(1, sock, messages[0])
    expect(process).toHaveBeenNthCalledWith(2, sock, messages[1])
  })

  it('nao bloqueia a chamada e preserva a ordem dentro do mesmo chat', async () => {
    let releaseFirst: (() => void) | null = null
    const firstMessageProcessed = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const process = vi.fn((_: unknown, message: { key?: { id?: string | null } }) => {
      if (message.key?.id === '1') {
        return firstMessageProcessed
      }
      return Promise.resolve()
    })

    const sqlStore = { enabled: true, recordCommandLog: vi.fn() }
    createSqlStoreMock.mockReturnValue(sqlStore)
    createCommandProcessorMock.mockReturnValue({ process })

    const logger = createLogger()
    const sock = { user: { id: 'bot@s.whatsapp.net' } }
    const messages = [
      { key: { id: '1', remoteJid: 'chat@s.whatsapp.net' } },
      { key: { id: '2', remoteJid: 'chat@s.whatsapp.net' } },
    ]

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages(sock as never, messages as never, logger)

    await vi.waitFor(() => {
      expect(process).toHaveBeenCalledTimes(1)
    })

    expect(process).toHaveBeenNthCalledWith(1, sock, messages[0])

    releaseFirst?.()

    await vi.waitFor(() => {
      expect(process).toHaveBeenCalledTimes(2)
    })

    expect(process).toHaveBeenNthCalledWith(2, sock, messages[1])
  })

  it('permite execucao paralela entre chats diferentes', async () => {
    let releaseFirst: (() => void) | null = null
    const firstMessageProcessed = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const process = vi.fn((_: unknown, message: { key?: { id?: string | null } }) => {
      if (message.key?.id === '1') {
        return firstMessageProcessed
      }
      return Promise.resolve()
    })

    const sqlStore = { enabled: true, recordCommandLog: vi.fn() }
    createSqlStoreMock.mockReturnValue(sqlStore)
    createCommandProcessorMock.mockReturnValue({ process })

    const logger = createLogger()
    const sock = { user: { id: 'bot@s.whatsapp.net' } }
    const messages = [
      { key: { id: '1', remoteJid: 'chat-1@s.whatsapp.net' } },
      { key: { id: '2', remoteJid: 'chat-2@s.whatsapp.net' } },
    ]

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages(sock as never, messages as never, logger)

    await vi.waitFor(() => {
      expect(process).toHaveBeenCalledTimes(2)
    })

    releaseFirst?.()
  })

  it('continua processando o mesmo chat apos falha em uma mensagem da fila', async () => {
    const process = vi.fn((_: unknown, message: { key?: { id?: string | null } }) => {
      if (message.key?.id === '1') {
        return Promise.reject(new Error('boom'))
      }
      return Promise.resolve()
    })

    const sqlStore = { enabled: true, recordCommandLog: vi.fn() }
    createSqlStoreMock.mockReturnValue(sqlStore)
    createCommandProcessorMock.mockReturnValue({ process })

    const logger = createLogger()
    const sock = { user: { id: 'bot@s.whatsapp.net' } }
    const messages = [
      { key: { id: '1', remoteJid: 'chat@s.whatsapp.net' } },
      { key: { id: '2', remoteJid: 'chat@s.whatsapp.net' } },
    ]

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages(sock as never, messages as never, logger)

    await vi.waitFor(() => {
      expect(process).toHaveBeenCalledTimes(2)
    })

    expect(process).toHaveBeenNthCalledWith(1, sock, messages[0])
    expect(process).toHaveBeenNthCalledWith(2, sock, messages[1])
    expect(logger.error).toHaveBeenCalledWith('falha ao processar mensagem enfileirada', {
      err: expect.any(Error),
      queueKey: 'chat@s.whatsapp.net',
    })
  })

  it('usa o id da mensagem como fallback da fila quando remoteJid nao existe', async () => {
    let releaseFirst: (() => void) | null = null
    const firstMessageProcessed = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const process = vi.fn((_: unknown, message: { key?: { id?: string | null } }) => {
      if (message.key?.id === '1') {
        return firstMessageProcessed
      }
      return Promise.resolve()
    })

    const sqlStore = { enabled: true, recordCommandLog: vi.fn() }
    createSqlStoreMock.mockReturnValue(sqlStore)
    createCommandProcessorMock.mockReturnValue({ process })

    const logger = createLogger()
    const sock = { user: { id: 'bot@s.whatsapp.net' } }
    const messages = [
      { key: { id: '1' } },
      { key: { id: '2' } },
    ]

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages(sock as never, messages as never, logger)

    await vi.waitFor(() => {
      expect(process).toHaveBeenCalledTimes(2)
    })

    releaseFirst?.()
  })

  it('loga quando messages.upsert chega vazio', async () => {
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    createSqlStoreMock.mockReturnValue(sqlStore)
    createCommandProcessorMock.mockReturnValue({ process: vi.fn() })

    const logger = createLogger()

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages({} as never, [], logger)

    expect(logger.info).toHaveBeenCalledWith('messages.upsert sem mensagens')
  })
})
