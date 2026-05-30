import { BlockList, isIP } from 'node:net'
import { config } from '../config/index.js'

const blockedAddressList = new BlockList()

blockedAddressList.addSubnet('0.0.0.0', 8, 'ipv4')
blockedAddressList.addSubnet('10.0.0.0', 8, 'ipv4')
blockedAddressList.addSubnet('100.64.0.0', 10, 'ipv4')
blockedAddressList.addSubnet('127.0.0.0', 8, 'ipv4')
blockedAddressList.addSubnet('169.254.0.0', 16, 'ipv4')
blockedAddressList.addSubnet('172.16.0.0', 12, 'ipv4')
blockedAddressList.addSubnet('192.0.0.0', 24, 'ipv4')
blockedAddressList.addSubnet('192.0.2.0', 24, 'ipv4')
blockedAddressList.addSubnet('192.168.0.0', 16, 'ipv4')
blockedAddressList.addSubnet('198.18.0.0', 15, 'ipv4')
blockedAddressList.addSubnet('198.51.100.0', 24, 'ipv4')
blockedAddressList.addSubnet('203.0.113.0', 24, 'ipv4')
blockedAddressList.addSubnet('224.0.0.0', 4, 'ipv4')

blockedAddressList.addSubnet('::', 128, 'ipv6')
blockedAddressList.addSubnet('::1', 128, 'ipv6')
blockedAddressList.addSubnet('fc00::', 7, 'ipv6')
blockedAddressList.addSubnet('fe80::', 10, 'ipv6')
blockedAddressList.addSubnet('ff00::', 8, 'ipv6')
blockedAddressList.addSubnet('2001:db8::', 32, 'ipv6')

const blockedHostnameSuffixes = ['.localhost', '.local', '.localdomain', '.internal', '.home', '.lan']

const normalizeHostname = (hostname: string): string => {
  const lowered = hostname.trim().toLowerCase()
  if (lowered.startsWith('[') && lowered.endsWith(']')) {
    return lowered.slice(1, -1)
  }
  return lowered
}

const hasBlockedHostnameSuffix = (hostname: string): boolean => {
  if (hostname === 'localhost') return true
  return blockedHostnameSuffixes.some((suffix) => hostname.endsWith(suffix))
}

const hasBlockedAddress = (hostname: string): boolean => {
  const family = isIP(hostname)
  if (family === 0) return false
  return blockedAddressList.check(hostname, family === 4 ? 'ipv4' : 'ipv6')
}

type WebhookUrlValidationSuccess = {
  ok: true
  parsedUrl: URL
}

type WebhookUrlValidationFailure = {
  ok: false
  reason: string
}

export type WebhookUrlValidationResult = WebhookUrlValidationSuccess | WebhookUrlValidationFailure

export const validateWebhookUrl = (value: string): WebhookUrlValidationResult => {
  const trimmed = value.trim()
  if (!trimmed) {
    return { ok: false, reason: 'campo url é obrigatório' }
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'campo url inválido' }
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { ok: false, reason: 'campo url deve usar http:// ou https://' }
  }

  if (parsedUrl.username || parsedUrl.password) {
    return { ok: false, reason: 'campo url não pode conter usuário/senha' }
  }

  const hostname = normalizeHostname(parsedUrl.hostname)
  if (!hostname) {
    return { ok: false, reason: 'campo url inválido' }
  }

  if (hasBlockedHostnameSuffix(hostname)) {
    return { ok: false, reason: 'campo url não pode apontar para host local' }
  }

  if (!hostname.includes('.') && isIP(hostname) === 0) {
    return { ok: false, reason: 'campo url deve conter um hostname público' }
  }

  if (hasBlockedAddress(hostname)) {
    return { ok: false, reason: 'campo url não pode apontar para IP privado ou reservado' }
  }

  return { ok: true, parsedUrl }
}

export type WebhookTargetResolution = { ok: true; targetUrl: string; parsedUrl: URL } | { ok: false; reason: string }

/**
 * Resolve um destino seguro de webhook a partir de uma allowlist de servidor.
 * O input do usuário apenas seleciona uma URL já permitida.
 */
export const resolveAllowedWebhookTarget = (value: string): WebhookTargetResolution => {
  const validated = validateWebhookUrl(value)
  if (!validated.ok) {
    return validated
  }

  const normalizedRequested = validated.parsedUrl.toString()
  const allowedTargets = config.webhookAllowedTargets
    .map((candidate) => validateWebhookUrl(candidate))
    .filter((candidate): candidate is WebhookUrlValidationSuccess => candidate.ok)
    .map((candidate) => candidate.parsedUrl)

  if (!allowedTargets.length) {
    return {
      ok: false,
      reason: 'nenhum destino autorizado configurado. defina WA_WEBHOOK_ALLOWED_TARGETS',
    }
  }

  for (const allowedTarget of allowedTargets) {
    if (allowedTarget.toString() === normalizedRequested) {
      return {
        ok: true,
        targetUrl: allowedTarget.toString(),
        parsedUrl: allowedTarget,
      }
    }
  }

  return {
    ok: false,
    reason: 'url não autorizada. ajuste WA_WEBHOOK_ALLOWED_TARGETS',
  }
}
