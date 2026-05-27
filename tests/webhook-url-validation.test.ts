import { describe, expect, it } from 'vitest'
import { validateWebhookUrl } from '../src/webhook/url-validation.ts'

describe('webhook url validation', () => {
  it('aceita URL pública http/https', () => {
    const result = validateWebhookUrl('https://example.com/webhook')
    expect(result.ok).toBe(true)
  })

  it('rejeita host local', () => {
    const result = validateWebhookUrl('https://localhost:3000/hook')
    expect(result.ok).toBe(false)
  })

  it('rejeita IP privado', () => {
    const result = validateWebhookUrl('https://10.0.0.15/hook')
    expect(result.ok).toBe(false)
  })

  it('rejeita hostname interno sem domínio público', () => {
    const result = validateWebhookUrl('https://intranet/hook')
    expect(result.ok).toBe(false)
  })

  it('rejeita URL com credenciais embutidas', () => {
    const result = validateWebhookUrl('https://user:pass@example.com/hook')
    expect(result.ok).toBe(false)
  })

  it('rejeita IPv6 loopback', () => {
    const result = validateWebhookUrl('https://[::1]/hook')
    expect(result.ok).toBe(false)
  })
})
