import path from 'node:path'
import { config } from '../../config/index.js'
import { assertValidConnectionId } from '../connection/connection-id.js'

/**
 * Resolve o diretório de auth isolando por connectionId.
 * Importante quando um único processo mantém múltiplas conexões.
 */
export const resolveAuthDir = (connectionId?: string): string => {
  const resolvedConnectionId = assertValidConnectionId(connectionId ?? config.connectionId ?? 'default')
  return path.resolve(process.cwd(), config.authDir, resolvedConnectionId)
}
