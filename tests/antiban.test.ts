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
  antibanMaxIdenticalMessages: 200,
  antibanIdenticalMessageWindowMs: 60000,
  antibanBurstAllowance: 20,
  antibanWarmUpDays: 7,
  antibanWarmUpDay1Limit: 20,
  antibanWarmUpGrowthFactor: 1.8,
  antibanInactivityThresholdHours: 72,
  antibanJidCanonicalizerEnabled: true,
  antibanLidCanonical: 'pn',
  antibanLidMaxEntries: 10000,
  antibanDeafSessionEnabled: true,
  antibanDeafSessionTimeoutMs: 300000,
  antibanDeafSessionMinUptimeMs: 120000,
  antibanDeafSessionAutoReconnect: true,
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
  LidResolver: class {
    config: unknown
    constructor(config: unknown) {
      this.config = config
    }
  },
  JidCanonicalizer: class {
    config: unknown
    constructor(config: unknown) {
      this.config = config
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
  mockConfig.antibanEnabled = true
  mockConfig.antibanDeafSessionEnabled = true
  adapterLoadMock.mockResolvedValue({ day: 2 })
  adapterSaveMock.mockResolvedValue(undefined)
  wrapSocketMock.mockImplementation((sock) => ({
    ...sock,
    antiban: {
      exportWarmUpState: () => ({ day: 2 }),
      getStats: () => ({}),
      rateLimiter: { config: {} },
      health: { config: {} },
      timelock: { config: {} },
    },
  }))
})

