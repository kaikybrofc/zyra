import { loadEnv } from '../../bootstrap/env.js'
import { config } from '../../config/index.js'
import { createLogger } from '../../observability/logger.js'
import { getMysqlPool } from './mysql.js'
import { ensureMysqlConnection } from './connection.js'

loadEnv()
const logger = createLogger()

type TableRow = { table_name: string }
type ColumnRow = { count: number }

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

  const [tableRows] = await pool.execute<TableRow[]>(
    `SELECT table_name AS table_name
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
     ORDER BY table_name`
  )

  for (const row of tableRows) {
    const table = row.table_name
    try {
      const [columns] = await pool.execute<ColumnRow[]>(
        `SELECT COUNT(*) AS count
         FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND table_name = ?
           AND column_name = 'connection_id'`,
        [table]
      )
      const hasConnectionId = (columns[0]?.count ?? 0) > 0
      if (hasConnectionId) {
        const [rows] = await pool.execute<[{ count: number }]>(
          `SELECT COUNT(*) AS count FROM \`${table}\` WHERE connection_id = ?`,
          [connectionId]
        )
        const count = rows[0]?.count ?? 0
        logger.info(`tabela ${table}`, { count })
      } else if (table === 'connections') {
        const [rows] = await pool.execute<[{ count: number }]>(
          `SELECT COUNT(*) AS count FROM \`connections\` WHERE id = ?`,
          [connectionId]
        )
        const count = rows[0]?.count ?? 0
        logger.info(`tabela ${table}`, { count })
      } else {
        const [rows] = await pool.execute<[{ count: number }]>(
          `SELECT COUNT(*) AS count FROM \`${table}\``
        )
        const count = rows[0]?.count ?? 0
        logger.info(`tabela ${table}`, { count })
      }
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
