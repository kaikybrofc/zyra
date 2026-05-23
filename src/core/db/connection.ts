import type { Pool } from 'mysql2/promise'
import { config } from '../../config/index.js'

const ensuringByConnection = new Map<string, Promise<void>>()
const ensuredConnectionIds = new Set<string>()

/**
 * Garante o registro da conexao na tabela `connections` do MySQL.
 */
export async function ensureMysqlConnection(pool: Pool, connectionId = config.connectionId ?? 'default'): Promise<void> {
  if (ensuredConnectionIds.has(connectionId)) return
  let ensuring = ensuringByConnection.get(connectionId)
  if (!ensuring) {
    ensuring = pool
      .execute(
        `INSERT INTO connections (id, label)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE label = VALUES(label)`,
        [connectionId, connectionId]
      )
      .then(() => {
        ensuredConnectionIds.add(connectionId)
      })
      .catch(() => undefined)
      .finally(() => {
        ensuringByConnection.delete(connectionId)
      })
    ensuringByConnection.set(connectionId, ensuring)
  }
  await ensuring
}