describe('antiban helper', () => {
  it('carrega e salva o warm-up por connectionId', async () => {
    const logger = createLogger()
    const { loadAntiBanWarmUpState, saveAntiBanWarmUpState } = await import('../src/core/connection/antiban.ts')

    const loaded = await loadAntiBanWarmUpState('conn-a', logger as never)
    expect(loaded).toEqual({ day: 2 })

    await saveAntiBanWarmUpState({ antiban: { exportWarmUpState: () => ({ day: 3 }), getStats: () => ({}) } } as never, 'conn-a', logger as never, 'teste')

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
        maxPerMinute: 8,
        maxPerHour: 200,
        maxPerDay: 1500,
        minDelayMs: 1500,
        maxDelayMs: 5000,
        newChatDelayMs: 3000,
        warmupDays: 7,
        day1Limit: 20,
        growthFactor: 1.8,
        inactivityThresholdHours: 72,
        autoPauseAt: 'high',
      }),
      { day: 1 },
      expect.objectContaining({
        deafSession: expect.objectContaining({
          timeoutMs: 300000,
          minUptimeMs: 120000,
          autoReconnect: true,
          onDeafSession: expect.any(Function),
        }),
      })
    )
  })

  it('retorna undefined no load quando antiban esta desativado', async () => {
    mockConfig.antibanEnabled = false
    const logger = createLogger()
    const { loadAntiBanWarmUpState } = await import('../src/core/connection/antiban.ts')

    const loaded = await loadAntiBanWarmUpState('conn-a', logger as never)

    expect(loaded).toBeUndefined()
    expect(adapterLoadMock).not.toHaveBeenCalled()
  })

  it('retorna undefined e loga warn quando load falha', async () => {
    const logger = createLogger()
    adapterLoadMock.mockRejectedValueOnce(new Error('boom'))
    const { loadAntiBanWarmUpState } = await import('../src/core/connection/antiban.ts')

    const loaded = await loadAntiBanWarmUpState('conn-a', logger as never)

    expect(loaded).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith('falha ao carregar estado de warm-up do antiban', expect.objectContaining({ connectionId: 'conn-a', err: expect.any(Error) }))
  })

  it('nao salva quando socket nao possui antiban', async () => {
    const logger = createLogger()
    const { saveAntiBanWarmUpState } = await import('../src/core/connection/antiban.ts')

    await saveAntiBanWarmUpState({} as never, 'conn-a', logger as never, 'sem-antiban')

    expect(adapterSaveMock).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it('loga warn quando save falha', async () => {
    const logger = createLogger()
    adapterSaveMock.mockRejectedValueOnce(new Error('save failed'))
    const { saveAntiBanWarmUpState } = await import('../src/core/connection/antiban.ts')

    await saveAntiBanWarmUpState({ antiban: { exportWarmUpState: () => ({ day: 3 }), getStats: () => ({}) } } as never, 'conn-a', logger as never, 'teste-save')

    expect(logger.warn).toHaveBeenCalledWith('falha ao salvar estado de warm-up do antiban', expect.objectContaining({ connectionId: 'conn-a', reason: 'teste-save', err: expect.any(Error) }))
  })

  it('retorna o socket original quando antiban esta desativado', async () => {
    mockConfig.antibanEnabled = false
    const logger = createLogger()
    const sock = { ev: { on: vi.fn() }, sendMessage: vi.fn() }
    const { wrapSocketWithAntiBan } = await import('../src/core/connection/antiban.ts')

    const wrapped = wrapSocketWithAntiBan(sock as never, logger as never, 'conn-a')

    expect(wrapped).toBe(sock)
    expect(wrapSocketMock).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('cria callbacks de observabilidade e deafSession no runtime', async () => {
    const logger = createLogger()
    const { createAntiBanConfig, wrapSocketWithAntiBan } = await import('../src/core/connection/antiban.ts')

    const antibanConfig = createAntiBanConfig(logger as never, 'conn-z') as Record<string, unknown>
    expect(antibanConfig.autoPauseAt).toBe('high')
    expect(antibanConfig).not.toHaveProperty('health')
    expect(antibanConfig).not.toHaveProperty('timelock')

    const wrapped = wrapSocketWithAntiBan({ ev: { on: vi.fn() }, sendMessage: vi.fn() } as never, logger as never, 'conn-z', { day: 1 } as never)
    expect(wrapped).toHaveProperty('antiban')
    const wrapOptions = wrapSocketMock.mock.calls.at(-1)?.[3] as {
      deafSession?: {
        onDeafSession: (state: unknown) => void
        timeoutMs: number
        minUptimeMs: number
        autoReconnect: boolean
      }
    }
    const deafSession = wrapOptions?.deafSession
    const wrappedAntiban = (wrapped as { antiban?: { health?: { config?: { onRiskChange?: (status: unknown) => void } }; timelock?: { config?: { onTimelockDetected?: (state: unknown) => void; onTimelockLifted?: (state: unknown) => void } }; rateLimiter?: { config?: Record<string, unknown> }; jidCanonicalizerModule?: unknown; lidResolverModule?: unknown } }).antiban

    wrappedAntiban?.health?.config?.onRiskChange?.({ risk: 'high', score: 90, reasons: ['burst'], recommendation: 'pause' })
    wrappedAntiban?.timelock?.config?.onTimelockDetected?.({ enforcementType: 'temporary', expiresAt: new Date('2026-05-10T00:00:00.000Z'), errorCount: 2 })
    wrappedAntiban?.timelock?.config?.onTimelockLifted?.({ enforcementType: 'temporary', errorCount: 0 })
    deafSession?.onDeafSession({
      lastMessageAt: new Date('2026-05-17T17:00:00.000Z'),
      silenceDurationMs: 1000,
      connectedSinceMs: 9999,
    })

    expect(wrappedAntiban?.rateLimiter?.config).toEqual(
      expect.objectContaining({
        maxIdenticalMessages: 200,
        identicalMessageWindowMs: 60000,
        burstAllowance: 20,
      })
    )
    expect(wrappedAntiban?.jidCanonicalizerModule).toBeTruthy()
    expect(wrappedAntiban?.lidResolverModule).toBeTruthy()
    expect(deafSession?.timeoutMs).toBe(300000)
    expect(deafSession?.minUptimeMs).toBe(120000)
    expect(deafSession?.autoReconnect).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith('antiban alterou o nivel de risco', expect.objectContaining({ connectionId: 'conn-z', risk: 'high', score: 90 }))
    expect(logger.warn).toHaveBeenCalledWith('antiban detectou reachout timelock', expect.objectContaining({ connectionId: 'conn-z', enforcementType: 'temporary', errorCount: 2 }))
    expect(logger.info).toHaveBeenCalledWith('antiban liberou o reachout timelock', expect.objectContaining({ connectionId: 'conn-z', enforcementType: 'temporary', errorCount: 0 }))
    expect(logger.warn).toHaveBeenCalledWith(
      'antiban detectou sessao possivelmente surda',
      expect.objectContaining({
        connectionId: 'conn-z',
        lastMessageAt: '2026-05-17T17:00:00.000Z',
        silenceDurationMs: 1000,
        connectedSinceMs: 9999,
        autoReconnect: true,
      })
    )
  })

  it('nao inclui deafSession quando desabilitado', async () => {
    mockConfig.antibanDeafSessionEnabled = false
    const logger = createLogger()
    const { createAntiBanConfig, wrapSocketWithAntiBan } = await import('../src/core/connection/antiban.ts')

    const antibanConfig = createAntiBanConfig(logger as never, 'conn-z') as Record<string, unknown>
    expect(antibanConfig).not.toHaveProperty('deafSession')

    wrapSocketWithAntiBan({ ev: { on: vi.fn() }, sendMessage: vi.fn() } as never, logger as never, 'conn-z')
    const wrapOptions = wrapSocketMock.mock.calls.at(-1)?.[3] as { deafSession?: unknown } | undefined
    expect(wrapOptions?.deafSession).toBeUndefined()
  })
})
