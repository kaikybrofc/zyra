import { initAuthCreds } from '@whiskeysockets/baileys'
import { describe, expect, it } from 'vitest'

describe('history-sync', () => {
  it('permite sync uma vez quando accountSyncCounter é 0', async () => {
    const { createHistorySyncPolicy } = await import('../src/core/connection/history-sync.ts')
    const creds = initAuthCreds()
    creds.accountSyncCounter = 0

    const policy = createHistorySyncPolicy(creds)
    expect(policy.shouldSyncHistoryMessage({} as never)).toBe(true)
    expect(policy.shouldSyncHistoryMessage({} as never)).toBe(false)
  })

  it('nao permite sync por padrao quando nao é primeiro login, mas libera via novo login', async () => {
    const { createHistorySyncPolicy } = await import('../src/core/connection/history-sync.ts')
    const creds = initAuthCreds()
    creds.accountSyncCounter = 10

    const policy = createHistorySyncPolicy(creds)
    expect(policy.shouldSyncHistoryMessage({} as never)).toBe(false)

    policy.allowOnceForNewLogin()
    expect(policy.shouldSyncHistoryMessage({} as never)).toBe(true)
    expect(policy.shouldSyncHistoryMessage({} as never)).toBe(false)
  })

  it('nao vaza estado entre policies diferentes', async () => {
    const { createHistorySyncPolicy } = await import('../src/core/connection/history-sync.ts')
    const credsA = initAuthCreds()
    credsA.accountSyncCounter = 10
    const credsB = initAuthCreds()
    credsB.accountSyncCounter = 10

    const policyA = createHistorySyncPolicy(credsA)
    const policyB = createHistorySyncPolicy(credsB)

    policyA.allowOnceForNewLogin()
    expect(policyA.shouldSyncHistoryMessage({} as never)).toBe(true)
    expect(policyB.shouldSyncHistoryMessage({} as never)).toBe(false)
  })
})

