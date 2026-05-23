import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RowDataPacket } from 'mysql2/promise'
import { DisconnectReason } from 'baileys'
import { Boom } from '@hapi/boom'
import { loadEnv } from '../../bootstrap/env.js'
import { config } from '../../config/index.js'
import { initMysqlSchema } from '../db/init.js'
import { getMysqlPool } from '../db/mysql.js'
import { closeRedisClient } from '../redis/client.js'
import { createSocket, flushSocketCredsNow, type SocketWithCredsFlush, unregisterShutdownTarget } from './socket.js'
import { createLogger } from '../../observability/logger.js'
import { renderQrInTerminal } from '../../events/qr-terminal.js'

const PAIR_TIMEOUT_MS = Math.max(60_000, Number(process.env.WA_PAIR_TIMEOUT_MS ?? 10 * 60_000))
const PAIR_VALIDATE_TIMEOUT_MS = Math.max(30_000, Number(process.env.WA_PAIR_VALIDATE_TIMEOUT_MS ?? 120_000))
const PAIR_USAGE = 'uso: npm run session:pair -- --connection <id>'
const PM2_APP_NAME = process.env.WA_PM2_APP_NAME?.trim() || 'zyra'
const execFileAsync = promisify(execFile)

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function parseConnectionId(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index++) {
    const current = argv[index]
    if (current === '--connection') {
      return argv[index + 1]?.trim() || null
    }
    if (current?.startsWith('--connection=')) {
      return current.slice('--connection='.length).trim() || null
    }
  }
  return null
}

function extractDisconnectStatusCode(update: {
  lastDisconnect?: { error?: unknown }
}): number | null {
  const error = update.lastDisconnect?.error as
    | (Boom & { output?: { statusCode?: number } })
    | (Error & { output?: { statusCode?: number } })
    | undefined

  const explicitStatus = error?.output?.statusCode
  if (typeof explicitStatus === 'number') return explicitStatus

  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/\b515\b/.test(message)) return DisconnectReason.restartRequired
  if (/\b401\b/.test(message)) return DisconnectReason.loggedOut

  return null
}

function normalizeConnectionIds(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

async function loadConnectionIdsFromMysql(): Promise<string[]> {
  const pool = getMysqlPool()
  if (!pool) return []
  type ConnectionRow = RowDataPacket & { connection_id: string }
  const [rows] = await pool.execute<ConnectionRow[]>(
    `SELECT connection_id FROM auth_creds ORDER BY updated_at ASC, connection_id ASC`
  )
  return normalizeConnectionIds(rows.map((row) => row.connection_id))
}

async function restartPm2WithConnectionList(connectionId: string, logger: ReturnType<typeof createLogger>): Promise<void> {
  let stdout = ''
  try {
    const result = await execFileAsync('pm2', ['jlist'], { timeout: 10_000 })
    stdout = result.stdout
  } catch (error) {
    logger.info('pairing: pm2 indisponivel, reinicio automatico ignorado', {
      connectionId,
      appName: PM2_APP_NAME,
      err: error,
    })
    return
  }

  type Pm2Entry = {
    name?: string
    pm2_env?: {
      status?: string
      WA_CONNECTION_IDS?: string
      env?: {
        WA_CONNECTION_IDS?: string
      }
    }
  }

  let entries: Pm2Entry[] = []
  try {
    entries = JSON.parse(stdout) as Pm2Entry[]
  } catch (error) {
    logger.warn('pairing: falha ao ler lista de processos do pm2', {
      connectionId,
      appName: PM2_APP_NAME,
      err: error,
    })
    return
  }

  const app = entries.find((entry) => entry.name === PM2_APP_NAME)
  const appStatus = app?.pm2_env?.status ?? 'unknown'
  if (!app || appStatus !== 'online') {
    logger.info('pairing: app do pm2 nao esta online, reinicio automatico ignorado', {
      connectionId,
      appName: PM2_APP_NAME,
      appStatus,
    })
    return
  }

  const currentCsv = app.pm2_env?.env?.WA_CONNECTION_IDS ?? app.pm2_env?.WA_CONNECTION_IDS ?? ''
  const fromPm2 = currentCsv ? currentCsv.split(',') : []
  const fromMysql = fromPm2.length ? [] : await loadConnectionIdsFromMysql()
  const merged = normalizeConnectionIds([...fromPm2, ...fromMysql, connectionId])
  const updatedCsv = merged.join(',')

  await execFileAsync('pm2', ['restart', PM2_APP_NAME, '--update-env'], {
    timeout: 30_000,
    env: {
      ...process.env,
      WA_CONNECTION_IDS: updatedCsv,
    },
  })

  logger.info('pairing: pm2 reiniciado com lista atualizada de conexoes', {
    connectionId,
    appName: PM2_APP_NAME,
    total: merged.length,
    connectionIds: merged,
  })
}

async function closeResources(): Promise<void> {
  await closeRedisClient().catch(() => undefined)
  const pool = getMysqlPool()
  if (pool) {
    await pool.end().catch(() => undefined)
  }
}

async function validateSessionBoot(connectionId: string, logger: ReturnType<typeof createLogger>): Promise<void> {
  logger.info('pairing: iniciando validacao pos-pareamento (reconexao controlada)', { connectionId })
  const validationSock = (await createSocket(connectionId, logger)) as SocketWithCredsFlush

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`timeout na validacao de inicializacao da conexao ${connectionId}`))
    }, PAIR_VALIDATE_TIMEOUT_MS)

    const cleanup = () => {
      clearTimeout(timeoutId)
      validationSock.ev.removeAllListeners('connection.update')
    }

    validationSock.ev.on('connection.update', (update) => {
      if (settled) return

      if (update.qr) {
        settled = true
        cleanup()
        reject(new Error(`validacao falhou: QR reapareceu para a conexao ${connectionId} (sessao nao estabilizou)`))
        return
      }

      if (update.connection === 'open') {
        settled = true
        cleanup()
        logger.info('pairing: validacao concluida, conexao abriu sem QR', { connectionId })
        resolve()
        return
      }

      if (update.connection === 'close') {
        const statusCode = extractDisconnectStatusCode(update)
        settled = true
        cleanup()
        reject(
          new Error(
            `validacao falhou: conexao ${connectionId} encerrou antes de abrir${statusCode ? ` (status ${statusCode})` : ''}`
          )
        )
      }
    })
  }).finally(async () => {
    await shutdownPairSocket(connectionId, validationSock, 'pairing_validation_finalize')
  })
}

