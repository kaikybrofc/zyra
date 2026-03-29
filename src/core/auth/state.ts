import { useMultiFileAuthState } from '@whiskeysockets/baileys'
import { config } from '../../config/index.js'
import { useRedisAuthState } from './redis-auth-state.js'

export async function getAuthState() {
  if (config.redisUrl) {
    return useRedisAuthState()
  }

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
  return { state, saveCreds }
}
