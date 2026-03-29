import { DisconnectReason, type WASocket } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import type { AppLogger } from '../observability/logger.js'
import { config } from '../config/index.js'
import { handleMessagesUpsert } from '../router/index.js'

type RegisterOptions = {
  sock: WASocket
  logger: AppLogger
  reconnect: () => Promise<void>
}

export function registerEvents({ sock, logger, reconnect }: RegisterOptions): void {
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr && config.printQRInTerminal) {
      logger.info('qr code received, scan it with your WhatsApp app')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      logger.warn('connection closed', { statusCode })

      if (shouldReconnect) {
        void reconnect()
      }
    } else if (connection === 'open') {
      logger.info('connection opened')
    }
  })

  sock.ev.on('messages.upsert', async (event) => {
    await handleMessagesUpsert(sock, event.messages, logger)
  })
}
