import { mkdir, rm } from 'node:fs/promises'
import { loadEnv } from '../../bootstrap/env.js'
import { config } from '../../config/index.js'
import { createLogger } from '../../observability/logger.js'
import { getRedisClient } from '../redis/client.js'
import { getLegacyRedisNamespace, getRedisNamespace } from '../redis/prefix.js'
import { ensureMysqlConnection } from './connection.js'
import { getMysqlPool } from './mysql.js'

loadEnv()
const logger = createLogger()
const DEFAULT_TIMEOUT_MS = Number(process.env.WA_DELETE_SESSION_TIMEOUT_MS ?? 15000)
const REDIS_SCAN_MAX_MS = Number(process.env.WA_DELETE_SESSION_REDIS_MAX_MS ?? 60000)

const withTimeout = async <T>(label: string, promise: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  let timeoutId: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`timeout (${timeoutMs}ms) em ${label}`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

const deleteAuthFiles = async (authDir: string) => {
  try {
    await rm(authDir, { recursive: true, force: true })
    await mkdir(authDir, { recursive: true })
    logger.info('arquivos de sessao removidos', { authDir })
  } catch (error) {
    logger.warn('falha ao remover arquivos de sessao', { authDir, err: error })
  }
}

const scanAndDelete = async (client: Awaited<ReturnType<typeof getRedisClient>>, pattern: string) => {
  let cursor = 0
  let deleted = 0
  const startedAt = Date.now()
  do {
    if (Date.now() - startedAt > REDIS_SCAN_MAX_MS) {
      logger.warn('scan do redis excedeu tempo limite, interrompendo', {
        pattern,
        deleted,
        maxMs: REDIS_SCAN_MAX_MS,
      })
      break
    }
    const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 500 })
    cursor = Number(reply.cursor)
    if (reply.keys.length) {
      deleted += reply.keys.length
      if (typeof client.unlink === 'function') {
        await client.unlink(reply.keys)
      } else {
        await client.del(reply.keys)
      }
    }
  } while (cursor !== 0)
  return deleted
}

async function main() {
  const connectionId = config.connectionId ?? 'default'

  const pool = getMysqlPool()
  if (pool) {
    try {
      logger.info('apagando sessao no MySQL', { connectionId })
      await withTimeout('mysql.ensure', ensureMysqlConnection(pool))
      await withTimeout(
        'mysql.auth_creds',
        pool.execute(`DELETE FROM auth_creds WHERE connection_id = ?`, [connectionId])
      )
      await withTimeout(
        'mysql.signal_keys',
        pool.execute(`DELETE FROM signal_keys WHERE connection_id = ?`, [connectionId])
      )
      logger.info('sessao apagada no MySQL', { connectionId })
    } catch (error) {
      logger.warn('falha ao apagar sessao no MySQL', { err: error })
    } finally {
      await pool.end().catch(() => undefined)
    }
  } else {
    logger.warn('pool MySQL nao iniciado, pulando limpeza de auth no banco')
  }

  if (config.redisUrl) {
    logger.info('apagando sessao no Redis')
    let client: Awaited<ReturnType<typeof getRedisClient>> | null = null
    try {
      client = await withTimeout('redis.connect', getRedisClient())
      const redisPrefix = getRedisNamespace()
      const legacyPrefix = getLegacyRedisNamespace()
      const prefixes = [redisPrefix, legacyPrefix].filter(Boolean) as string[]
      for (const prefix of prefixes) {
        const credsKey = `${prefix}:creds`
        await withTimeout('redis.del', client.del(credsKey))
        const deleted = await withTimeout(
          'redis.scan',
          scanAndDelete(client, `${prefix}:keys:*`),
          REDIS_SCAN_MAX_MS + 5000
        )
        logger.info('sessao apagada no Redis', { prefix, deleted })
      }
    } catch (error) {
      logger.warn('falha ao apagar sessao no Redis', { err: error })
    } finally {
      if (client) {
        await client.quit().catch(() => undefined)
      }
    }
  } else {
    logger.info('REDIS_URL nao configurada, pulando limpeza no Redis')
  }

  if (config.authDir) {
    await deleteAuthFiles(config.authDir)
  }
}

main().catch((error) => {
  logger.error('falha ao deletar sessao', { err: error })
  process.exitCode = 1
})
