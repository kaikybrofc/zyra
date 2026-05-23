import qrcode from 'qrcode-terminal'
import type { AppLogger } from '../observability/logger.js'

/**
 * Renderiza no terminal o QR code recebido durante autenticação,
 * registrando a conexão associada para facilitar o pareamento manual.
 */
export function renderQrInTerminal(logger: AppLogger, qr: string, connectionId?: string): void {
  logger.info('QR code recebido, escaneie com seu WhatsApp', {
    connectionId: connectionId ?? null,
  })
  qrcode.generate(qr, { small: true })
}
