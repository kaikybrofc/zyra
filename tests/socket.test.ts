import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DisconnectReason, initAuthCreds, type AuthenticationState } from '@whiskeysockets/baileys'

let makeWASocketMock: ReturnType<typeof vi.fn>
let fetchLatestMock: ReturnType<typeof vi.fn>
let useMultiFileAuthStateMock: ReturnType<typeof vi.fn>
let getAuthStateMock: ReturnType<typeof vi.fn>
let createBaileysStoreMock: ReturnType<typeof vi.fn>
let createBaileysLoggerMock: ReturnType<typeof vi.fn>
let allowHistorySyncOnceForNewLoginMock: ReturnType<typeof vi.fn>
let initHistorySyncPolicyMock: ReturnType<typeof vi.fn>
let shouldSyncHistoryMessageOnceMock: ReturnType<typeof vi.fn>
let loadAntiBanWarmUpStateMock: ReturnType<typeof vi.fn>
let saveAntiBanWarmUpStateMock: ReturnType<typeof vi.fn>
let wrapSocketWithAntiBanMock: ReturnType<typeof vi.fn>

const mockConfig = {
  authDir: '/tmp/auth-test',
  mysqlUrl: 'mysql://test',
  redisUrl: 'redis://test',
  connectionId: 'default',
  antibanEnabled: false,
  antibanStateSaveIntervalMs: 300000,
}

vi.mock('@whiskeysockets/baileys', async () => {
  const actual = await vi.importActual<typeof import('@whiskeysockets/baileys')>('@whiskeysockets/baileys')
  return {
    ...actual,
    default: (...args: unknown[]) => makeWASocketMock(...args),
    fetchLatestBaileysVersion: (...args: unknown[]) => fetchLatestMock(...args),
    useMultiFileAuthState: (...args: unknown[]) => useMultiFileAuthStateMock(...args),
  }
})

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/observability/baileys-logger.js', () => ({
  createBaileysLogger: (...args: unknown[]) => createBaileysLoggerMock(...args),
}))
vi.mock('../src/store/baileys-store.js', () => ({
  createBaileysStore: (...args: unknown[]) => createBaileysStoreMock(...args),
}))
vi.mock('../src/core/auth/state.js', () => ({
  getAuthState: (...args: unknown[]) => getAuthStateMock(...args),
}))
vi.mock('../src/core/connection/history-sync.js', () => ({
  allowHistorySyncOnceForNewLogin: (...args: unknown[]) => allowHistorySyncOnceForNewLoginMock(...args),
  initHistorySyncPolicy: (...args: unknown[]) => initHistorySyncPolicyMock(...args),
  shouldSyncHistoryMessageOnce: (...args: unknown[]) => shouldSyncHistoryMessageOnceMock(...args),
}))
vi.mock('../src/core/connection/antiban.js', () => ({
  loadAntiBanWarmUpState: (...args: unknown[]) => loadAntiBanWarmUpStateMock(...args),
  saveAntiBanWarmUpState: (...args: unknown[]) => saveAntiBanWarmUpStateMock(...args),
  wrapSocketWithAntiBan: (...args: unknown[]) => wrapSocketWithAntiBanMock(...args),
}))

const createState = (): AuthenticationState => ({
  creds: initAuthCreds(),
  keys: {} as AuthenticationState['keys'],
})

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
})

const createStore = () => ({
  setSelfJid: vi.fn(),
  bind: vi.fn(),
  bindLidMappingStore: vi.fn(),
  getMessage: vi.fn(),
  getGroupMetadata: vi.fn(),
  caches: {
    msgRetryCounterCache: {},
    callOfferCache: {},
    placeholderResendCache: {},
    userDevicesCache: {},
    mediaCache: {},
  },
})

