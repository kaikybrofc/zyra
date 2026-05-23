import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadEnvMock = vi.fn()
const initMysqlSchemaMock = vi.fn(async () => undefined)
const closeRedisClientMock = vi.fn(async () => undefined)
const flushSocketCredsNowMock = vi.fn(async () => undefined)
const unregisterShutdownTargetMock = vi.fn()
const endMock = vi.fn(async () => undefined)
const renderQrInTerminalMock = vi.fn()
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}

const mockConfig = {
  mysqlUrl: 'mysql://test',
}

let currentEmitter: EventEmitter | null = null
const createdEmitters: EventEmitter[] = []
const createSocketMock = vi.fn(async () => {
  currentEmitter = new EventEmitter()
  createdEmitters.push(currentEmitter)
  return {
    ev: currentEmitter,
    end: endMock,
  }
})

const getMysqlPoolMock = vi.fn(() => null)

vi.mock('../src/bootstrap/env.js', () => ({
  loadEnv: () => loadEnvMock(),
}))
vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/core/db/init.js', () => ({
  initMysqlSchema: (...args: unknown[]) => initMysqlSchemaMock(...args),
}))
vi.mock('../src/core/db/mysql.js', () => ({
  getMysqlPool: (...args: unknown[]) => getMysqlPoolMock(...args),
}))
vi.mock('../src/core/redis/client.js', () => ({
  closeRedisClient: (...args: unknown[]) => closeRedisClientMock(...args),
}))
vi.mock('../src/core/connection/socket.js', () => ({
  createSocket: (...args: unknown[]) => createSocketMock(...args),
  flushSocketCredsNow: (...args: unknown[]) => flushSocketCredsNowMock(...args),
  unregisterShutdownTarget: (...args: unknown[]) => unregisterShutdownTargetMock(...args),
}))
vi.mock('../src/observability/logger.js', () => ({
  createLogger: vi.fn(() => logger),
}))
vi.mock('../src/events/qr-terminal.js', () => ({
  renderQrInTerminal: (...args: unknown[]) => renderQrInTerminalMock(...args),
}))

describe('session pair command', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockConfig.mysqlUrl = 'mysql://test'
    currentEmitter = null
    createdEmitters.length = 0
    getMysqlPoolMock.mockReturnValue(null)
    createSocketMock.mockImplementation(async () => {
      currentEmitter = new EventEmitter()
      createdEmitters.push(currentEmitter)
      return {
        ev: currentEmitter,
        end: endMock,
      }
    })
  })

  it('renderiza QR e faz flush ao abrir a conexão', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
      expect(currentEmitter).toBeTruthy()
    })
    createdEmitters[0]?.emit('connection.update', { qr: 'qr-value' })
    createdEmitters[0]?.emit('connection.update', { connection: 'open' })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', { connection: 'open' })
    await importPromise
    await vi.waitFor(() => {
      expect(renderQrInTerminalMock).toHaveBeenCalledWith(logger, 'qr-value', 'loja2')
      expect(flushSocketCredsNowMock).toHaveBeenCalledTimes(3)
      expect(endMock).toHaveBeenCalledTimes(2)
    })

    expect(loadEnvMock).toHaveBeenCalledTimes(1)
    expect(initMysqlSchemaMock).toHaveBeenCalledTimes(1)
    expect(createSocketMock).toHaveBeenCalledWith('loja2', logger)
    expect(flushSocketCredsNowMock.mock.calls[0]?.[1]).toBe('pairing_complete')
    expect(flushSocketCredsNowMock.mock.calls.map((call) => call[1])).toEqual([
      'pairing_complete',
      'pairing_finalize',
      'pairing_validation_finalize',
    ])

    process.argv = argv
  })

  it('conclui com sucesso quando o novo login pede restart antes do open', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
      expect(currentEmitter).toBeTruthy()
    })
    createdEmitters[0]?.emit('connection.update', { isNewLogin: true })
    createdEmitters[0]?.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', { connection: 'open' })
    await importPromise

    expect(flushSocketCredsNowMock).toHaveBeenCalledTimes(3)
    expect(flushSocketCredsNowMock.mock.calls[0]?.[1]).toBe('pairing_restart_required')

    process.argv = argv
  })

  it('falha quando mysql não está configurado', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']
    mockConfig.mysqlUrl = null

    await import('../src/core/connection/pair.ts')

    expect(logger.error).toHaveBeenCalledWith(
      'falha no pairing via terminal',
      expect.objectContaining({
        message: expect.stringContaining('MYSQL_URL é obrigatório'),
        usage: 'uso: npm run session:pair -- --connection <id>',
      })
    )
    expect(createSocketMock).not.toHaveBeenCalled()

    process.argv = argv
  })

  it('falha quando --connection não é informado', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts']

    await import('../src/core/connection/pair.ts')

    expect(logger.error).toHaveBeenCalledWith(
      'falha no pairing via terminal',
      expect.objectContaining({
        message: expect.stringContaining('informe a conexão com --connection <id>'),
        usage: 'uso: npm run session:pair -- --connection <id>',
      })
    )
    expect(createSocketMock).not.toHaveBeenCalled()

    process.argv = argv
  })
})
