import { config } from '../../config/index.js'

export const getRedisNamespace = (): string => {
  const base = config.redisPrefix ?? 'zyra:conexao'
  const connectionId = config.connectionId
  if (connectionId && !base.endsWith(`:${connectionId}`)) {
    return `${base}:${connectionId}`
  }
  return base
}

export const getLegacyRedisNamespace = (): string | null => {
  const base = config.redisPrefix ?? 'zyra:conexao'
  const namespaced = getRedisNamespace()
  return base === namespaced ? null : base
}
