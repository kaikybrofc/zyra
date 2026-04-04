import { useMultiFileAuthState } from '@whiskeysockets/baileys'
import { config } from '../../config/index.js'
import { useMysqlAuthState } from './mysql-auth-state.js'
import { useRedisAuthState } from './redis-auth-state.js'

/**
 * Seleciona a estrategia de autenticacao (MySQL, Redis ou arquivos locais).
 */
export async function getAuthState(connectionId?: string) {
  if (config.mysqlUrl) {
    return useMysqlAuthState(connectionId)
  }
  if (config.redisUrl) {
    return useRedisAuthState(connectionId)
  }

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
  return { state, saveCreds }
}
