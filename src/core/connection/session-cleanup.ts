import { mkdir, rm } from 'node:fs/promises'
import { config } from '../../config/index.js'
import type { AppLogger } from '../../observability/logger.js'
import { resolveAuthDir } from '../auth/auth-dir.js'
import { getMysqlPool } from '../db/mysql.js'
import { getRedisClient } from '../redis/client.js'
import { getLegacyRedisNamespace, getRedisNamespace } from '../redis/prefix.js'
import { resolveAntiBanStateDir } from './antiban.js'

const DEFAULT_TIMEOUT_MS = Math.max(1_000, Number(process.env.WA_DELETE_SESSION_TIMEOUT_MS ?? 15_000))
const REDIS_SCAN_MAX_MS = Math.max(5_000, Number(process.env.WA_DELETE_SESSION_REDIS_MAX_MS ?? 60_000))

type SessionCleanupResult = {
  mysql: boolean
  redis: boolean
  authDir: boolean
  antibanState: boolean
  errors: string[]
}

const withTimeout = async <T>(label: string, promise: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> => {
  let timeoutId: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`timeout (${timeoutMs}ms) em ${label}`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

const scanAndDelete = async (client: Awaited<ReturnType<typeof getRedisClient>>, pattern: string, logger: AppLogger): Promise<number> => {
  let cursor = 0
  let deleted = 0
  const startedAt = Date.now()
  do {
    if (Date.now() - startedAt > REDIS_SCAN_MAX_MS) {
      logger.warn('scan do redis excedeu tempo limite durante hard delete', {
        pattern,
        deleted,
        maxMs: REDIS_SCAN_MAX_MS,
      })
      break
    }
    const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 500 })
    cursor = Number(reply.cursor)
    if (!reply.keys.length) continue
    deleted += reply.keys.length
    if (typeof client.unlink === 'function') {
      await client.unlink(reply.keys)
    } else {
      await client.del(reply.keys)
    }
  } while (cursor !== 0)
  return deleted
}

const normalizeRedisPrefixes = (connectionId: string): string[] => {
  const values = [getRedisNamespace(connectionId), getLegacyRedisNamespace(connectionId)]
  const unique = new Set<string>()
  for (const value of values) {
    if (!value) continue
    unique.add(value)
  }
  return Array.from(unique)
}

/**
 * Remove artefatos de autenticação de uma conexão (MySQL, Redis e diretório local).
 *
 * Esta rotina é usada pelo hard delete administrativo para invalidar sessão de forma completa.
 */
export const hardDeleteSessionArtifacts = async (connectionId: string, logger: AppLogger): Promise<SessionCleanupResult> => {
  const result: SessionCleanupResult = {
    mysql: false,
    redis: false,
    authDir: false,
    antibanState: false,
    errors: [],
  }

  const pool = getMysqlPool()
  if (!pool) {
    result.mysql = true
  } else {
    try {
      await withTimeout('mysql.auth_creds', pool.execute(`DELETE FROM auth_creds WHERE connection_id = ?`, [connectionId]))
      await withTimeout('mysql.signal_keys', pool.execute(`DELETE FROM signal_keys WHERE connection_id = ?`, [connectionId]))
      result.mysql = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.errors.push(`mysql: ${message}`)
      logger.warn('hard delete: falha ao remover credenciais no mysql', { connectionId, err: error })
    }
  }

  if (!config.redisUrl) {
    result.redis = true
  } else {
    try {
      const client = await withTimeout('redis.connect', getRedisClient())
      const prefixes = normalizeRedisPrefixes(connectionId)
      for (const prefix of prefixes) {
        await withTimeout('redis.del_creds', client.del(`${prefix}:creds`))
        const deleted = await withTimeout('redis.scan_keys', scanAndDelete(client, `${prefix}:keys:*`, logger), REDIS_SCAN_MAX_MS + 5_000)
        logger.info('hard delete: chaves de sessão removidas do redis', {
          connectionId,
          prefix,
          deleted,
        })
      }
      result.redis = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.errors.push(`redis: ${message}`)
      logger.warn('hard delete: falha ao remover credenciais no redis', { connectionId, err: error })
    }
  }

  if (!config.authDir) {
    result.authDir = true
  } else {
    try {
      const authDir = resolveAuthDir(connectionId)
      await withTimeout('auth.rm', rm(authDir, { recursive: true, force: true }))
      await withTimeout('auth.mkdir', mkdir(authDir, { recursive: true }))
      result.authDir = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.errors.push(`auth_dir: ${message}`)
      logger.warn('hard delete: falha ao limpar diretório local de auth', { connectionId, err: error })
    }
  }

  if (!config.antibanStateDir) {
    result.antibanState = true
  } else {
    try {
      const antibanStateDir = resolveAntiBanStateDir(connectionId)
      await withTimeout('antiban.rm', rm(antibanStateDir, { recursive: true, force: true }))
      result.antibanState = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.errors.push(`antiban_state: ${message}`)
      logger.warn('hard delete: falha ao limpar diretório do estado antiban', { connectionId, err: error })
    }
  }

  return result
}
