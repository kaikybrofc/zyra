const MAX_CONNECTION_ID_LENGTH = 80
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9._-]+$/

export type ConnectionIdValidationResult = { ok: true; value: string } | { ok: false; reason: string }

/**
 * Valida e normaliza connection_id para uso seguro em runtime, disco e persistência.
 */
export const validateConnectionId = (input: string | null | undefined): ConnectionIdValidationResult => {
  const value = input?.trim() ?? ''
  if (!value) return { ok: false, reason: 'connectionId é obrigatório' }
  if (value.length > MAX_CONNECTION_ID_LENGTH) {
    return { ok: false, reason: `connectionId excede ${MAX_CONNECTION_ID_LENGTH} caracteres` }
  }
  if (value.includes('..')) return { ok: false, reason: 'connectionId não pode conter ".."' }
  if (!CONNECTION_ID_PATTERN.test(value)) {
    return { ok: false, reason: 'connectionId deve conter apenas letras, números, ".", "_" e "-"' }
  }
  return { ok: true, value }
}

export const assertValidConnectionId = (input: string | null | undefined): string => {
  const result = validateConnectionId(input)
  if (result.ok) return result.value
  throw new Error(result.reason)
}
