import { config } from '../../config/index.js'

/**
 * Monta o namespace Redis baseado no prefixo e connection_id.
 */
export const getRedisNamespace = (connectionId?: string): string => {
  const base = config.redisPrefix ?? 'zyra:conexao'
  const resolvedId = connectionId ?? config.connectionId
  if (resolvedId && !base.endsWith(`:${resolvedId}`)) {
    return `${base}:${resolvedId}`
  }
  return base
}

/**
 * Retorna o namespace legado (sem connection_id) quando aplicavel.
 */
export const getLegacyRedisNamespace = (connectionId?: string): string | null => {
  const base = config.redisPrefix ?? 'zyra:conexao'
  const namespaced = getRedisNamespace(connectionId)
  return base === namespaced ? null : base
}
