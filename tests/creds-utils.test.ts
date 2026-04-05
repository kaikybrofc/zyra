import { describe, expect, it } from 'vitest'
import { initAuthCreds, type AuthenticationCreds } from '@whiskeysockets/baileys'
import { normalizeCreds, scoreCreds, selectBestCreds } from '../src/core/auth/creds-utils.js'

describe('creds-utils', () => {
  it('scoreCreds retorna -1 e lista campos criticos quando null', () => {
    const result = scoreCreds(null)
    expect(result.score).toBe(-1)
    expect(result.missingCritical.length).toBeGreaterThan(0)
  })

  it('normalizeCreds aplica defaults e preserva accountSettings', () => {
    const base = initAuthCreds()
    const input: AuthenticationCreds = {
      ...base,
      accountSettings: { ...base.accountSettings, unarchiveChats: true },
      processedHistoryMessages: undefined as unknown as AuthenticationCreds['processedHistoryMessages'],
    }

    const normalized = normalizeCreds(input)
    expect(normalized.accountSettings.unarchiveChats).toBe(true)
    expect(Array.isArray(normalized.processedHistoryMessages)).toBe(true)
  })

  it('selectBestCreds prioriza credenciais completas mesmo fora da prioridade', () => {
    const good = initAuthCreds()
    const bad = { ...good, noiseKey: undefined } as unknown as AuthenticationCreds

    const selection = selectBestCreds(
      [
        { source: 'redis', creds: bad },
        { source: 'disk', creds: good },
      ],
      ['redis', 'disk']
    )

    expect(selection.meta.source).toBe('disk')
    expect(selection.meta.missingCritical.length).toBe(0)
  })

  it('scoreCreds considera registrationId invalido como critico', () => {
    const creds = initAuthCreds()
    const result = scoreCreds({ ...creds, registrationId: 0 })
    expect(result.missingCritical).toContain('registrationId')
  })

  it('selectBestCreds evita credencial com chave invalida mesmo se for prioridade', () => {
    const good = initAuthCreds()
    const badKey = {
      ...good,
      noiseKey: { public: 'x', private: 'y' },
    } as unknown as AuthenticationCreds

    const selection = selectBestCreds(
      [
        { source: 'redis', creds: badKey },
        { source: 'disk', creds: good },
      ],
      ['redis', 'disk']
    )

    expect(selection.meta.source).toBe('disk')
  })

  it('selectBestCreds retorna init quando nenhum candidato valido', () => {
    const selection = selectBestCreds(
      [
        { source: 'redis', creds: null },
        { source: 'disk', creds: null },
      ],
      ['redis', 'disk']
    )

    expect(selection.meta.source).toBe('init')
    expect(selection.meta.missingCritical.length).toBeGreaterThan(0)
  })
})
