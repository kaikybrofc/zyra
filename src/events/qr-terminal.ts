import qrcode from 'qrcode-terminal'
import type { AppLogger } from '../observability/logger.js'

export function renderQrInTerminal(logger: AppLogger, qr: string, connectionId?: string): void {
  logger.info('QR code recebido, escaneie com seu WhatsApp', {
    connectionId: connectionId ?? null,
  })
  qrcode.generate(qr, { small: true })
}
