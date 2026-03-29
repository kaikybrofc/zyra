import makeWASocket, { Browsers } from '@whiskeysockets/baileys'
import type { AppLogger } from '../../observability/logger.js'
import { createBaileysLogger } from '../../observability/baileys-logger.js'
import { config } from '../../config/index.js'
import { getAuthState } from '../auth/state.js'

export async function createSocket(logger: AppLogger) {
  const { state, saveCreds } = await getAuthState()

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: config.printQRInTerminal,
    browser: Browsers.ubuntu('Baileys Bot'),
    logger: createBaileysLogger(logger),
  })

  sock.ev.on('creds.update', saveCreds)

  return sock
}
