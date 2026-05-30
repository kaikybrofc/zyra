import mysql, { type RowDataPacket } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadEnv } from '../../bootstrap/env.js'
import { config } from '../../config/index.js'
import { createLogger } from '../../observability/logger.js'

type GroupRow = RowDataPacket & {
  jid: string
  data_json: unknown
}

type IdentifierCountRow = RowDataPacket & {
  jid_count: number
}

const normalizeJid = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || !normalized.includes('@')) return null
  return normalized
}

const parseGroupParticipants = (data: unknown): Array<{ id: string; admin?: 'admin' | 'superadmin' | null }> => {
  if (!data) return []
  let parsed = data as { participants?: unknown }
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data) as { participants?: unknown }
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed.participants)) return []
  return parsed.participants
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const id = normalizeJid((item as { id?: unknown }).id)
      if (!id) return null
      const adminRaw = (item as { admin?: unknown }).admin
      const admin: 'admin' | 'superadmin' | null = adminRaw === 'admin' || adminRaw === 'superadmin' ? adminRaw : null
      return { id, admin }
    })
    .filter((item): item is { id: string; admin: 'admin' | 'superadmin' | null } => Boolean(item))
}

const toRole = (admin: 'admin' | 'superadmin' | null | undefined): 'member' | 'admin' | 'superadmin' => {
  if (admin === 'superadmin') return 'superadmin'
  if (admin === 'admin') return 'admin'
  return 'member'
}

const toUuidSql = (binaryExpr = 'user_id') => `LOWER(CONCAT(HEX(SUBSTR(${binaryExpr},1,4)),'-',HEX(SUBSTR(${binaryExpr},5,2)),'-',HEX(SUBSTR(${binaryExpr},7,2)),'-',HEX(SUBSTR(${binaryExpr},9,2)),'-',HEX(SUBSTR(${binaryExpr},11,6))))`

const ensureConnectionRow = async (conn: mysql.Connection, connectionId: string) => {
  await conn.execute(
    `INSERT INTO connections (id)
     VALUES (?)
     ON DUPLICATE KEY UPDATE id = VALUES(id)`,
    [connectionId]
  )
}

const resolveUserIdForParticipant = async (conn: mysql.Connection, connectionId: string, participantJid: string): Promise<string> => {
  type UserRow = RowDataPacket & { user_id: string }
  const [existingRows] = await conn.execute<UserRow[]>(
    `SELECT ${toUuidSql()} AS user_id
     FROM user_identifiers
     WHERE connection_id = ?
       AND id_type = 'jid'
       AND id_value = ?
     LIMIT 1`,
    [connectionId, participantJid]
  )
  const existingUserId = existingRows[0]?.user_id ?? null
  if (!existingUserId) {
    const newUserId = randomUUID()
    await conn.execute(
      `INSERT INTO users (id, connection_id, display_name)
       VALUES (UNHEX(REPLACE(?, '-', '')), ?, NULL)`,
      [newUserId, connectionId]
    )
    await conn.execute(
      `INSERT INTO user_identifiers (connection_id, user_id, id_type, id_value)
       VALUES (?, UNHEX(REPLACE(?, '-', '')), 'jid', ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
      [connectionId, newUserId, participantJid]
    )
    return newUserId
  }

  const [countRows] = await conn.execute<IdentifierCountRow[]>(
    `SELECT COUNT(*) AS jid_count
     FROM user_identifiers
     WHERE connection_id = ?
       AND user_id = UNHEX(REPLACE(?, '-', ''))
       AND id_type = 'jid'`,
    [connectionId, existingUserId]
  )
  const jidCount = Number(countRows[0]?.jid_count ?? 0)
  if (jidCount <= 1) return existingUserId

  // Se um user_id estiver compartilhando mais de um jid, separa este participante
  // para evitar colisoes na PK de group_participants (connection_id, group_jid, user_id).
  const splitUserId = randomUUID()
  await conn.execute(
    `INSERT INTO users (id, connection_id, display_name)
     VALUES (UNHEX(REPLACE(?, '-', '')), ?, NULL)`,
    [splitUserId, connectionId]
  )
  await conn.execute(
    `UPDATE user_identifiers
     SET user_id = UNHEX(REPLACE(?, '-', ''))
     WHERE connection_id = ?
       AND id_type = 'jid'
       AND id_value = ?`,
    [splitUserId, connectionId, participantJid]
  )
  return splitUserId
}

/**
 * Reconstrói a tabela `group_participants` a partir dos metadados
 * persistidos dos grupos para a conexão atual.
 */
export const repairGroupParticipants = async (): Promise<void> => {
  const logger = createLogger()
  if (!config.mysqlUrl) {
    logger.warn('MYSQL_URL ausente; reparo de group_participants ignorado')
    return
  }
  const connectionId = config.connectionId ?? 'default'
  const conn = await mysql.createConnection(config.mysqlUrl)
  try {
    await ensureConnectionRow(conn, connectionId)
    const [groups] = await conn.execute<GroupRow[]>(
      `SELECT jid, data_json
       FROM \`groups\`
       WHERE connection_id = ?`,
      [connectionId]
    )

    let totalParticipants = 0
    await conn.beginTransaction()
    await conn.execute(
      `DELETE FROM group_participants
       WHERE connection_id = ?`,
      [connectionId]
    )

    for (const group of groups) {
      const groupJid = normalizeJid(group.jid)
      if (!groupJid) continue
      const parsedParticipants = parseGroupParticipants(group.data_json)
      const seen = new Set<string>()
      for (const participant of parsedParticipants) {
        if (seen.has(participant.id)) continue
        seen.add(participant.id)

        const userId = await resolveUserIdForParticipant(conn, connectionId, participant.id)
        const role = toRole(participant.admin)
        const isSuperadmin = role === 'superadmin'
        const isAdmin = role === 'admin' || isSuperadmin

        await conn.execute(
          `INSERT INTO group_participants (
             connection_id,
             group_jid,
             user_id,
             participant_jid,
             role,
             is_admin,
             is_superadmin,
             data_json
           ) VALUES (
             ?, ?, UNHEX(REPLACE(?, '-', '')), ?, ?, ?, ?, ?
           )
           ON DUPLICATE KEY UPDATE
             participant_jid = VALUES(participant_jid),
             role = VALUES(role),
             is_admin = VALUES(is_admin),
             is_superadmin = VALUES(is_superadmin),
             data_json = VALUES(data_json)`,
          [connectionId, groupJid, userId, participant.id, role, isAdmin ? 1 : 0, isSuperadmin ? 1 : 0, JSON.stringify(participant)]
        )
        totalParticipants += 1
      }
    }

    await conn.commit()
    logger.info('reparo de group_participants concluido', {
      connectionId,
      groups: groups.length,
      participants: totalParticipants,
    })
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    await conn.end()
  }
}

const runAsScript = async () => {
  loadEnv()
  const logger = createLogger()
  try {
    await repairGroupParticipants()
  } catch (error) {
    logger.error('falha no reparo de group_participants', { err: error })
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
