import { loadEnv } from '../../bootstrap/env.js'
import { config } from '../../config/index.js'
import { createLogger } from '../../observability/logger.js'
import { ensureMysqlConnection } from './connection.js'
import { getMysqlPool } from './mysql.js'

loadEnv()
const logger = createLogger()

type TableRow = { table_name: string }

type ColumnRow = {
  column_name: string
  is_nullable: 'YES' | 'NO'
}

const escapeId = (value: string) => value.replace(/`/g, '``')

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
  logger.info('verificando colunas com NULL', { connectionId })

  const [tableRows] = await pool.execute<TableRow[]>(
    `SELECT table_name AS table_name
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
     ORDER BY table_name`
  )

  const findings: Array<{ table: string; column: string; count: number; total: number; percent: number }> = []

  for (const row of tableRows) {
    const table = row.table_name
    if (!table) continue

    const [columns] = await pool.execute<ColumnRow[]>(
      `SELECT column_name AS column_name, is_nullable AS is_nullable
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = ?
       ORDER BY ordinal_position`,
      [table]
    )

    const hasConnectionId = columns.some((col) => col.column_name === 'connection_id')
    const nullables = columns.filter((col) => col.is_nullable === 'YES')
    if (!nullables.length) continue

    const tableEscaped = escapeId(table)
    const totalQuery = hasConnectionId
      ? `SELECT COUNT(*) AS total FROM \`${tableEscaped}\` WHERE connection_id = ?`
      : `SELECT COUNT(*) AS total FROM \`${tableEscaped}\``
    const [totalRows] = await pool.execute<[{ total: number }]>(
      totalQuery,
      hasConnectionId ? [connectionId] : []
    )
    const total = totalRows[0]?.total ?? 0
    if (!total) continue

    for (const column of nullables) {
      const columnEscaped = escapeId(column.column_name)
      const nullQuery = hasConnectionId
        ? `SELECT COUNT(*) AS count FROM \`${tableEscaped}\` WHERE connection_id = ? AND \`${columnEscaped}\` IS NULL`
        : `SELECT COUNT(*) AS count FROM \`${tableEscaped}\` WHERE \`${columnEscaped}\` IS NULL`
      const [nullRows] = await pool.execute<[{ count: number }]>(
        nullQuery,
        hasConnectionId ? [connectionId] : []
      )
      const count = nullRows[0]?.count ?? 0
      if (!count) continue
      const percent = total ? Number(((count / total) * 100).toFixed(2)) : 0
      findings.push({
        table,
        column: column.column_name,
        count,
        total,
        percent,
      })
    }
  }

  await pool.end()
  const sorted = findings.sort((a, b) => b.percent - a.percent)
  if (!sorted.length) {
    logger.info('verificacao de NULL concluida (nenhum NULL encontrado)')
    return
  }
  logger.info('verificacao de NULL concluida', { total: sorted.length })
  for (const item of sorted) {
    console.log(
      `${item.table}.${item.column} -> ${item.count}/${item.total} (${item.percent}%)`
    )
  }
}

main().catch((error) => {
  logger.error('falha ao verificar NULLs', { err: error })
  process.exitCode = 1
})
