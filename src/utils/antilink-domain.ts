import { domainToASCII } from 'node:url'

const COMMON_COUNTRY_SECOND_LEVEL_LABELS = new Set([
  'ac',
  'biz',
  'co',
  'com',
  'edu',
  'gov',
  'mil',
  'net',
  'nom',
  'org',
])

const MULTI_TENANT_HOST_SUFFIXES = new Set([
  'blogspot.com',
  'firebaseapp.com',
  'github.io',
  'glitch.me',
  'herokuapp.com',
  'netlify.app',
  'notion.site',
  'onrender.com',
  'pages.dev',
  'railway.app',
  'surge.sh',
  'vercel.app',
  'web.app',
  'workers.dev',
])

type ParsedAntilinkDomain = {
  host: string
  wildcard: boolean
  registrableHost: string
}

const parseInputHost = (value: string): string | null => {
  const trimmed = value.trim()
  if (!trimmed) return null

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(candidate).hostname
  } catch {
    const fallback = trimmed
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .split(/[/?#]/, 1)[0]
      ?.split('@')
      .at(-1) ?? ''
    return fallback || null
  }
}

const normalizeHost = (host: string): string | null => {
  const asciiHost = domainToASCII(host.replace(/\.+$/, '').toLowerCase()).toLowerCase()
  if (!asciiHost) return null
  if (asciiHost.startsWith('www.')) {
    return asciiHost.slice(4) || null
  }
  return asciiHost
}

const getRegistrableHost = (host: string): string => {
  if (!host.includes('.')) return host

  for (const suffix of MULTI_TENANT_HOST_SUFFIXES) {
    if (host === suffix) return host
    if (host.endsWith(`.${suffix}`)) return host
  }

  const labels = host.split('.').filter(Boolean)
  if (labels.length <= 2) return host

  const topLevelLabel = labels.at(-1) ?? ''
  const secondLevelLabel = labels.at(-2) ?? ''
  const labelCount = topLevelLabel.length === 2 && COMMON_COUNTRY_SECOND_LEVEL_LABELS.has(secondLevelLabel) ? 3 : 2

  if (labels.length < labelCount) return host
  return labels.slice(-labelCount).join('.')
}

export const parseAntilinkDomain = (value: string | undefined): ParsedAntilinkDomain | null => {
  if (!value) return null

  const trimmed = value.trim()
  if (!trimmed) return null

  const wildcard = trimmed.startsWith('*.')
  const raw = wildcard ? trimmed.slice(2) : trimmed
  if (!raw) return null

  const hostname = parseInputHost(raw)
  if (!hostname) return null

  const host = normalizeHost(hostname)
  if (!host) return null

  return {
    host,
    wildcard,
    registrableHost: getRegistrableHost(host),
  }
}

export const normalizeAntilinkDomain = (value: string | undefined): string | null => {
  const parsed = parseAntilinkDomain(value)
  if (!parsed) return null
  return parsed.wildcard ? `*.${parsed.host}` : parsed.host
}
