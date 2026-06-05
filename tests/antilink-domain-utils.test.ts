import { describe, expect, it } from 'vitest'
import { normalizeAntilinkDomain, parseAntilinkDomain } from '../src/utils/antilink-domain.ts'

describe('antilink domain utils', () => {
  it('normaliza protocolo, path e alias comum de www', () => {
    expect(normalizeAntilinkDomain('https://www.exemplo.com/path?x=1')).toBe('exemplo.com')
  })

  it('identifica dominio registravel em ccTLD comum', () => {
    expect(parseAntilinkDomain('painel.exemplo.com.br')).toMatchObject({
      host: 'painel.exemplo.com.br',
      registrableHost: 'exemplo.com.br',
      wildcard: false,
    })
  })

  it('nao colapsa hosts multi-tenant em um raiz compartilhado', () => {
    expect(parseAntilinkDomain('docs.github.io')).toMatchObject({
      host: 'docs.github.io',
      registrableHost: 'docs.github.io',
      wildcard: false,
    })
    expect(parseAntilinkDomain('loja.vercel.app')).toMatchObject({
      host: 'loja.vercel.app',
      registrableHost: 'loja.vercel.app',
      wildcard: false,
    })
  })
})
