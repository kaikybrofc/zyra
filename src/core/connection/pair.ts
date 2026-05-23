import process from 'node:process'
import { DisconnectReason } from 'baileys'
import { Boom } from '@hapi/boom'
import { loadEnv } from '../../bootstrap/env.js'
import { config } from '../../config/index.js'
import { initMysqlSchema } from '../db/init.js'
import { getMysqlPool } from '../db/mysql.js'
import { closeRedisClient } from '../redis/client.js'
import { createSocket, flushSocketCredsNow, type SocketWithCredsFlush } from './socket.js'
import { createLogger } from '../../observability/logger.js'
import { renderQrInTerminal } from '../../events/qr-terminal.js'

const PAIR_TIMEOUT_MS = Math.max(60_000, Number(process.env.WA_PAIR_TIMEOUT_MS ?? 10 * 60_000))

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

async function closeResources(): Promise<void> {
  await closeRedisClient().catch(() => undefined)
  const pool = getMysqlPool()
  if (pool) {
    await pool.end().catch(() => undefined)
  }
}

async function main(): Promise<void> {
  loadEnv()
  const logger = createLogger()
  const connectionId = parseConnectionId(process.argv.slice(2))

  if (!connectionId) {
    throw new Error('informe a conexão com --connection <id>')
  }

  if (!config.mysqlUrl) {
    throw new Error('MYSQL_URL é obrigatório para pairing via terminal com descoberta posterior')
  }

  await initMysqlSchema(logger)

  const sock = (await createSocket(connectionId, logger)) as SocketWithCredsFlush

  await new Promise<void>((resolve, reject) => {
    let settled = false
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
        const statusCode = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        if (statusCode === DisconnectReason.restartRequired) {
          return
        }
        settled = true
        cleanup()
        reject(new Error(`pairing encerrado antes de abrir a conexão ${connectionId}${statusCode ? ` (status ${statusCode})` : ''}`))
      }
    })
  })

  await sock.end(undefined).catch(() => undefined)
  await closeResources()
}

main().catch(async (error) => {
  const logger = createLogger()
  logger.error('falha no pairing via terminal', { err: error })
  await closeResources()
  process.exitCode = 1
})
