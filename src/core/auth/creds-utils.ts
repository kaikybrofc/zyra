import { initAuthCreds, type AuthenticationCreds } from '@whiskeysockets/baileys'

/**
 * Representa a origem de onde as credenciais foram recuperadas.
 */
type CredsSource = 'mysql' | 'redis' | 'disk' | 'init'

/**
 * Encapsula um conjunto de credenciais de autenticação associado à sua fonte de origem.
 */
type CredsCandidate = {
  /** Fonte dos dados (ex: 'redis', 'mysql') */
  source: CredsSource
  /** O objeto de credenciais recuperado ou null caso a fonte esteja vazia */
  creds: AuthenticationCreds | null
}

/**
 * Objeto resultante da avaliação de saúde e integridade de uma sessão.
 */
type CredsScore = {
  /** * Pontuação total de integridade.
   * Valores maiores indicam sessões mais completas. Score -1 indica falha total.
   */
  score: number
  /** Lista de chaves críticas que não passaram na validação (ex: 'noiseKey', 'signedPreKey') */
  missingCritical: string[]
}

// --- Validações Internas ---

/** @internal */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** @internal */
const isBinary = (value: unknown): value is Uint8Array => value instanceof Uint8Array

/** @internal */
const hasBinaryData = (value: unknown): boolean => isBinary(value) && value.length > 0

/** @internal */
const isKeyPair = (value: unknown): boolean => isRecord(value) && hasBinaryData(value.public) && hasBinaryData(value.private)

/** @internal */
const isSignedPreKey = (value: unknown): boolean => isRecord(value) && isRecord(value.keyPair) && isKeyPair(value.keyPair) && hasBinaryData(value.signature)

/** @internal */
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** @internal */
const isNonNegativeNumber = (value: unknown): boolean => isNumber(value) && value >= 0

/** @internal */
const isBoolean = (value: unknown): boolean => typeof value === 'boolean'

/** @internal */
const isNonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0

/** @internal */
const isArray = (value: unknown): boolean => Array.isArray(value)

/** @internal */
const isObject = (value: unknown): boolean => isRecord(value)

/** @internal */
const hasId = (value: unknown): boolean => isRecord(value) && isNonEmptyString((value as { id?: unknown }).id)

type CredsCheck = {
  key: string
  check: (value: unknown) => boolean
  weight: number
  shouldCheck?: (creds: AuthenticationCreds) => boolean
}

const shouldRequireAdvSecretKey = (creds: AuthenticationCreds): boolean => isObject((creds as Record<string, unknown>).account)

/**
 * Definição de campos cujo preenchimento correto é obrigatório para o funcionamento do socket.
 * @internal
 */
const CRITICAL_CHECKS: CredsCheck[] = [
  { key: 'noiseKey', check: isKeyPair, weight: 3 },
  { key: 'signedIdentityKey', check: isKeyPair, weight: 3 },
  { key: 'signedPreKey', check: isSignedPreKey, weight: 3 },
  { key: 'registrationId', check: isNonNegativeNumber, weight: 2 },
  {
    key: 'advSecretKey',
    check: isNonEmptyString,
    weight: 3,
    shouldCheck: shouldRequireAdvSecretKey,
  },
]

/**
 * Definição de campos que auxiliam na persistência da sessão e histórico, mas não impedem o boot inicial.
 * @internal
 */
const IMPORTANT_CHECKS: CredsCheck[] = [
  { key: 'pairingEphemeralKeyPair', check: isKeyPair, weight: 1 },
  { key: 'processedHistoryMessages', check: isArray, weight: 1 },
  { key: 'nextPreKeyId', check: isNumber, weight: 1 },
  { key: 'firstUnuploadedPreKeyId', check: isNumber, weight: 1 },
  { key: 'accountSyncCounter', check: isNumber, weight: 1 },
  { key: 'accountSettings', check: isObject, weight: 1 },
  { key: 'registered', check: isBoolean, weight: 1 },
  { key: 'me', check: hasId, weight: 1 },
  { key: 'account', check: isObject, weight: 1 },
]

