import { beforeEach, describe, expect, it, vi } from 'vitest'

const createCommandProcessorMock = vi.fn()

vi.mock('../src/core/command-runtime/processor.js', () => ({
  createCommandProcessor: (...args: unknown[]) => createCommandProcessorMock(...args),
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
  delete process.env.WA_ROUTER_MAX_PENDING_PER_QUEUE
})

describe('router', () => {
  it('encaminha mensagens para o processor do core usando a sqlStore recebida', async () => {
    const processMessage = vi.fn().mockResolvedValue(undefined)
    const sqlStore = { enabled: true, recordCommandLog: vi.fn() }
    createCommandProcessorMock.mockReturnValue({ process: processMessage })

    const logger = createLogger()
    const sock = { user: { id: 'bot@s.whatsapp.net' } }
    const messages = [
      { key: { id: '1', remoteJid: 'chat-1@s.whatsapp.net' } },
      { key: { id: '2', remoteJid: 'chat-2@s.whatsapp.net' } },
    ]

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages(sock as never, messages as never, logger, 'conn', sqlStore as never)

    await vi.waitFor(() => {
      expect(processMessage).toHaveBeenCalledTimes(2)
    })

    expect(createCommandProcessorMock).toHaveBeenCalledWith({ logger, sqlStore })
    expect(processMessage).toHaveBeenCalledTimes(2)
    expect(processMessage).toHaveBeenNthCalledWith(1, sock, messages[0])
    expect(processMessage).toHaveBeenNthCalledWith(2, sock, messages[1])
  })

  it('nao bloqueia a chamada e preserva a ordem dentro do mesmo chat', async () => {
    let releaseFirst: (() => void) | null = null
    const firstMessageProcessed = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const processMessage = vi.fn((_: unknown, message: { key?: { id?: string | null } }) => {
      if (message.key?.id === '1') {
        return firstMessageProcessed
      }
      return Promise.resolve()
    })

    const sqlStore = { enabled: true, recordCommandLog: vi.fn() }
    createCommandProcessorMock.mockReturnValue({ process: processMessage })

    const logger = createLogger()
    const sock = { user: { id: 'bot@s.whatsapp.net' } }
    const messages = [
      { key: { id: '1', remoteJid: 'chat@s.whatsapp.net' } },
      { key: { id: '2', remoteJid: 'chat@s.whatsapp.net' } },
    ]

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages(sock as never, messages as never, logger, 'conn', sqlStore as never)

    await vi.waitFor(() => {
      expect(processMessage).toHaveBeenCalledTimes(1)
    })

    expect(processMessage).toHaveBeenNthCalledWith(1, sock, messages[0])

    releaseFirst?.()

    await vi.waitFor(() => {
      expect(processMessage).toHaveBeenCalledTimes(2)
    })

    expect(processMessage).toHaveBeenNthCalledWith(2, sock, messages[1])
  })

  it('permite execucao paralela entre chats diferentes', async () => {
    let releaseFirst: (() => void) | null = null
    const firstMessageProcessed = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const processMessage = vi.fn((_: unknown, message: { key?: { id?: string | null } }) => {
      if (message.key?.id === '1') {
        return firstMessageProcessed
      }
      return Promise.resolve()
    })

    const sqlStore = { enabled: true, recordCommandLog: vi.fn() }
    createCommandProcessorMock.mockReturnValue({ process: processMessage })

    const logger = createLogger()
    const sock = { user: { id: 'bot@s.whatsapp.net' } }
    const messages = [
      { key: { id: '1', remoteJid: 'chat-1@s.whatsapp.net' } },
      { key: { id: '2', remoteJid: 'chat-2@s.whatsapp.net' } },
    ]

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages(sock as never, messages as never, logger, 'conn', sqlStore as never)

    await vi.waitFor(() => {
      expect(processMessage).toHaveBeenCalledTimes(2)
    })

    releaseFirst?.()
  })

  it('continua processando o mesmo chat apos falha em uma mensagem da fila', async () => {
    const processMessage = vi.fn((_: unknown, message: { key?: { id?: string | null } }) => {
      if (message.key?.id === '1') {
        return Promise.reject(new Error('boom'))
      }
      return Promise.resolve()
    })

    const sqlStore = { enabled: true, recordCommandLog: vi.fn() }
    createCommandProcessorMock.mockReturnValue({ process: processMessage })

    const logger = createLogger()
    const sock = { user: { id: 'bot@s.whatsapp.net' } }
    const messages = [
      { key: { id: '1', remoteJid: 'chat@s.whatsapp.net' } },
      { key: { id: '2', remoteJid: 'chat@s.whatsapp.net' } },
    ]

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages(sock as never, messages as never, logger, 'conn', sqlStore as never)

    await vi.waitFor(() => {
      expect(processMessage).toHaveBeenCalledTimes(2)
    })

    expect(processMessage).toHaveBeenNthCalledWith(1, sock, messages[0])
    expect(processMessage).toHaveBeenNthCalledWith(2, sock, messages[1])
    expect(logger.error).toHaveBeenCalledWith('falha ao processar mensagem enfileirada', {
      err: expect.any(Error),
      queueKey: 'conn:chat@s.whatsapp.net',
    })
  })

  it('usa o id da mensagem como fallback da fila quando remoteJid nao existe', async () => {
    let releaseFirst: (() => void) | null = null
    const firstMessageProcessed = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const processMessage = vi.fn((_: unknown, message: { key?: { id?: string | null } }) => {
      if (message.key?.id === '1') {
        return firstMessageProcessed
      }
      return Promise.resolve()
    })

    const sqlStore = { enabled: true, recordCommandLog: vi.fn() }
    createCommandProcessorMock.mockReturnValue({ process: processMessage })

    const logger = createLogger()
    const sock = { user: { id: 'bot@s.whatsapp.net' } }
    const messages = [
      { key: { id: '1' } },
      { key: { id: '2' } },
    ]

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages(sock as never, messages as never, logger, 'conn', sqlStore as never)

    await vi.waitFor(() => {
      expect(processMessage).toHaveBeenCalledTimes(2)
    })

    releaseFirst?.()
  })

  it('loga quando messages.upsert chega vazio', async () => {
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    createCommandProcessorMock.mockReturnValue({ process: vi.fn() })

    const logger = createLogger()

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages({} as never, [], logger, 'conn', sqlStore as never)

    expect(logger.info).toHaveBeenCalledWith('messages.upsert sem mensagens')
  })

  it('isola filas por connectionId quando dois sockets recebem mensagens no mesmo chat', async () => {
    let releaseFirst: (() => void) | null = null
    const firstMessageProcessed = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const processMessage = vi.fn((_: unknown, message: { key?: { id?: string | null } }) => {
      if (message.key?.id === '1') {
        return firstMessageProcessed
      }
      return Promise.resolve()
    })

    const sqlStore = { enabled: true, recordCommandLog: vi.fn() }
    createCommandProcessorMock.mockReturnValue({ process: processMessage })

    const logger = createLogger()
    const sock = { user: { id: 'bot@s.whatsapp.net' } }
    const messageA = { key: { id: '1', remoteJid: 'chat@s.whatsapp.net' } }
    const messageB = { key: { id: '2', remoteJid: 'chat@s.whatsapp.net' } }

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages(sock as never, [messageA] as never, logger, 'conn-a', sqlStore as never)
    await handleIncomingMessages(sock as never, [messageB] as never, logger, 'conn-b', sqlStore as never)

    await vi.waitFor(() => {
      expect(processMessage).toHaveBeenCalledTimes(2)
    })

    releaseFirst?.()
  })

  it('descarta mensagem quando fila por chat/conexao atinge limite', async () => {
    process.env.WA_ROUTER_MAX_PENDING_PER_QUEUE = '1'
    vi.resetModules()

    let releaseFirst: (() => void) | null = null
    const firstMessageProcessed = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const processMessage = vi.fn((_: unknown, message: { key?: { id?: string | null } }) => {
      if (message.key?.id === '1') {
        return firstMessageProcessed
      }
      return Promise.resolve()
    })

    const sqlStore = { enabled: true, recordCommandLog: vi.fn() }
    createCommandProcessorMock.mockReturnValue({ process: processMessage })

    const logger = createLogger()
    const sock = { user: { id: 'bot@s.whatsapp.net' } }
    const messages = [
      { key: { id: '1', remoteJid: 'chat@s.whatsapp.net' } },
      { key: { id: '2', remoteJid: 'chat@s.whatsapp.net' } },
    ]

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages(sock as never, messages as never, logger, 'conn', sqlStore as never)

    await vi.waitFor(() => {
      expect(processMessage).toHaveBeenCalledTimes(1)
    })
    expect(logger.warn).toHaveBeenCalledWith('fila de processamento saturada; mensagem descartada para proteger memoria', {
      queueKey: 'conn:chat@s.whatsapp.net',
      pending: 1,
      maxPending: 1,
    })
    expect(logger.debug).toHaveBeenCalledWith('mensagem descartada por backpressure da fila', {
      queueKey: 'conn:chat@s.whatsapp.net',
      messageId: '2',
    })

    releaseFirst?.()
  })
})
