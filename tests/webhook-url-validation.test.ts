import { afterEach, describe, expect, it } from 'vitest'
import { resolveAllowedWebhookTarget, validateWebhookUrl } from '../src/webhook/url-validation.ts'

describe('webhook url validation', () => {
  const originalAllowedTargets = process.env.WA_WEBHOOK_ALLOWED_TARGETS

  afterEach(() => {
    if (originalAllowedTargets === undefined) {
      delete process.env.WA_WEBHOOK_ALLOWED_TARGETS
    } else {
      process.env.WA_WEBHOOK_ALLOWED_TARGETS = originalAllowedTargets
    }
  })

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

  it('resolve target permitido da allowlist', () => {
    process.env.WA_WEBHOOK_ALLOWED_TARGETS = 'https://example.com/webhook,https://api.exemplo.com/hook'
    const result = resolveAllowedWebhookTarget('https://example.com/webhook')
    expect(result.ok).toBe(true)
  })

  it('rejeita target fora da allowlist', () => {
    process.env.WA_WEBHOOK_ALLOWED_TARGETS = 'https://example.com/webhook'
    const result = resolveAllowedWebhookTarget('https://api.exemplo.com/hook')
    expect(result.ok).toBe(false)
  })
})
