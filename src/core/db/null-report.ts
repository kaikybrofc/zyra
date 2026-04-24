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

const contextualColumns = new Set<string>([
  'events_log.message_db_id',
  'events_log.group_jid',
  'events_log.target_user_id',
  'events_log.chat_jid',
  'blocklist.actor_user_id',
  'blocklist.reason',
  'bot_sessions.platform',
  'bot_sessions.app_version',
  'label_associations.message_db_id',
  'label_associations.target_jid',
  'label_associations.actor_user_id',
  'newsletter_events.actor_user_id',
  'newsletter_events.target_user_id',
  'commands_log.args_text',
  'labels.actor_user_id',
])

const classifyColumn = (table: string, column: string) => {
  if (column === 'deleted_at') return 'ignored'
  const key = `${table}.${column}`
  if (ignoredColumns.has(key)) return 'ignored'
  if (optionalColumns.has(key)) return 'optional'
  if (contextualColumns.has(key)) return 'contextual'
  if (targetColumns.has(key)) return 'target'
  return 'other'
}

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
}

type Category = 'target' | 'optional' | 'contextual' | 'other'
type Severity = 'good' | 'medium' | 'bad'

const colorize = (text: string, color: keyof typeof COLORS) => `${COLORS[color]}${text}${COLORS.reset}`

const evaluateSeverity = (percent: number, category: Category): Severity => {
  if (category === 'target') {
    if (percent < 1) return 'good'
    if (percent < 5) return 'medium'
    return 'bad'
  }
  if (category === 'optional') {
    return percent < 60 ? 'good' : 'medium'
  }
  if (category === 'contextual') {
    return percent < 70 ? 'good' : 'medium'
  }
  if (percent < 5) return 'good'
  if (percent < 20) return 'medium'
  return 'bad'
}

const formatSeverity = (severity: Severity) => {
  if (severity === 'bad') return colorize('RUIM', 'red')
  if (severity === 'medium') return colorize('MEDIO', 'yellow')
  return colorize('BOM', 'green')
}

const formatRow = (item: { table: string; column: string; count: number; total: number; percent: number; category: Category }) => {
  const severity = evaluateSeverity(item.percent, item.category)
  const percentText = `${item.percent.toFixed(2)}%`
  const coloredPercent =
    severity === 'bad' ? colorize(percentText, 'red') : severity === 'medium' ? colorize(percentText, 'yellow') : colorize(percentText, 'green')
  return `${formatSeverity(severity)} ${item.table}.${item.column} -> ${item.count}/${item.total} (${coloredPercent})`
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
    category: 'target' | 'optional' | 'contextual' | 'other' | 'ignored'
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
  const contextual = sorted.filter((item) => item.category === 'contextual')
  const other = sorted.filter((item) => item.category === 'other')

  logger.info('verificacao de NULL concluida', {
    total: sorted.length,
    target: targets.length,
    optional: optional.length,
    contextual: contextual.length,
    other: other.length,
  })

  console.log(`\n${colorize('Legenda:', 'bold')} ${colorize('BOM', 'green')} ${colorize('MEDIO', 'yellow')} ${colorize('RUIM', 'red')}`)
  console.log(`${colorize('Regra ALVO:', 'cyan')} bom < 1%, medio < 5%, ruim >= 5%`)
  console.log(`${colorize('Regra OPCIONAL:', 'cyan')} bom < 60%, medio >= 60%`)
  console.log(`${colorize('Regra CONTEXTUAL:', 'cyan')} bom < 70%, medio >= 70%`)
  console.log(`${colorize('Regra OUTROS:', 'cyan')} bom < 5%, medio < 20%, ruim >= 20%`)

  if (targets.length) {
    console.log(`\n${colorize('[ALVO <1%]', 'bold')}`)
    for (const item of targets) {
      console.log(formatRow(item))
    }
  }

  if (optional.length) {
    console.log(`\n${colorize('[OPCIONAL]', 'bold')}`)
    for (const item of optional) {
      console.log(formatRow(item))
    }
  }

  if (contextual.length) {
    console.log(`\n${colorize('[CONTEXTUAL]', 'bold')}`)
    for (const item of contextual) {
      console.log(formatRow(item))
    }
  }

  if (other.length) {
    console.log(`\n${colorize('[OUTROS]', 'bold')}`)
    for (const item of other) {
      console.log(formatRow(item))
    }
  }
}

main().catch((error) => {
  logger.error('falha ao verificar NULLs', { err: error })
  process.exitCode = 1
})