const originalCredsDebounce = process.env.WA_CREDS_DEBOUNCE_MS
const originalShutdownTimeout = process.env.WA_SHUTDOWN_TIMEOUT_MS

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  makeWASocketMock = vi.fn()
  fetchLatestMock = vi.fn()
  useMultiFileAuthStateMock = vi.fn()
  getAuthStateMock = vi.fn()
  createBaileysStoreMock = vi.fn()
  createBaileysLoggerMock = vi.fn((logger) => logger)
  allowHistorySyncOnceForNewLoginMock = vi.fn()
  initHistorySyncPolicyMock = vi.fn()
  shouldSyncHistoryMessageOnceMock = vi.fn()
  loadAntiBanWarmUpStateMock = vi.fn().mockResolvedValue(undefined)
  saveAntiBanWarmUpStateMock = vi.fn().mockResolvedValue(undefined)
  wrapSocketWithAntiBanMock = vi.fn((sock) => sock)
})

afterEach(() => {
  if (originalCredsDebounce === undefined) {
    delete process.env.WA_CREDS_DEBOUNCE_MS
  } else {
    process.env.WA_CREDS_DEBOUNCE_MS = originalCredsDebounce
  }
  if (originalShutdownTimeout === undefined) {
    delete process.env.WA_SHUTDOWN_TIMEOUT_MS
  } else {
    process.env.WA_SHUTDOWN_TIMEOUT_MS = originalShutdownTimeout
  }
  vi.useRealTimers()
})

