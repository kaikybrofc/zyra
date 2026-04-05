import {
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys'
import type { RowDataPacket } from 'mysql2/promise'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../../config/index.js'
import { ensureMysqlConnection } from '../db/connection.js'
import { getMysqlPool } from '../db/mysql.js'
import { getRedisClient } from '../redis/client.js'
import { getLegacyRedisNamespace, getRedisNamespace } from '../redis/prefix.js'
import { selectBestCreds } from './creds-utils.js'

type MysqlAuthState = {
  state: AuthenticationState
  saveCreds: () => Promise<void>
}

let authFolderReady: Promise<void> | null = null

const ensureAuthFolder = async (folder: string) => {
  if (!authFolderReady) {
    authFolderReady = mkdir(folder, { recursive: true }).then(() => undefined)
  }
  await authFolderReady
}

const fixFileName = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-')

const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)
const deserialize = <T>(value: unknown) => {
  if (value === null || value === undefined) return null as T
  if (typeof value === 'string') {
    return JSON.parse(value, BufferJSON.reviver) as T
  }
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T
}

const readData = async <T>(folder: string, file: string): Promise<T | null> => {
  try {
    const filePath = join(folder, fixFileName(file))
    const data = await readFile(filePath, { encoding: 'utf-8' })
    return deserialize<T>(data)
  } catch {
    return null
  }
}

const writeData = async (folder: string, file: string, data: unknown): Promise<void> => {
  const filePath = join(folder, fixFileName(file))
  await writeFile(filePath, serialize(data))
}

const normalizeKeyValue = <T extends keyof SignalDataTypeMap>(
  type: T,
  value: SignalDataTypeMap[T] | null
): SignalDataTypeMap[T] | null => {
  if (!value) return null
  if (type === 'app-state-sync-key') {
    const normalized = proto.Message.AppStateSyncKeyData.fromObject(
      value as unknown as proto.Message.IAppStateSyncKeyData
    )
    return normalized as unknown as SignalDataTypeMap[T]
  }
  return value
}

const buildRedisKeys = (connectionId?: string) => {
  const redisKeyPrefix = getRedisNamespace(connectionId)
  const legacyRedisKeyPrefix = getLegacyRedisNamespace(connectionId)
  return {
    redisCredsKey: `${redisKeyPrefix}:creds`,
    legacyRedisCredsKey: legacyRedisKeyPrefix ? `${legacyRedisKeyPrefix}:creds` : null,
    redisKeysKey: (type: string) => `${redisKeyPrefix}:keys:${type}`,
    legacyRedisKeysKey: (type: string) =>
      legacyRedisKeyPrefix ? `${legacyRedisKeyPrefix}:keys:${type}` : null,
  }
}

/**
 * Cria estado de autenticacao persistido no MySQL.
 */
