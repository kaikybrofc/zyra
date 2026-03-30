import type { Pool } from 'mysql2/promise'
import { config } from '../../config/index.js'

let ensuring: Promise<void> | null = null
let ensured = false

export async function ensureMysqlConnection(pool: Pool): Promise<void> {
  if (ensured) return
  if (!ensuring) {
    const connectionId = config.connectionId ?? 'default'
    ensuring = pool
      .execute(
        `INSERT INTO connections (id, label)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE label = VALUES(label)`,
        [connectionId, connectionId]
      )
      .then(() => {
        ensured = true
      })
      .catch(() => undefined)
      .finally(() => {
        ensuring = null
      })
  }
  await ensuring
}