/**
 * Higieniza e normaliza um objeto de credenciais.
 * * @remarks
 * Esta função garante que, mesmo que o input esteja parcial, o objeto retornado contenha
 * a estrutura básica necessária exigida pela interface {@link AuthenticationCreds},
 * preenchendo lacunas com valores gerados pelo `initAuthCreds()`.
 * * @param input - Credenciais brutas (geralmente lidas de um banco de dados ou arquivo).
 * @returns Um objeto de credenciais garantidamente compatível com o Baileys.
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
    processedHistoryMessages: Array.isArray(creds.processedHistoryMessages) ? creds.processedHistoryMessages : base.processedHistoryMessages,
    signalIdentities: Array.isArray(creds.signalIdentities) ? creds.signalIdentities : base.signalIdentities,
    accountSettings: {
      ...base.accountSettings,
      ...(creds.accountSettings ?? {}),
    },
    me: creds.me ?? base.me,
    account: creds.account ?? base.account,
  }
}

/**
 * Calcula a pontuação de integridade das credenciais com base na presença e validade dos campos.
 * * @remarks
 * O cálculo utiliza pesos diferenciados:
 * - Chaves criptográficas (Noise, Identity, SignedPreKey): Peso 3.
 * - ID de Registro: Peso 2.
 * - Metadados e contadores: Peso 1.
 * * @param creds - O objeto de credenciais a ser avaliado.
 * @returns Um objeto {@link CredsScore} contendo o score final e falhas críticas.
 */
export const scoreCreds = (creds: AuthenticationCreds | null | undefined): CredsScore => {
  if (!creds || typeof creds !== 'object') {
    return { score: -1, missingCritical: CRITICAL_CHECKS.map((check) => check.key) }
  }
  let score = 0
  const missingCritical: string[] = []
  for (const check of CRITICAL_CHECKS) {
    if (check.shouldCheck && !check.shouldCheck(creds)) continue
    if (check.check((creds as Record<string, unknown>)[check.key])) {
      score += check.weight
    } else {
      missingCritical.push(check.key)
    }
  }
  for (const check of IMPORTANT_CHECKS) {
    if (check.shouldCheck && !check.shouldCheck(creds)) continue
    if (check.check((creds as Record<string, unknown>)[check.key])) {
      score += check.weight
    }
  }
  return { score, missingCritical }
}

/**
 * Algoritmo de seleção para determinar a melhor sessão disponível entre múltiplas fontes.
 * * @remarks
 * A lógica de decisão segue este fluxo:
 * 1. Filtra candidatos com score válido.
 * 2. Prioriza candidatos que **não** possuem campos críticos ausentes.
 * 3. Se houver empate, escolhe o candidato com maior pontuação total.
 * 4. Persistindo o empate, aplica a ordem de preferência definida no parâmetro `priority`.
 * * @example
 * ```typescript
 * const best = selectBestCreds(
 * [{ source: 'redis', creds: c1 }, { source: 'mysql', creds: c2 }],
 * ['redis', 'mysql']
 * );
 * ```
 * * @param candidates - Array de possíveis credenciais encontradas.
 * @param priority - Lista de fontes em ordem decrescente de confiabilidade manual.
 * @returns O melhor objeto {@link AuthenticationCreds} e metadados sobre a escolha.
 */
export const selectBestCreds = (candidates: CredsCandidate[], priority: CredsSource[]): { creds: AuthenticationCreds; meta: { source: string; score: number; missingCritical: string[] } } => {
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

  const complete = valid.filter((entry) => entry.missingCritical.length === 0)
  const pool = complete.length ? complete : valid

  pool.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.priorityIndex - b.priorityIndex
  })

  const best = pool[0]
  return {
    creds: normalizeCreds(best.creds),
    meta: { source: best.source, score: best.score, missingCritical: best.missingCritical },
  }
}
