import mysql from 'mysql2/promise'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadEnv } from '../../bootstrap/env.js'
import { config } from '../../config/index.js'
import { ensureMysqlConnection } from './connection.js'
import { createLogger } from '../../observability/logger.js'
import type { AppLogger } from '../../observability/logger.js'
import type { RowDataPacket } from 'mysql2/promise'

const extractCreateTableStatements = (schema: string): string[] => {
  const matches = schema.match(/CREATE TABLE[\s\S]*?;(?=\s|$)/gi)
  if (!matches) return []
  return matches.map((statement) => {
    const withIfNotExists = statement.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ')
    const withQuotedTable = withIfNotExists.replace(/^CREATE TABLE IF NOT EXISTS\s+`?([a-zA-Z0-9_]+)`?/i, 'CREATE TABLE IF NOT EXISTS `$1`').replace(/(?<!`)restrict(?!`)/gi, '`restrict`')
    const tableMatch = withQuotedTable.match(/^CREATE TABLE IF NOT EXISTS\s+`([a-zA-Z0-9_]+)`/i)
    const tableName = tableMatch?.[1]
    const withUniqueConstraints = tableName ? withQuotedTable.replace(/CONSTRAINT\s+`?([a-zA-Z0-9_]+)`?/gi, (_match, name: string) => `CONSTRAINT \`${tableName}_${name}\``) : withQuotedTable
    return withUniqueConstraints.trim()
  })
}

const resolveDatabaseName = (urlValue: string): string | null => {
  try {
    const url = new URL(urlValue)
    const name = url.pathname.replace(/^\//, '').trim()
    return name.length ? name : null
  } catch {
    return null
  }
}

const loadSchemaSql = async (): Promise<string> => {
  const schemaUrl = new URL('../../../docs/exemplodbmodel.md', import.meta.url)
  return readFile(schemaUrl, { encoding: 'utf-8' })
}

const buildServerConfig = (urlValue: string) => {
  const url = new URL(urlValue)
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  }
}

const ensureIndex = async (pool: mysql.Pool, options: { table: string; index: string; ddl: string }, logger?: AppLogger) => {
  type IndexRow = RowDataPacket & { count: number }
  const [rows] = await pool.query<IndexRow[]>(
    `SELECT COUNT(*) AS count
     FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND index_name = ?`,
    [options.table, options.index]
  )
  const exists = (rows[0]?.count ?? 0) > 0
  if (exists) return false
  await pool.query(options.ddl)
  logger?.info('indice criado', { table: options.table, index: options.index })
  return true
}

const tableExists = async (pool: mysql.Pool, tableName: string): Promise<boolean> => {
  type TableExistsRow = RowDataPacket & { count: number }
  const [rows] = await pool.query<TableExistsRow[]>(
    `SELECT COUNT(*) AS count
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name = ?`,
    [tableName]
  )
  return (rows[0]?.count ?? 0) > 0
}

/**
 * Cria o schema do MySQL (se necessario) usando o modelo em docs/exemplodbmodel.md.
 */
export async function initMysqlSchema(logger?: AppLogger): Promise<void> {
  if (!config.mysqlUrl) return

  const dbName = resolveDatabaseName(config.mysqlUrl)
  if (!dbName) {
    logger?.warn('MYSQL_URL sem nome de banco, pulando init')
    return
  }

  const serverConfig = buildServerConfig(config.mysqlUrl)
  const admin = await mysql.createConnection(serverConfig)
  try {
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  } finally {
    await admin.end()
  }

  const schemaSql = await loadSchemaSql()
  const statements = extractCreateTableStatements(schemaSql)
  if (!statements.length) {
    logger?.warn('nenhuma tabela encontrada no schema para criar')
    return
  }

  const pool = mysql.createPool(config.mysqlUrl)
  try {
    for (const statement of statements) {
      await pool.query(statement)
    }
    await ensureIndex(
      pool,
      {
        table: 'messages',
        index: 'idx_messages_conn_sender_id',
        ddl: 'CREATE INDEX idx_messages_conn_sender_id ON messages (connection_id, sender_user_id, id)',
      },
      logger
    )
    await pool.query(
      `CREATE TABLE IF NOT EXISTS group_config (
        connection_id VARCHAR(128) NOT NULL,
        group_jid VARCHAR(128) NOT NULL,
        config_json JSON NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (connection_id, group_jid),
        INDEX idx_group_config_updated (connection_id, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
    if (await tableExists(pool, 'group_feature_flags')) {
      await pool.query(
        `INSERT INTO group_config (connection_id, group_jid, config_json)
         SELECT
           connection_id,
           group_jid,
           JSON_OBJECT(
             'antilink', CASE
               WHEN antilink_enabled IS NULL THEN CAST(NULL AS JSON)
               WHEN antilink_enabled = 1 THEN TRUE
               ELSE FALSE
             END,
             'antilinkAllowedDomains', COALESCE(antilink_allowed_domains_json, JSON_ARRAY()),
             'antilinkAllowOwnGroupInvite', CASE
               WHEN antilink_allow_own_group_invite IS NULL THEN CAST(NULL AS JSON)
               WHEN antilink_allow_own_group_invite = 1 THEN TRUE
               ELSE FALSE
             END
           )
         FROM group_feature_flags
         ON DUPLICATE KEY UPDATE config_json = VALUES(config_json)`
      )
    }
    await pool.query(
      `CREATE TABLE IF NOT EXISTS webhooks (
        id VARCHAR(64) NOT NULL,
        connection_id VARCHAR(128) NOT NULL,
        url VARCHAR(2048) NOT NULL,
        events_filter JSON NOT NULL,
        active TINYINT(1) NOT NULL DEFAULT 1,
        secret VARCHAR(256) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_webhooks_connection (connection_id, active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
    await pool.query(
      `CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id VARCHAR(64) NOT NULL,
        webhook_id VARCHAR(64) NOT NULL,
        connection_id VARCHAR(128) NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        payload JSON NOT NULL,
        status ENUM('pending','delivered','failed','dead_letter') NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        last_attempt_at TIMESTAMP NULL,
        next_retry_at TIMESTAMP NULL,
        response_status INT NULL,
        response_body TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        INDEX idx_wd_webhook (webhook_id),
        INDEX idx_wd_connection_status (connection_id, status),
        INDEX idx_wd_next_retry (status, next_retry_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    )
    await ensureMysqlConnection(pool)
    logger?.info('schema mysql verificado/criado', { tables: statements.length, database: dbName })
  } finally {
    await pool.end()
  }
}

const runAsScript = async () => {
  loadEnv()
  const logger = createLogger()
  try {
    await initMysqlSchema(logger)
  } catch (error) {
    logger.error('falha ao inicializar mysql', { err: error })
    process.exitCode = 1
  }
}

const isDirectRun = (() => {
  const argvPath = process.argv[1]
  if (!argvPath) return false
  return fileURLToPath(import.meta.url) === argvPath
})()

if (isDirectRun) {
  void runAsScript()
}
