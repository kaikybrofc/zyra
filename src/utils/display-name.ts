const WHITESPACE = /\s+/g
const IDENTIFIER_LIKE = /^[0-9@+().\-_:]+$/

const normalizeWhitespace = (value: string) => value.replace(WHITESPACE, ' ').trim()

/**
 * Normaliza um nome de exibição bruto para comparação e persistência.
 */
export const normalizeDisplayNameCandidate = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const normalized = normalizeWhitespace(value)
  if (!normalized) return null
  return normalized
}

/**
 * Indica se um nome parece fraco, técnico ou improvável para uso humano.
 */
export const isSuspiciousDisplayName = (value: string): boolean => {
  const normalized = normalizeWhitespace(value)
  if (!normalized) return true
  if (normalized.length < 2) return true
  if (IDENTIFIER_LIKE.test(normalized)) return true
  if (normalized.includes('@') && normalized.length < 24) return true
  return false
}

/**
 * Atribui uma pontuação heurística para priorizar nomes de exibição melhores.
 */
export const scoreDisplayName = (value: string): number => {
  const normalized = normalizeWhitespace(value)
  if (!normalized) return 0

  let score = 0
  if (normalized.length >= 2) score += 10
  if (normalized.length >= 4) score += 10
  if (normalized.length >= 8) score += 5
  if (/[A-Za-zÀ-ÿ]/.test(normalized)) score += 20
  if (/\s/.test(normalized)) score += 10
  if (!IDENTIFIER_LIKE.test(normalized)) score += 10
  if (!normalized.includes('@')) score += 10
  if (/^[A-ZÀ-Ý]/.test(normalized)) score += 5
  if (/[a-zà-ÿ]/.test(normalized)) score += 5
  if (/[A-ZÀ-Ý].*[a-zà-ÿ]|[a-zà-ÿ].*[A-ZÀ-Ý]/.test(normalized)) score += 5
  if (isSuspiciousDisplayName(normalized)) score -= 20

  return Math.max(0, score)
}

/**
 * Escolhe o melhor nome de exibição entre o valor atual e um candidato novo.
 */
export const pickBetterDisplayName = (current: string | null | undefined, candidate: string | null | undefined): string | null => {
  const normalizedCurrent = normalizeDisplayNameCandidate(current)
  const normalizedCandidate = normalizeDisplayNameCandidate(candidate)

  if (!normalizedCurrent) return normalizedCandidate
  if (!normalizedCandidate) return normalizedCurrent

  const currentScore = scoreDisplayName(normalizedCurrent)
  const candidateScore = scoreDisplayName(normalizedCandidate)

  if (candidateScore > currentScore) return normalizedCandidate
  if (candidateScore < currentScore) return normalizedCurrent
  if (normalizedCandidate.length > normalizedCurrent.length) return normalizedCandidate
  return normalizedCurrent
}
