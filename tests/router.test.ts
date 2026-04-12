import { beforeEach, describe, expect, it, vi } from 'vitest'

const createCommandProcessorMock = vi.fn()
const createSqlStoreMock = vi.fn()

vi.mock('../src/core/commands/processor.js', () => ({
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
    const messages = [{ key: { id: '1' } }, { key: { id: '2' } }]

    const { handleIncomingMessages } = await import('../src/router/index.ts')
    await handleIncomingMessages(sock as never, messages as never, logger)

    expect(createSqlStoreMock).toHaveBeenCalledTimes(1)
    expect(createCommandProcessorMock).toHaveBeenCalledWith({ logger, sqlStore })
    expect(process).toHaveBeenCalledTimes(2)
    expect(process).toHaveBeenNthCalledWith(1, sock, messages[0])
    expect(process).toHaveBeenNthCalledWith(2, sock, messages[1])
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
