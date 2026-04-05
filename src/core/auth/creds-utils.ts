import { initAuthCreds, type AuthenticationCreds } from '@whiskeysockets/baileys'

/**
 * Par candidato de credenciais e sua origem.
 */
type CredsCandidate = {
  source: string
  creds: AuthenticationCreds | null
}

/**
 * Resultado da avaliacao de integridade das credenciais.
 */
type CredsScore = {
  score: number
  missingCritical: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isKeyPair = (value: unknown): boolean =>
  isRecord(value) && 'public' in value && 'private' in value

const isSignedPreKey = (value: unknown): boolean =>
  isRecord(value) &&
  isRecord(value.keyPair) &&
  isKeyPair(value.keyPair) &&
  Boolean(value.signature)

const isNumber = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value)

const isBoolean = (value: unknown): boolean => typeof value === 'boolean'

const isNonEmptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0

const isArray = (value: unknown): boolean => Array.isArray(value)

const isObject = (value: unknown): boolean => isRecord(value)

const CRITICAL_CHECKS: Array<{ key: string; check: (value: unknown) => boolean; weight: number }> = [
  { key: 'noiseKey', check: isKeyPair, weight: 3 },
  { key: 'signedIdentityKey', check: isKeyPair, weight: 3 },
  { key: 'signedPreKey', check: isSignedPreKey, weight: 3 },
  { key: 'registrationId', check: isNumber, weight: 2 },
  { key: 'advSecretKey', check: isNonEmptyString, weight: 2 },
]

const IMPORTANT_CHECKS: Array<{ key: string; check: (value: unknown) => boolean; weight: number }> = [
  { key: 'pairingEphemeralKeyPair', check: isKeyPair, weight: 1 },
  { key: 'processedHistoryMessages', check: isArray, weight: 1 },
  { key: 'nextPreKeyId', check: isNumber, weight: 1 },
  { key: 'firstUnuploadedPreKeyId', check: isNumber, weight: 1 },
  { key: 'accountSyncCounter', check: isNumber, weight: 1 },
  { key: 'accountSettings', check: isObject, weight: 1 },
  { key: 'registered', check: isBoolean, weight: 1 },
  { key: 'me', check: isObject, weight: 1 },
  { key: 'account', check: isObject, weight: 1 },
]

/**
 * Normaliza um objeto de credenciais, garantindo campos minimos e defaults.
 */
export const normalizeCreds = (input: AuthenticationCreds | null | undefined): AuthenticationCreds => {
  const base = initAuthCreds()
  if (!input || typeof input !== 'object') return base
  const creds = input
  return {
    ...base,
    ...creds,
    noiseKey: creds.noiseKey ?? base.noiseKey,
    pairingEphemeralKeyPair: creds.pairingEphemeralKeyPair ?? base.pairingEphemeralKeyPair,
    signedIdentityKey: creds.signedIdentityKey ?? base.signedIdentityKey,
    signedPreKey: creds.signedPreKey ?? base.signedPreKey,
    processedHistoryMessages: Array.isArray(creds.processedHistoryMessages)
      ? creds.processedHistoryMessages
      : base.processedHistoryMessages,
    signalIdentities: Array.isArray(creds.signalIdentities)
      ? creds.signalIdentities
      : base.signalIdentities,
    accountSettings: {
      ...base.accountSettings,
      ...(creds.accountSettings ?? {}),
    },
    me: creds.me ?? base.me,
    account: creds.account ?? base.account,
  }
}

/**
 * Atribui pontuacao e lista de campos criticos ausentes.
 */
export const scoreCreds = (creds: AuthenticationCreds | null | undefined): CredsScore => {
  if (!creds || typeof creds !== 'object') {
    return { score: -1, missingCritical: CRITICAL_CHECKS.map((check) => check.key) }
  }
  let score = 0
  const missingCritical: string[] = []
  for (const check of CRITICAL_CHECKS) {
    if (check.check((creds as Record<string, unknown>)[check.key])) {
      score += check.weight
    } else {
      missingCritical.push(check.key)
    }
  }
  for (const check of IMPORTANT_CHECKS) {
    if (check.check((creds as Record<string, unknown>)[check.key])) {
      score += check.weight
    }
  }
  return { score, missingCritical }
}

/**
 * Seleciona o melhor conjunto de credenciais com base em completude e prioridade.
 */
export const selectBestCreds = (
  candidates: CredsCandidate[],
  priority: string[]
): { creds: AuthenticationCreds; meta: { source: string; score: number; missingCritical: string[] } } => {
  const scored = candidates.map((candidate) => {
    const { score, missingCritical } = scoreCreds(candidate.creds)
    const priorityIndex = priority.indexOf(candidate.source)
    return {
      ...candidate,
      score,
      missingCritical,
      priorityIndex: priorityIndex >= 0 ? priorityIndex : Number.POSITIVE_INFINITY,
    }
  })

  const valid = scored.filter((entry) => entry.score >= 0)
  if (!valid.length) {
    return {
      creds: initAuthCreds(),
      meta: { source: 'init', score: 0, missingCritical: CRITICAL_CHECKS.map((check) => check.key) },
    }
  }

  valid.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.priorityIndex - b.priorityIndex
  })

  const best = valid[0]
  return {
    creds: normalizeCreds(best.creds),
    meta: { source: best.source, score: best.score, missingCritical: best.missingCritical },
  }
}
