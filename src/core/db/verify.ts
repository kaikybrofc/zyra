import { loadEnv } from '../bootstrap/env.js'
import { config } from '../config/index.js'
import { createLogger } from '../observability/logger.js'
import { getMysqlPool } from './mysql.js'
import { ensureMysqlConnection } from './connection.js'

loadEnv()
const logger = createLogger()

const tables = [
  'connections',
  'auth_creds',
  'signal_keys',
  'chats',
  'wa_contacts_cache',
  'groups',
  'group_participants',
  'messages',
  'lid_mappings',
  'message_events',
  'user_aliases',
  'message_media',
  'message_text_index',
  'message_users',
  'chat_users',
  'labels',
  'label_associations',
  'users',
  'user_identifiers',
]

async function main() {
  if (!config.mysqlUrl) {
    logger.error('MYSQL_URL nao configurada')
    process.exitCode = 1
    return
  }

  const pool = getMysqlPool()
  if (!pool) {
    logger.error('Pool MySQL nao iniciado')
    process.exitCode = 1
    return
  }

  await ensureMysqlConnection(pool)

  const connectionId = config.connectionId ?? 'default'
  logger.info('verificando tabelas', { connectionId })

  for (const table of tables) {
    try {
      const [rows] = await pool.execute<[{ count: number }]>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE connection_id = ?`,
        [connectionId]
      )
      const count = rows[0]?.count ?? 0
      logger.info(`tabela ${table}`, { count })
    } catch (error) {
      logger.error(`falha ao consultar tabela ${table}`, { err: error })
    }
  }

  await pool.end()
}

main().catch((error) => {
  logger.error('falha ao verificar tabelas', { err: error })
  process.exitCode = 1
})