async function shutdownPairSocket(connectionId: string, sock: SocketWithCredsFlush, reason: string): Promise<void> {
  await flushSocketCredsNow(sock, reason).catch(() => undefined)
  try {
    ;(sock.ev as { removeAllListeners?: (...args: unknown[]) => unknown }).removeAllListeners?.()
  } catch {
    // noop: best effort teardown
  }
  await sock.end(undefined).catch(() => undefined)
  unregisterShutdownTarget(connectionId, sock)
}

async function main(): Promise<void> {
  loadEnv()
  const logger = createLogger()
  const connectionId = parseConnectionId(process.argv.slice(2))

  if (!connectionId) {
    throw new Error(`informe a conexão com --connection <id>\n${PAIR_USAGE}`)
  }

  if (!config.mysqlUrl) {
    throw new Error('MYSQL_URL é obrigatório para pairing via terminal com descoberta posterior')
  }

  await initMysqlSchema(logger)

  const sock = (await createSocket(connectionId, logger)) as SocketWithCredsFlush

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let pairingConfigured = false
    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`timeout aguardando pairing da conexão ${connectionId}`))
    }, PAIR_TIMEOUT_MS)

    const cleanup = () => {
      clearTimeout(timeoutId)
      sock.ev.removeAllListeners('connection.update')
    }

    sock.ev.on('connection.update', async (update) => {
      if (settled) return

      if (update.qr) {
        renderQrInTerminal(logger, update.qr, connectionId)
      }

      if (update.isNewLogin) {
        pairingConfigured = true
        logger.info('novo login detectado, aguardando estabilizacao da conexao', { connectionId })
      }

      if (update.connection === 'open') {
        settled = true
        cleanup()
        try {
          await flushSocketCredsNow(sock, 'pairing_complete')
          logger.info('pairing concluído com sucesso', { connectionId })
          resolve()
        } catch (error) {
          reject(error)
        }
        return
      }

      if (update.connection === 'close') {
        const statusCode = extractDisconnectStatusCode(update)
        logger.warn('pairing: conexao encerrada durante fluxo', {
          connectionId,
          statusCode,
          pairingConfigured,
          expectedAfterNewLogin: pairingConfigured && statusCode === DisconnectReason.restartRequired,
        })
        if (statusCode === DisconnectReason.restartRequired && pairingConfigured) {
          settled = true
          cleanup()
          try {
            await flushSocketCredsNow(sock, 'pairing_restart_required')
            logger.info('pairing: restart esperado apos novo login; credenciais persistidas com sucesso', {
              connectionId,
              statusCode,
              nextAction: 'inicie/reinicie o processo principal para conectar com a sessao salva',
            })
            resolve()
          } catch (error) {
            reject(error)
          }
          return
        }
        if (pairingConfigured && statusCode === null) {
          settled = true
          cleanup()
          try {
            await flushSocketCredsNow(sock, 'pairing_post_login_close')
            logger.info('pairing: encerramento transitorio apos novo login; credenciais persistidas com sucesso', {
              connectionId,
              nextAction: 'inicie/reinicie o processo principal para conectar com a sessao salva',
            })
            resolve()
          } catch (error) {
            reject(error)
          }
          return
        }
        if (statusCode === DisconnectReason.restartRequired) {
          return
        }
        settled = true
        cleanup()
        logger.error('pairing: falha real durante o fechamento da conexao', {
          connectionId,
          statusCode,
          pairingConfigured,
          recommendation:
            statusCode === DisconnectReason.loggedOut
              ? 'sessao invalidada pelo WhatsApp; execute novo pareamento'
              : 'verifique conectividade/rede e tente novamente',
        })
        reject(new Error(`pairing encerrado antes de abrir a conexão ${connectionId}${statusCode ? ` (status ${statusCode})` : ''}`))
      }
    })
  })

  await shutdownPairSocket(connectionId, sock, 'pairing_finalize')
  await validateSessionBoot(connectionId, logger)
  logger.info('pairing: sessao validada com sucesso no WhatsApp e no socket local', {
    connectionId,
  })
  await restartPm2WithConnectionList(connectionId, logger)
  await new Promise<void>((resolve) => setTimeout(resolve, 300))
  await closeResources()
}

main().catch(async (error) => {
  const logger = createLogger()
  logger.error('falha no pairing via terminal', {
    err: error,
    message: formatErrorMessage(error),
    usage: PAIR_USAGE,
  })
  await closeResources()
  process.exitCode = 1
})
