import mysql, { type Pool } from 'mysql2/promise'
import { config } from '../../config/index.js'

let pool: Pool | null = null

const readPoolNumber = (key: string, fallback: number, min: number): number => {
  const value = Number(process.env[key])
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.trunc(value))
}

/**
 * Retorna o pool MySQL singleton (ou null se nao houver MYSQL_URL).
 */
export function getMysqlPool(): Pool | null {
  if (!config.mysqlUrl) return null
  if (!pool) {
    pool = mysql.createPool({
      uri: config.mysqlUrl,
      waitForConnections: true,
      connectionLimit: readPoolNumber('WA_MYSQL_CONNECTION_LIMIT', 30, 1),
      maxIdle: readPoolNumber('WA_MYSQL_MAX_IDLE', 10, 0),
      idleTimeout: readPoolNumber('WA_MYSQL_IDLE_TIMEOUT_MS', 60_000, 1_000),
      queueLimit: readPoolNumber('WA_MYSQL_QUEUE_LIMIT', 0, 0),
    })
  }
  return pool
}
