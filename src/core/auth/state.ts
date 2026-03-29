import { useMultiFileAuthState } from '@whiskeysockets/baileys'
import { config } from '../../config/index.js'

export async function getAuthState() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
  return { state, saveCreds }
}