export async function useMysqlAuthState(connectionId?: string): Promise<MysqlAuthState> {
  const pool = getMysqlPool()
  if (!pool) {
    throw new Error('MYSQL_URL nao configurada')
  }

  await ensureAuthFolder(config.authDir)
  const redisClient = config.redisUrl ? await getRedisClient() : null
  const { redisCredsKey, legacyRedisCredsKey, redisKeysKey, legacyRedisKeysKey } =
    buildRedisKeys(connectionId)

  const resolvedConnectionId = connectionId ?? config.connectionId ?? 'default'

  const fetchCredsFromMysql = async (): Promise<AuthenticationCreds | null> => {
    type CredsRow = RowDataPacket & { creds_json: unknown }
    const [rows] = await pool.execute<CredsRow[]>(
      `SELECT creds_json
       FROM auth_creds
       WHERE connection_id = ?
       LIMIT 1`,
      [resolvedConnectionId]
    )
    const row = rows[0]
    return row ? deserialize<AuthenticationCreds>(row.creds_json) : null
  }

  const storeCredsInMysql = async (creds: AuthenticationCreds) => {
    await ensureMysqlConnection(pool)
    await pool.execute(
      `INSERT INTO auth_creds (connection_id, creds_json)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE
         creds_json = VALUES(creds_json),
         updated_at = CURRENT_TIMESTAMP`,
      [resolvedConnectionId, serialize(creds)]
    )
  }

  const credsFromMysql = await fetchCredsFromMysql()
  const credsFromRedisRaw = redisClient ? await redisClient.get(redisCredsKey) : null
  const credsFromLegacyRaw =
    redisClient && legacyRedisCredsKey ? await redisClient.get(legacyRedisCredsKey) : null
  const credsFromRedis = credsFromRedisRaw
    ? deserialize<AuthenticationCreds>(credsFromRedisRaw)
    : credsFromLegacyRaw
      ? deserialize<AuthenticationCreds>(credsFromLegacyRaw)
      : null
  const credsFromDisk = await readData<AuthenticationCreds>(config.authDir, 'creds.json')
  const selection = selectBestCreds(
    [
      { source: 'mysql', creds: credsFromMysql },
      { source: 'redis', creds: credsFromRedis },
      { source: 'disk', creds: credsFromDisk },
    ],
    ['mysql', 'redis', 'disk']
  )
  const creds = selection.creds

  if (selection.meta.missingCritical.length) {
    console.warn('[auth] credenciais incompletas', {
      source: selection.meta.source,
      missing: selection.meta.missingCritical,
    })
  }

  const serializedCurrent = serialize(creds)
  const serializedMysql = credsFromMysql ? serialize(credsFromMysql) : null
  if (!serializedMysql || serializedMysql !== serializedCurrent) {
    await storeCredsInMysql(creds)
  }
  if (redisClient && credsFromRedisRaw !== serializedCurrent) {
    await redisClient.set(redisCredsKey, serializedCurrent)
  }
  const serializedDisk = credsFromDisk ? serialize(credsFromDisk) : null
  if (!serializedDisk || serializedDisk !== serializedCurrent) {
    await writeData(config.authDir, 'creds.json', creds)
  }

  const keys: SignalKeyStore = {
    get: async (type, ids) => {
      const data: { [id: string]: SignalDataTypeMap[typeof type] } = {}
      if (!ids.length) return data

      const remaining = new Set(ids)
      const toWarm: Record<string, string> = {}

      if (redisClient) {
        const redisKey = redisKeysKey(type)
        const values = await redisClient.hmGet(redisKey, ids)
        values.forEach((raw, index) => {
          const id = ids[index]
          if (!id || !raw) return
          remaining.delete(id)
          const value = deserialize<SignalDataTypeMap[typeof type]>(raw)
          const normalized = normalizeKeyValue(type, value)
          if (normalized) {
            data[id] = normalized
          }
        })

        if (remaining.size && legacyRedisKeysKey(type)) {
          const legacyKey = legacyRedisKeysKey(type)
          if (legacyKey) {
            const legacyIds = Array.from(remaining)
            const legacyValues = await redisClient.hmGet(legacyKey, legacyIds)
            legacyValues.forEach((raw, index) => {
              const id = legacyIds[index]
              if (!id || !raw) return
              const value = deserialize<SignalDataTypeMap[typeof type]>(raw)
              const normalized = normalizeKeyValue(type, value)
              if (normalized) {
                data[id] = normalized
                toWarm[id] = raw
                remaining.delete(id)
              }
            })
          }
        }
      }

      if (remaining.size) {
        const idsToFetch = Array.from(remaining)
        const placeholders = idsToFetch.map(() => '?').join(', ')
        type KeyRow = RowDataPacket & { key_id: string; value_json: unknown }
        const [rows] = await pool.execute<KeyRow[]>(
          `SELECT key_id, value_json
           FROM signal_keys
           WHERE connection_id = ?
             AND key_type = ?
             AND key_id IN (${placeholders})`,
          [resolvedConnectionId, type, ...idsToFetch]
        )

        for (const row of rows) {
          const value = deserialize<SignalDataTypeMap[typeof type]>(row.value_json)
          const normalized = normalizeKeyValue(type, value)
          if (normalized) {
            data[row.key_id] = normalized
            toWarm[row.key_id] = serialize(value)
            remaining.delete(row.key_id)
          }
        }
      }

      if (remaining.size) {
        await Promise.all(
          Array.from(remaining).map(async (id) => {
            const diskValue = await readData<SignalDataTypeMap[typeof type]>(
              config.authDir,
              `${type}-${id}.json`
            )
            if (diskValue) {
              const normalized = normalizeKeyValue(type, diskValue)
              if (normalized) {
                data[id] = normalized
              }
              toWarm[id] = serialize(diskValue)
              await ensureMysqlConnection(pool)
              await pool.execute(
                `INSERT INTO signal_keys (connection_id, key_type, key_id, value_json)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   value_json = VALUES(value_json),
                   updated_at = CURRENT_TIMESTAMP`,
                [resolvedConnectionId, type, id, serialize(diskValue)]
              )
            }
          })
        )
      }

      if (redisClient && Object.keys(toWarm).length) {
        await redisClient.hSet(redisKeysKey(type), toWarm)
      }

      return data
    },
    set: async (dataSet: SignalDataSet) => {
      const redisPipeline = redisClient?.multi() ?? null
      for (const category of Object.keys(dataSet) as Array<keyof SignalDataSet>) {
        const entries = dataSet[category]
        if (!entries) continue
        const toSet: Array<{ id: string; value: string }> = []
        const toDelete: string[] = []

        for (const [id, value] of Object.entries(entries)) {
          if (value) {
            toSet.push({ id, value: serialize(value) })
          } else {
            toDelete.push(id)
          }
        }

        if (toSet.length) {
          const values = toSet.map(() => '(?, ?, ?, ?)').join(', ')
          const params = toSet.flatMap((entry) => [
            resolvedConnectionId,
            category,
            entry.id,
            entry.value,
          ])
          await ensureMysqlConnection(pool)
          await pool.execute(
            `INSERT INTO signal_keys (connection_id, key_type, key_id, value_json)
             VALUES ${values}
             ON DUPLICATE KEY UPDATE
               value_json = VALUES(value_json),
               updated_at = CURRENT_TIMESTAMP`,
            params
          )
          if (redisPipeline) {
            const redisKey = redisKeysKey(category)
            const payload: Record<string, string> = {}
            for (const entry of toSet) {
              payload[entry.id] = entry.value
            }
            redisPipeline.hSet(redisKey, payload)
          }
        }

        if (toDelete.length) {
          const placeholders = toDelete.map(() => '?').join(', ')
          await ensureMysqlConnection(pool)
          await pool.execute(
            `DELETE FROM signal_keys
             WHERE connection_id = ?
               AND key_type = ?
               AND key_id IN (${placeholders})`,
            [resolvedConnectionId, category, ...toDelete]
          )
          if (redisPipeline) {
            redisPipeline.hDel(redisKeysKey(category), toDelete)
          }
        }
      }

      if (redisPipeline) {
        await redisPipeline.exec()
      }
    },
  }

  const saveCreds = async () => {
    await storeCredsInMysql(creds)
    if (redisClient) {
      await redisClient.set(redisCredsKey, serialize(creds))
    }
    await writeData(config.authDir, 'creds.json', creds)
  }

  return { state: { creds, keys }, saveCreds }
}
