import { loadEnv } from '../../bootstrap/env.js'
import type { RowDataPacket } from 'mysql2/promise'
import { config } from '../../config/index.js'
import { createLogger } from '../../observability/logger.js'
import { ensureMysqlConnection } from './connection.js'
import { getMysqlPool } from './mysql.js'

loadEnv()
const logger = createLogger()

type TableRow = RowDataPacket & { table_name: string }

type ColumnRow = RowDataPacket & {
  column_name: string
  is_nullable: 'YES' | 'NO'
}

const escapeId = (value: string) => value.replace(/`/g, '``')

const ignoredColumns = new Set<string>(['message_media.local_path', 'message_media.file_name', 'message_media.file_length'])

const optionalColumns = new Set<string>(['messages.content_type', 'messages.text_preview', 'messages.is_forwarded', 'messages.status', 'messages.message_type'])

const targetColumns = new Set<string>(['groups.owner_user_id', 'lid_mappings.user_id', 'wa_contacts_cache.user_id', 'messages.sender_user_id', 'commands_log.actor_user_id', 'group_events.actor_user_id', 'message_events.actor_user_id', 'message_events.target_user_id', 'message_events.message_db_id', 'chats.display_name', 'users.display_name', 'chat_users.role', 'group_participants.role'])

const classifyColumn = (table: string, column: string) => {
  if (column === 'deleted_at') return 'ignored'
  const key = `${table}.${column}`
  if (ignoredColumns.has(key)) return 'ignored'
  if (optionalColumns.has(key)) return 'optional'
  if (table === 'events_log') return 'target'
  if (targetColumns.has(key)) return 'target'
  return 'other'
}

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

  const findings: Array<{
    table: string
    column: string
    count: number
    total: number
    percent: number
    category: 'target' | 'optional' | 'other' | 'ignored'
  }> = []

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
    const totalQuery = hasConnectionId ? `SELECT COUNT(*) AS total FROM \`${tableEscaped}\` WHERE connection_id = ?` : `SELECT COUNT(*) AS total FROM \`${tableEscaped}\``
    type TotalRow = RowDataPacket & { total: number }
    const [totalRows] = await pool.execute<TotalRow[]>(totalQuery, hasConnectionId ? [connectionId] : [])
    const total = totalRows[0]?.total ?? 0
    if (!total) continue

    for (const column of nullables) {
      const columnEscaped = escapeId(column.column_name)
      const nullQuery = hasConnectionId ? `SELECT COUNT(*) AS count FROM \`${tableEscaped}\` WHERE connection_id = ? AND \`${columnEscaped}\` IS NULL` : `SELECT COUNT(*) AS count FROM \`${tableEscaped}\` WHERE \`${columnEscaped}\` IS NULL`
      type CountRow = RowDataPacket & { count: number }
      const [nullRows] = await pool.execute<CountRow[]>(nullQuery, hasConnectionId ? [connectionId] : [])
      const count = nullRows[0]?.count ?? 0
      if (!count) continue
      const percent = total ? Number(((count / total) * 100).toFixed(2)) : 0
      findings.push({
        table,
        column: column.column_name,
        count,
        total,
        percent,
        category: classifyColumn(table, column.column_name),
      })
    }
  }

  await pool.end()
  const filtered = findings.filter((item) => item.category !== 'ignored')
  const sorted = filtered.sort((a, b) => b.percent - a.percent)
  if (!sorted.length) {
    logger.info('verificacao de NULL concluida (nenhum NULL encontrado)')
    return
  }

  const targets = sorted.filter((item) => item.category === 'target')
  const optional = sorted.filter((item) => item.category === 'optional')
  const other = sorted.filter((item) => item.category === 'other')

  logger.info('verificacao de NULL concluida', {
    total: sorted.length,
    target: targets.length,
    optional: optional.length,
    other: other.length,
  })

  if (targets.length) {
    console.log('\n[ALVO <1%]')
    for (const item of targets) {
      console.log(`${item.table}.${item.column} -> ${item.count}/${item.total} (${item.percent}%)`)
    }
  }

  if (optional.length) {
    console.log('\n[OPCIONAL]')
    for (const item of optional) {
      console.log(`${item.table}.${item.column} -> ${item.count}/${item.total} (${item.percent}%)`)
    }
  }

  if (other.length) {
    console.log('\n[OUTROS]')
    for (const item of other) {
      console.log(`${item.table}.${item.column} -> ${item.count}/${item.total} (${item.percent}%)`)
    }
  }
}

main().catch((error) => {
  logger.error('falha ao verificar NULLs', { err: error })
  process.exitCode = 1
})
