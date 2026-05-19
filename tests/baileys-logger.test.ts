import { describe, expect, it, vi } from 'vitest'
import { createBaileysLogger } from '../src/observability/baileys-logger.ts'

const createLogger = () => ({
  level: 'info',
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
})

describe('baileys-logger', () => {
  it('colapsa o par recorrente de decrypt em um unico log canonico', () => {
    const base = createLogger()
    const logger = createBaileysLogger(base as never, { connectionId: 'conn' })
    const err = new Error('Key used already or never filled')
    err.name = 'MessageCounterError'

    logger.error({ err }, 'transaction failed, rolling back')
    logger.error({ err, author: 'user@lid', sender: 'group@g.us', messageType: 'pkmsg' }, 'failed to decrypt message')

    expect(base.error).toHaveBeenCalledTimes(1)
    expect(base.error).toHaveBeenCalledWith(
      'falha recorrente de decrypt detectada',
      expect.objectContaining({
        connectionId: 'conn',
        classification: 'signal-message-counter-error',
        attempt: 1,
        suppressedDuplicates: 0,
        author: 'user@lid',
        remoteJid: 'group@g.us',
        errorName: 'MessageCounterError',
        errorMessage: 'Key used already or never filled',
        messageType: 'pkmsg',
      })
    )
  })

  it('nao altera erros nao classificados', () => {
    const base = createLogger()
    const logger = createBaileysLogger(base as never, { connectionId: 'conn' })
    const err = new Error('boom')

    logger.error({ err }, 'unexpected baileys error')

    expect(base.error).toHaveBeenCalledTimes(1)
    expect(base.error).toHaveBeenCalledWith('unexpected baileys error', expect.objectContaining({ err }))
  })
})
