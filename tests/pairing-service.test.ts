import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createSocketMock = vi.fn()
const flushSocketCredsNowMock = vi.fn(async () => undefined)
const unregisterShutdownTargetMock = vi.fn()

const createConnectionMock = vi.fn()
const getConnectionMock = vi.fn()
const connectMock = vi.fn(async () => undefined)
const disconnectMock = vi.fn(async () => undefined)
const getManagerLoggerMock = vi.fn()

const upsertManagedConnectionMock = vi.fn(async () => undefined)
const recordConnectionAdminEventMock = vi.fn(async () => undefined)
const enqueueConnectionOutboxEventMock = vi.fn(async () => undefined)

vi.mock('../src/core/connection/socket.js', () => ({
  createSocket: (...args: unknown[]) => createSocketMock(...args),
  flushSocketCredsNow: (...args: unknown[]) => flushSocketCredsNowMock(...args),
  unregisterShutdownTarget: (...args: unknown[]) => unregisterShutdownTargetMock(...args),
}))

vi.mock('../src/core/connection/manager.js', () => ({
  createConnection: (...args: unknown[]) => createConnectionMock(...args),
  getConnection: (...args: unknown[]) => getConnectionMock(...args),
  connect: (...args: unknown[]) => connectMock(...args),
  disconnect: (...args: unknown[]) => disconnectMock(...args),
  getLogger: (...args: unknown[]) => getManagerLoggerMock(...args),
}))

vi.mock('../src/store/connection-admin-store.js', () => ({
  upsertManagedConnection: (...args: unknown[]) => upsertManagedConnectionMock(...args),
  recordConnectionAdminEvent: (...args: unknown[]) => recordConnectionAdminEventMock(...args),
}))

vi.mock('../src/core/webhooks/outbox-dispatcher.js', () => ({
  enqueueConnectionOutboxEvent: (...args: unknown[]) => enqueueConnectionOutboxEventMock(...args),
}))

const makeSocket = () => {
  const ev = new EventEmitter()
  return {
    ev,
    end: vi.fn(async () => undefined),
  }
}

describe('pairing-service', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    getConnectionMock.mockReturnValue(null)
    getManagerLoggerMock.mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    })
    createSocketMock.mockImplementation(async () => makeSocket())
  })

  it('startPairing cria conexão quando não existe', async () => {
    const pairing = await import('../src/core/connection/pairing-service.ts')
    const state = await pairing.startPairing('conn-pair')

    expect(createConnectionMock).toHaveBeenCalledWith('conn-pair')
    expect(disconnectMock).toHaveBeenCalled()
    expect(state.status).toBe('pending')
  })

  it('atualiza estado para qr_ready quando recebe QR', async () => {
    const pairing = await import('../src/core/connection/pairing-service.ts')
    await pairing.startPairing('conn-qr')

    const sock = createSocketMock.mock.results[0]?.value as Promise<{ ev: EventEmitter }>
    const resolvedSock = await sock
    resolvedSock.ev.emit('connection.update', { qr: 'qr-123' })

    const state = await pairing.getPairingState('conn-qr')
    expect(state.status).toBe('qr_ready')
    expect(state.qrCode).toBe('qr-123')
    expect(enqueueConnectionOutboxEventMock).toHaveBeenCalledWith('conn-qr', 'connection.qr.updated', expect.any(Object))
  })

  it('conclui pairing ao receber connection=open', async () => {
    const pairing = await import('../src/core/connection/pairing-service.ts')
    await pairing.startPairing('conn-open')

    const sock = createSocketMock.mock.results[0]?.value as Promise<{ ev: EventEmitter }>
    const resolvedSock = await sock
    resolvedSock.ev.emit('connection.update', { connection: 'open' })

    await new Promise((resolve) => setTimeout(resolve, 0))
    const state = await pairing.getPairingState('conn-open')
    expect(state.status).toBe('paired')
    expect(connectMock).toHaveBeenCalledWith('conn-open', expect.any(Object))
  })

  it('cancelPairing encerra socket e marca estado cancelado', async () => {
    const pairing = await import('../src/core/connection/pairing-service.ts')
    await pairing.startPairing('conn-cancel')
    const state = await pairing.cancelPairing('conn-cancel')

    expect(state.status).toBe('cancelled')
    const sock = createSocketMock.mock.results[0]?.value as Promise<{ end: ReturnType<typeof vi.fn> }>
    const resolvedSock = await sock
    expect(resolvedSock.end).toHaveBeenCalled()
  })
})
