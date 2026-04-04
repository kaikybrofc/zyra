import { useMultiFileAuthState } from '@whiskeysockets/baileys'
import { config } from '../../config/index.js'
import { useMysqlAuthState } from './mysql-auth-state.js'
import { useRedisAuthState } from './redis-auth-state.js'

/**
 * Seleciona a estrategia de autenticacao (MySQL, Redis ou arquivos locais).
 */
export async function getAuthState() {
  if (config.mysqlUrl) {
    return useMysqlAuthState()
  }
  if (config.redisUrl) {
    return useRedisAuthState()
  }

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
  return { state, saveCreds }
}
