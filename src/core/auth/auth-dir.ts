import path from 'node:path'
import { config } from '../../config/index.js'

/**
 * Resolve o diretório de auth isolando por connectionId.
 * Importante quando um único processo mantém múltiplas conexões.
 */
export const resolveAuthDir = (connectionId?: string): string => {
  const resolvedConnectionId = connectionId ?? config.connectionId ?? 'default'
  return path.resolve(process.cwd(), config.authDir, resolvedConnectionId)
}

