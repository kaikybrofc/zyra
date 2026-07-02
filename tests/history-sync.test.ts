import { initAuthCreds, proto } from 'baileys'
import { describe, expect, it } from 'vitest'

describe('history-sync', () => {
  it('bloqueia sync quando bootstrap tecnico nao foi habilitado', async () => {
    const { createHistorySyncPolicy } = await import('../src/core/connection/history-sync.ts')
    const creds = initAuthCreds()
    creds.accountSyncCounter = 0

    const policy = createHistorySyncPolicy(creds)
    expect(policy.shouldSyncHistoryMessage({} as never)).toBe(false)
  })

  it('permite sync inicial tecnico quando habilitado', async () => {
    const { createHistorySyncPolicy } = await import('../src/core/connection/history-sync.ts')
    const creds = initAuthCreds()
    creds.accountSyncCounter = 10

    const policy = createHistorySyncPolicy(creds, { allowInitialBootstrap: true })
    expect(policy.shouldSyncHistoryMessage({ syncType: proto.Message.HistorySyncType.INITIAL_BOOTSTRAP } as never)).toBe(true)
    expect(policy.shouldSyncHistoryMessage({ syncType: proto.Message.HistorySyncType.PUSH_NAME } as never)).toBe(true)
    expect(policy.shouldSyncHistoryMessage({ syncType: proto.Message.HistorySyncType.NON_BLOCKING_DATA } as never)).toBe(true)
  })

  it('bloqueia sync recente e on-demand para evitar replay de mensagens antigas', async () => {
    const { createHistorySyncPolicy } = await import('../src/core/connection/history-sync.ts')
    const creds = initAuthCreds()

    const policy = createHistorySyncPolicy(creds, { allowInitialBootstrap: true })
    expect(policy.shouldSyncHistoryMessage({ syncType: proto.Message.HistorySyncType.RECENT } as never)).toBe(false)
    expect(policy.shouldSyncHistoryMessage({ syncType: proto.Message.HistorySyncType.ON_DEMAND } as never)).toBe(false)
  })

  it('nao permite sync por padrao quando nao é primeiro login, mas libera sync tecnico via novo login quando habilitado', async () => {
    const { createHistorySyncPolicy } = await import('../src/core/connection/history-sync.ts')
    const creds = initAuthCreds()
    creds.accountSyncCounter = 10

    const policy = createHistorySyncPolicy(creds)
    expect(policy.shouldSyncHistoryMessage({} as never)).toBe(false)

    policy.allowOnceForNewLogin()
    expect(policy.shouldSyncHistoryMessage({} as never)).toBe(false)

    const explicitPolicy = createHistorySyncPolicy(creds, { allowNewLogin: true })
    explicitPolicy.allowOnceForNewLogin()
    expect(explicitPolicy.shouldSyncHistoryMessage({ syncType: proto.Message.HistorySyncType.INITIAL_BOOTSTRAP } as never)).toBe(true)
    expect(explicitPolicy.shouldSyncHistoryMessage({ syncType: proto.Message.HistorySyncType.RECENT } as never)).toBe(false)
  })

  it('nao vaza estado entre policies diferentes', async () => {
    const { createHistorySyncPolicy } = await import('../src/core/connection/history-sync.ts')
    const credsA = initAuthCreds()
    credsA.accountSyncCounter = 10
    const credsB = initAuthCreds()
    credsB.accountSyncCounter = 10

    const policyA = createHistorySyncPolicy(credsA, { allowNewLogin: true })
    const policyB = createHistorySyncPolicy(credsB, { allowNewLogin: true })

    policyA.allowOnceForNewLogin()
    expect(policyA.shouldSyncHistoryMessage({} as never)).toBe(true)
    expect(policyB.shouldSyncHistoryMessage({} as never)).toBe(false)
  })
})
