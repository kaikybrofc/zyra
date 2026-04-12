import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConfig = {
  antibanEnabled: true,
  antibanLogging: false,
  antibanStateDir: 'data/antiban',
  antibanStateSaveIntervalMs: 300000,
  antibanAutoPauseAt: 'high',
  antibanMaxPerMinute: 8,
  antibanMaxPerHour: 200,
  antibanMaxPerDay: 1500,
  antibanMinDelayMs: 1500,
  antibanMaxDelayMs: 5000,
  antibanNewChatDelayMs: 3000,
  antibanWarmUpDays: 7,
  antibanWarmUpDay1Limit: 20,
  antibanWarmUpGrowthFactor: 1.8,
  antibanInactivityThresholdHours: 72,
}

const adapterSaveMock = vi.fn()
const adapterLoadMock = vi.fn()
const wrapSocketMock = vi.fn()

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('baileys-antiban', () => ({
  FileStateAdapter: class {
    async load(key: string) {
      return adapterLoadMock(key)
    }
    async save(key: string, value: unknown) {
      return adapterSaveMock(key, value)
    }
  },
  wrapSocket: (...args: unknown[]) => wrapSocketMock(...args),
}))

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
})

beforeEach(() => {
  vi.clearAllMocks()
  adapterLoadMock.mockResolvedValue({ day: 2 })
  adapterSaveMock.mockResolvedValue(undefined)
  wrapSocketMock.mockImplementation((sock) => ({ ...sock, antiban: { exportWarmUpState: () => ({ day: 2 }), getStats: () => ({}) } }))
})

describe('antiban helper', () => {
  it('carrega e salva o warm-up por connectionId', async () => {
    const logger = createLogger()
    const { loadAntiBanWarmUpState, saveAntiBanWarmUpState } = await import('../src/core/connection/antiban.ts')

    const loaded = await loadAntiBanWarmUpState('conn-a', logger as never)
    expect(loaded).toEqual({ day: 2 })

    await saveAntiBanWarmUpState(
      { antiban: { exportWarmUpState: () => ({ day: 3 }), getStats: () => ({}) } } as never,
      'conn-a',
      logger as never,
      'teste'
    )

    expect(adapterLoadMock).toHaveBeenCalledWith('warmup')
    expect(adapterSaveMock).toHaveBeenCalledWith('warmup', { day: 3 })
  })

  it('envolve o socket com a configuracao do antiban', async () => {
    const logger = createLogger()
    const sock = { ev: { on: vi.fn() }, sendMessage: vi.fn() }
    const { wrapSocketWithAntiBan } = await import('../src/core/connection/antiban.ts')

    const wrapped = wrapSocketWithAntiBan(sock as never, logger as never, 'conn-a', { day: 1 } as never)

    expect(wrapped).toHaveProperty('antiban')
    expect(wrapSocketMock).toHaveBeenCalledWith(
      sock,
      expect.objectContaining({
        logging: false,
        rateLimiter: expect.objectContaining({ maxPerMinute: 8 }),
        health: expect.objectContaining({ autoPauseAt: 'high' }),
      }),
      { day: 1 }
    )
  })
})
