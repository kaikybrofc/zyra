import { config } from '../../config/index.js'

/**
 * Monta o namespace Redis baseado no prefixo e connection_id.
 */
export const getRedisNamespace = (): string => {
  const base = config.redisPrefix ?? 'zyra:conexao'
  const connectionId = config.connectionId
  if (connectionId && !base.endsWith(`:${connectionId}`)) {
    return `${base}:${connectionId}`
  }
  return base
}

/**
 * Retorna o namespace legado (sem connection_id) quando aplicavel.
 */
export const getLegacyRedisNamespace = (): string | null => {
  const base = config.redisPrefix ?? 'zyra:conexao'
  const namespaced = getRedisNamespace()
  return base === namespaced ? null : base
}
