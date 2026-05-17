import { describe, expect, it } from 'vitest'
import { isSuspiciousDisplayName, pickBetterDisplayName, scoreDisplayName } from '../src/utils/display-name.js'

describe('display-name quality helpers', () => {
  it('prefere nomes mais humanos do que identificadores crus', () => {
    expect(scoreDisplayName('João Silva')).toBeGreaterThan(scoreDisplayName('5511999999999'))
    expect(scoreDisplayName('Equipe Financeiro')).toBeGreaterThan(scoreDisplayName('contato@s.whatsapp.net'))
  })

  it('detecta nomes suspeitos', () => {
    expect(isSuspiciousDisplayName('1')).toBe(true)
    expect(isSuspiciousDisplayName('5511999999999')).toBe(true)
    expect(isSuspiciousDisplayName('bot@s.whatsapp.net')).toBe(true)
    expect(isSuspiciousDisplayName('João Silva')).toBe(false)
  })

  it('mantem nome atual quando o candidato e pior', () => {
    expect(pickBetterDisplayName('João Silva', '5511999999999')).toBe('João Silva')
    expect(pickBetterDisplayName('Equipe Financeiro', 'bot@s.whatsapp.net')).toBe('Equipe Financeiro')
  })

  it('promove nome candidato quando ele e melhor', () => {
    expect(pickBetterDisplayName('5511999999999', 'João Silva')).toBe('João Silva')
    expect(pickBetterDisplayName('contato@s.whatsapp.net', 'Maria Souza')).toBe('Maria Souza')
  })
})