describe('socket', () => {
  it('cria socket, trata eventos e persiste credenciais', async () => {
    process.env.WA_CREDS_DEBOUNCE_MS = '0'
    const ev = new EventEmitter()
    const sock = {
      ev,
      user: { id: '123@s.whatsapp.net' },
      signalRepository: { lidMapping: { storeLIDPNMappings: vi.fn() } },
      end: vi.fn(),
    }

    makeWASocketMock.mockReturnValue(sock)
    fetchLatestMock.mockResolvedValue({ version: [2, 0, 0], isLatest: true })

    const saveCreds = vi.fn().mockResolvedValue(undefined)
    getAuthStateMock.mockResolvedValue({ state: createState(), saveCreds })

    const store = createStore()
    createBaileysStoreMock.mockReturnValue(store)

    const logger = createLogger()
    const { createSocket } = await import('../src/core/connection/socket.ts')
    const created = await createSocket('conn', logger)

    expect(created).toBe(sock)
    expect(loadAntiBanWarmUpStateMock).toHaveBeenCalledWith('conn', logger)
    expect(wrapSocketWithAntiBanMock).toHaveBeenCalledWith(sock, logger, 'conn', undefined)
    expect(store.setSelfJid).toHaveBeenCalledWith('123@s.whatsapp.net')
    expect(store.bind).toHaveBeenCalledWith(ev)
    expect(store.bindLidMappingStore).toHaveBeenCalledWith(sock.signalRepository.lidMapping)

    ev.emit('connection.update', { connection: 'open', isNewLogin: true })
    expect(allowHistorySyncOnceForNewLoginMock).toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith('status da conexao: aberta', { connectionId: 'conn' })

    ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    })
    expect(store.setSelfJid).toHaveBeenCalledWith(null)
    expect(logger.error).toHaveBeenCalledWith('sessao invalidada/removida, requer re-pareamento', { connectionId: 'conn' })

    ev.emit('creds.update')
    await Promise.resolve()
    expect(saveCreds).toHaveBeenCalled()
  })

  it('usa cache de versao, fallback de auth e shutdown gracioso', async () => {
    process.env.WA_CREDS_DEBOUNCE_MS = '0'
    const handlers: Record<string, () => void> = {}
    const onceSpy = vi.spyOn(process, 'once')
    onceSpy.mockImplementation(((event: string, handler: () => void) => {
      handlers[event] = handler
      return process
    }) as typeof process.once)

    const ev1 = new EventEmitter()
    const ev2 = new EventEmitter()
    const sock1 = { ev: ev1, user: { id: '1@s.whatsapp.net' }, end: vi.fn() }
    const sock2 = { ev: ev2, user: { id: '2@s.whatsapp.net' }, end: vi.fn() }

    makeWASocketMock.mockReturnValueOnce(sock1).mockReturnValueOnce(sock2)
    fetchLatestMock.mockResolvedValue({ version: [9, 9, 9], isLatest: true })

    const fallbackSaveCreds = vi.fn().mockResolvedValue(undefined)
    useMultiFileAuthStateMock.mockResolvedValue({ state: createState(), saveCreds: fallbackSaveCreds })

    const saveCreds = vi.fn().mockResolvedValue(undefined)
    getAuthStateMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({
      state: createState(),
      saveCreds,
    })

    const store = createStore()
    createBaileysStoreMock.mockReturnValue(store)

    const logger = createLogger()
    const { createSocket } = await import('../src/core/connection/socket.ts')

    await createSocket('conn', logger)
    await createSocket('conn', logger)

    expect(fetchLatestMock).toHaveBeenCalledTimes(1)
    expect(getAuthStateMock).toHaveBeenCalledTimes(2)
    expect(useMultiFileAuthStateMock).toHaveBeenCalledTimes(1)

    handlers.SIGTERM?.()
    await new Promise((resolve) => setImmediate(resolve))

    expect(fallbackSaveCreds).toHaveBeenCalled()
    expect(saveCreds).toHaveBeenCalled()
    expect(sock1.end).toHaveBeenCalled()
    expect(sock2.end).toHaveBeenCalled()

    onceSpy.mockRestore()
  })

  it('registra warning de versao e loga erro ao falhar saveCreds', async () => {
    process.env.WA_CREDS_DEBOUNCE_MS = '0'
    const ev = new EventEmitter()
    const sock = { ev, user: { id: '3@s.whatsapp.net' }, end: vi.fn() }

    makeWASocketMock.mockReturnValue(sock)
    const versionError = new Error('api down')
    fetchLatestMock.mockResolvedValue({ error: versionError })

    const persistError = new Error('persist fail')
    const saveCreds = vi.fn().mockRejectedValue(persistError)
    getAuthStateMock.mockResolvedValue({ state: createState(), saveCreds })

    const store = createStore()
    createBaileysStoreMock.mockReturnValue(store)

    const logger = createLogger()
    const { createSocket } = await import('../src/core/connection/socket.ts')
    await createSocket('conn', logger)

    expect(store.bindLidMappingStore).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('falha ao buscar a última versão do Baileys, usando fallback', { err: versionError })

    ev.emit('creds.update')
    await Promise.resolve()
    expect(logger.error).toHaveBeenCalledWith('erro ao salvar credenciais durante ciclo de vida', {
      err: persistError,
    })
  })

  it('integra antiban quando habilitado e salva warm-up no fechamento', async () => {
    process.env.WA_CREDS_DEBOUNCE_MS = '0'
    mockConfig.antibanEnabled = true
    mockConfig.antibanStateSaveIntervalMs = 0
    const ev = new EventEmitter()
    const rawSock = { ev, user: { id: '7@s.whatsapp.net' }, end: vi.fn() }
    const wrappedSock = { ...rawSock, antiban: { exportWarmUpState: vi.fn(() => ({ day: 1 })), getStats: vi.fn(() => ({})) } }

    makeWASocketMock.mockReturnValue(rawSock)
    wrapSocketWithAntiBanMock.mockReturnValue(wrappedSock)
    fetchLatestMock.mockResolvedValue({ version: [2, 0, 0], isLatest: true })

    const saveCreds = vi.fn().mockResolvedValue(undefined)
    getAuthStateMock.mockResolvedValue({ state: createState(), saveCreds })

    const store = createStore()
    createBaileysStoreMock.mockReturnValue(store)

    const logger = createLogger()
    const { createSocket } = await import('../src/core/connection/socket.ts')
    const created = await createSocket('conn', logger)

    expect(created).toBe(wrappedSock)

    ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
    })
    await Promise.resolve()

    expect(saveAntiBanWarmUpStateMock).toHaveBeenCalledWith(wrappedSock, 'conn', logger, 'connection_close')
    mockConfig.antibanEnabled = false
    mockConfig.antibanStateSaveIntervalMs = 300000
  })

  it('debounce agrupa atualizacoes de credenciais', async () => {
    vi.useFakeTimers()
    process.env.WA_CREDS_DEBOUNCE_MS = '1000'
    const ev = new EventEmitter()
    const sock = { ev, user: { id: '4@s.whatsapp.net' }, end: vi.fn() }

    makeWASocketMock.mockReturnValue(sock)
    fetchLatestMock.mockResolvedValue({ version: [2, 0, 0], isLatest: true })

    const saveCreds = vi.fn().mockResolvedValue(undefined)
    getAuthStateMock.mockResolvedValue({ state: createState(), saveCreds })

    const store = createStore()
    createBaileysStoreMock.mockReturnValue(store)

    const logger = createLogger()
    const { createSocket } = await import('../src/core/connection/socket.ts')
    await createSocket('conn', logger)

    ev.emit('creds.update')
    ev.emit('creds.update')
    await vi.advanceTimersByTimeAsync(900)
    expect(saveCreds).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(200)
    expect(saveCreds).toHaveBeenCalledTimes(1)
  })

  it('enfileira um segundo salvamento quando ha um save em andamento', async () => {
    process.env.WA_CREDS_DEBOUNCE_MS = '0'
    const ev = new EventEmitter()
    const sock = { ev, user: { id: '5@s.whatsapp.net' }, end: vi.fn() }

    makeWASocketMock.mockReturnValue(sock)
    fetchLatestMock.mockResolvedValue({ version: [2, 0, 0], isLatest: true })

    let resolveFirst: (() => void) | null = null
    const saveCreds = vi.fn().mockImplementation(() => {
      if (!resolveFirst) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve()
    })
    getAuthStateMock.mockResolvedValue({ state: createState(), saveCreds })

    const store = createStore()
    createBaileysStoreMock.mockReturnValue(store)

    const logger = createLogger()
    const { createSocket } = await import('../src/core/connection/socket.ts')
    await createSocket('conn', logger)

    ev.emit('creds.update')
    await Promise.resolve()
    expect(saveCreds).toHaveBeenCalledTimes(1)

    ev.emit('creds.update')
    await Promise.resolve()
    expect(saveCreds).toHaveBeenCalledTimes(1)

    resolveFirst?.()
    await new Promise((resolve) => setImmediate(resolve))
    expect(saveCreds).toHaveBeenCalledTimes(2)
  })

  it('forca encerramento quando shutdown excede timeout', async () => {
    vi.useFakeTimers()
    process.env.WA_CREDS_DEBOUNCE_MS = '0'
    process.env.WA_SHUTDOWN_TIMEOUT_MS = '10'
    const handlers: Record<string, () => void> = {}
    const onceSpy = vi.spyOn(process, 'once')
    onceSpy.mockImplementation(((event: string, handler: () => void) => {
      handlers[event] = handler
      return process
    }) as typeof process.once)

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      return undefined as never
    }) as typeof process.exit)

    const ev = new EventEmitter()
    const sock = { ev, user: { id: '6@s.whatsapp.net' }, end: vi.fn(() => new Promise(() => {})) }

    makeWASocketMock.mockReturnValue(sock)
    fetchLatestMock.mockResolvedValue({ version: [2, 0, 0], isLatest: true })

    const saveCreds = vi.fn(() => new Promise<void>(() => {}))
    getAuthStateMock.mockResolvedValue({ state: createState(), saveCreds })

    const store = createStore()
    createBaileysStoreMock.mockReturnValue(store)

    const logger = createLogger()
    const { createSocket } = await import('../src/core/connection/socket.ts')
    await createSocket('conn', logger)

    handlers.SIGTERM?.()
    await vi.advanceTimersByTimeAsync(10)

    expect(logger.error).toHaveBeenCalledWith('shutdown demorou demais, forçando encerramento', {
      signal: 'SIGTERM',
    })
    expect(exitSpy).toHaveBeenCalledWith(1)

    onceSpy.mockRestore()
    exitSpy.mockRestore()
  })
})
