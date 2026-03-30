import mysql, { type Pool } from 'mysql2/promise'
import { config } from '../../config/index.js'

let pool: Pool | null = null

export function getMysqlPool(): Pool | null {
  if (!config.mysqlUrl) return null
  if (!pool) {
    pool = mysql.createPool(config.mysqlUrl)
  }
  return pool
}
