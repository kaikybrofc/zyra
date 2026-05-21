import { describe, expect, it, vi } from 'vitest'

const criarInstanciaLoggerMock = vi.fn()
const formatCombineMock = vi.fn((...parts: unknown[]) => ({ type: 'combine', parts }))
const formatFactoryMock = vi.fn((fn: (info: Record<string, unknown>) => unknown) => () => ({ type: 'custom-filter', fn }))

vi.mock('../src/observability/logger-module.ts', () => ({
  criarInstanciaLogger: (...args: unknown[]) => criarInstanciaLoggerMock(...args),
}))

vi.mock('../src/config/index.js', () => ({
  config: {
    logLevel: 'info',
  },
}))

vi.mock('logform', () => ({
  format: (...args: unknown[]) => formatFactoryMock(...args),
}))

vi.mock('winston', () => ({
  default: {
    format: {
      combine: (...args: unknown[]) => formatCombineMock(...args),
      colorize: vi.fn(() => 'colorize'),
      timestamp: vi.fn(() => 'timestamp'),
      errors: vi.fn(() => 'errors'),
      printf: vi.fn(() => 'printf'),
      json: vi.fn(() => 'json'),
    },
  },
}))

describe('logger transport routing', () => {
  it('configura filtros exatos para warn e error', async () => {
    criarInstanciaLoggerMock.mockReturnValue({ level: 'info', info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() })

    const { createLogger } = await import('../src/observability/logger.ts')
    createLogger()

    const transportDefinitions = criarInstanciaLoggerMock.mock.calls[0]?.[0]?.transportDefinitions
    expect(transportDefinitions).toHaveLength(4)

    const errorTransport = transportDefinitions[2]
    const warnTransport = transportDefinitions[3]

    expect(errorTransport.options.level).toBe('error')
    expect(warnTransport.options.level).toBe('warn')
    expect(formatFactoryMock).toHaveBeenCalledTimes(2)

    const errorFilter = errorTransport.options.format.parts[0].fn
    const warnFilter = warnTransport.options.format.parts[0].fn

    expect(errorFilter({ level: 'error', message: 'x' })).toEqual({ level: 'error', message: 'x' })
    expect(errorFilter({ level: 'warn', message: 'x' })).toBe(false)
    expect(warnFilter({ level: 'warn', message: 'x' })).toEqual({ level: 'warn', message: 'x' })
    expect(warnFilter({ level: 'error', message: 'x' })).toBe(false)
  })
})
