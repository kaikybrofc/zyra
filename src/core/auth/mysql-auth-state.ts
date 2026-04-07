import {
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys'
import type { RowDataPacket } from 'mysql2/promise'
import { config } from '../../config/index.js'
import { ensureMysqlConnection } from '../db/connection.js'
import { getMysqlPool } from '../db/mysql.js'
import { getRedisClient } from '../redis/client.js'
import { getLegacyRedisNamespace, getRedisNamespace } from '../redis/prefix.js'
import { selectBestCreds } from './creds-utils.js'
import {
  deleteData,
  deserialize,
  ensureAuthFolder,
  normalizeKeyValue,
  readData,
  serialize,
  writeData,
} from './storage-utils.js'

/**
 * Representa o estado de autenticação multicamadas com foco em persistência SQL.
 * Estende a funcionalidade padrão do Baileys para suportar sincronização entre MySQL, Redis e Disco.
 * @remarks
 * - L1 Redis (cache rápido) com cache warming automático.
 * - L2 MySQL (persistência primária) com circuit breaker e failover.
 * - L3 Disco (fallback final) com concorrência de I/O limitada.
 * - Escritas em lote com chunking para evitar limites do MySQL.
 * @example
 * const { state, saveCreds } = await useMysqlAuthState('bot-01')
 * socket.ev.on('creds.update', saveCreds)
 */
type MysqlAuthState = {
  /**
   * Estado do Baileys contendo credenciais ativas e o KeyStore multicamadas.
   * As leituras priorizam Redis, depois MySQL e por fim Disco.
   */
  state: AuthenticationState
  /**
   * Sincroniza e persiste as credenciais principais em todas as camadas disponíveis.
   * Deve ser vinculada ao evento 'creds.update' do socket.
   * @remarks
   * Executa as persistências em paralelo e tolera falhas temporárias do MySQL.
   */
  saveCreds: () => Promise<void>
}

let mysqlUnavailableLogged = false

const MYSQL_SIGNAL_KEYS_CHUNK_SIZE = Math.max(
  1,
  Number(process.env.WA_SIGNAL_KEYS_CHUNK ?? 500)
)
const DISK_READ_CONCURRENCY = Math.max(
  1,
  Number(process.env.WA_AUTH_DISK_CONCURRENCY ?? 50)
)

const chunkArray = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

const runWithConcurrency = async <T>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<void>
) => {
  let index = 0
  const workers = new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    while (index < items.length) {
      const current = items[index]
      index += 1
      await handler(current)
    }
  })
  await Promise.all(workers)
}

/**
 * Constrói o mapeamento de chaves para o Redis considerando o isolamento da conexão.
 * @internal
 */
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
 * Inicializa o motor de autenticação persistente com suporte a MySQL, Redis e Disco.
 * * @remarks
 * Esta função implementa uma arquitetura de alta disponibilidade para sessões do Baileys:
 * 1. **Seleção de Credenciais**: Busca em todas as fontes e usa {@link selectBestCreds} para eleger a mais íntegra.
 * 2. **Auto-Cura**: Sincroniza automaticamente fontes atrasadas ou vazias no boot.
 * 3. **Resiliência a Falhas (Failover)**: Utiliza o wrapper `withMysql` para detectar quedas no banco de dados e chavear dinamicamente para Redis/Disco sem interromper o bot.
 * 4. **Caching L1/L2**: O Redis atua como cache de leitura rápida, enquanto MySQL/Disco servem como storage persistente de longo prazo.
 *
 * Configurações úteis:
 * - `WA_SIGNAL_KEYS_CHUNK`: tamanho do lote para INSERT/DELETE em `signal_keys` (default 500).
 * - `WA_AUTH_DISK_CONCURRENCY`: limite de concorrência para leitura/escrita em disco (default 50).
 * - `config.authPersistKeysOnDisk`: habilita persistência das chaves no disco.
 * * @param connectionId - Identificador único para isolamento de dados da sessão.
 * @returns Promessa com estado de autenticação compatível com `makeWASocket`.
 */
export async function useMysqlAuthState(connectionId?: string): Promise<MysqlAuthState> {
  const pool = getMysqlPool()
  let mysqlHealthy = Boolean(pool)
  let mysqlFailureLogged = false
  let mysqlRecoveryLogged = false
  let lastMysqlFailureAt = 0
  const mysqlRetryIntervalMs = Math.max(0, config.mysqlRetryIntervalMs)
  const persistKeysOnDisk = config.authPersistKeysOnDisk
  
  if (!pool && !mysqlUnavailableLogged) {
    mysqlUnavailableLogged = true
    console.warn('[auth] mysql indisponivel, usando redis/disco como fallback')
  }

  await ensureAuthFolder(config.authDir)
  const redisClient = config.redisUrl ? await getRedisClient() : null
  const { redisCredsKey, legacyRedisCredsKey, redisKeysKey } = buildRedisKeys(connectionId)

  const resolvedConnectionId = connectionId ?? config.connectionId ?? 'default'

  const markMysqlUnhealthy = (error: unknown) => {
    mysqlHealthy = false
    lastMysqlFailureAt = Date.now()
    if (!mysqlFailureLogged) {
      mysqlFailureLogged = true
      mysqlRecoveryLogged = false
      console.warn('[auth] falha crítica ao acessar mysql, fallback ativado', { error })
    }
  }

  const markMysqlHealthy = () => {
    if (mysqlHealthy) return
    mysqlHealthy = true
    lastMysqlFailureAt = 0
    if (!mysqlRecoveryLogged) {
      mysqlRecoveryLogged = true
      mysqlFailureLogged = false
      console.info('[auth] mysql recuperado, reativando persistencia')
    }
  }

  /**
   * Executa uma operação no MySQL com tratamento de erro e fallback automático.
   * @param fn - Operação a ser executada no pool do MySQL.
   * @param fallback - Valor retornado caso o MySQL esteja offline.
   * @internal
   */
  type MysqlPool = NonNullable<ReturnType<typeof getMysqlPool>>
  const withMysql = async <T>(
    fn: (client: MysqlPool) => Promise<T>,
    fallback: T
  ): Promise<T> => {
    if (!pool) return fallback
    if (!mysqlHealthy && Date.now() - lastMysqlFailureAt < mysqlRetryIntervalMs) return fallback
    try {
      await ensureMysqlConnection(pool)
      if (!mysqlHealthy) markMysqlHealthy()
      return await fn(pool)
    } catch (error) {
      markMysqlUnhealthy(error)
      return fallback
    }
  }

  const fetchCredsFromMysql = async (): Promise<AuthenticationCreds | null> =>
    withMysql(async (client) => {
      type CredsRow = RowDataPacket & { creds_json: unknown }
      const [rows] = await client.execute<CredsRow[]>(
        `SELECT creds_json FROM auth_creds WHERE connection_id = ? LIMIT 1`,
        [resolvedConnectionId]
      )
      const row = rows[0]
      return row ? deserialize<AuthenticationCreds>(row.creds_json) : null
    }, null)

  const storeCredsInMysql = async (creds: AuthenticationCreds) =>
    withMysql(async (client) => {
      await client.execute(
        `INSERT INTO auth_creds (connection_id, creds_json)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE
           creds_json = VALUES(creds_json),
           updated_at = CURRENT_TIMESTAMP`,
        [resolvedConnectionId, serialize(creds)]
      )
    }, undefined)

  // --- Recuperação das Credenciais ---
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

  // --- Sincronização Proativa (Boot) ---
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

  /**
   * Implementação do KeyStore com inteligência de cache e fallback.
   * Lógica: Redis HMGET -> MySQL SELECT -> Disco READ -> Redis HSET (Warming).
   */
  const keys: SignalKeyStore = {
    get: async (type, ids) => {
      const data: { [id: string]: SignalDataTypeMap[typeof type] } = {}
      if (!ids.length) return data

      const remaining = new Set(ids)
      const toWarm: Record<string, string> = {}

      // L1: Redis
      if (redisClient) {
        const redisKey = redisKeysKey(type)
        const values = await redisClient.hmGet(redisKey, ids)
        values.forEach((raw, index) => {
          const id = ids[index]
          if (!id || !raw) return
          remaining.delete(id)
          const value = deserialize<SignalDataTypeMap[typeof type]>(raw)
          const normalized = normalizeKeyValue(type, value)
          if (normalized) data[id] = normalized
        })
      }

      // L2: MySQL (Com wrapper withMysql)
      if (remaining.size) {
        const idsToFetch = Array.from(remaining)
        const placeholders = idsToFetch.map(() => '?').join(', ')
        type KeyRow = RowDataPacket & { key_id: string; value_json: unknown }
        const rows = await withMysql<KeyRow[] | null>(
          async (client) => {
            const [mysqlRows] = await client.execute<KeyRow[]>(
              `SELECT key_id, value_json FROM signal_keys 
               WHERE connection_id = ? AND key_type = ? AND key_id IN (${placeholders})`,
              [resolvedConnectionId, type, ...idsToFetch]
            )
            return mysqlRows
          },
          null
        )

        if (rows) {
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
      }

      // L3: Disco (Fallback Final)
      if (remaining.size) {
        const remainingIds = Array.from(remaining)
        await runWithConcurrency(remainingIds, DISK_READ_CONCURRENCY, async (id) => {
            const diskValue = await readData<SignalDataTypeMap[typeof type]>(
              config.authDir,
              `${type}-${id}.json`
            )
            if (diskValue) {
              const normalized = normalizeKeyValue(type, diskValue)
              if (normalized) data[id] = normalized
              toWarm[id] = serialize(diskValue)

              await withMysql(
                async (client) => {
                  await client.execute(
                    `INSERT INTO signal_keys (connection_id, key_type, key_id, value_json)
                     VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)`,
                    [resolvedConnectionId, type, id, serialize(diskValue)]
                  )
                },
                undefined
              )
            }
        })
      }

      // Cache Warming: Sincroniza L2/L3 de volta para L1
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
        const toSet: Array<{ id: string; value: string; raw: SignalDataTypeMap[typeof category] }> = []
        const toDelete: string[] = []

        for (const [id, value] of Object.entries(entries)) {
          if (value) {
            toSet.push({ id, value: serialize(value), raw: value })
          } else {
            toDelete.push(id)
          }
        }

        if (toSet.length) {
          const chunks = chunkArray(toSet, MYSQL_SIGNAL_KEYS_CHUNK_SIZE)
          for (const chunk of chunks) {
            const values = chunk.map(() => '(?, ?, ?, ?)').join(', ')
            const params = chunk.flatMap((entry) => [
              resolvedConnectionId,
              category,
              entry.id,
              entry.value,
            ])
            await withMysql(async (client) => {
              await client.execute(
                `INSERT INTO signal_keys (connection_id, key_type, key_id, value_json)
                 VALUES ${values} ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = CURRENT_TIMESTAMP`,
                params
              )
            }, undefined)
          }
          
          if (redisPipeline) {
            const payload: Record<string, string> = {}
            for (const entry of toSet) payload[entry.id] = entry.value
            redisPipeline.hSet(redisKeysKey(category), payload)
          }
        }

        if (toDelete.length) {
          const chunks = chunkArray(toDelete, MYSQL_SIGNAL_KEYS_CHUNK_SIZE)
          for (const chunk of chunks) {
            const placeholders = chunk.map(() => '?').join(', ')
            await withMysql(async (client) => {
              await client.execute(
                `DELETE FROM signal_keys WHERE connection_id = ? AND key_type = ? AND key_id IN (${placeholders})`,
                [resolvedConnectionId, category, ...chunk]
              )
            }, undefined)
          }
          if (redisPipeline) redisPipeline.hDel(redisKeysKey(category), toDelete)
        }

        if (persistKeysOnDisk) {
          const diskOperations: Array<() => Promise<void>> = []
          for (const entry of toSet) {
            diskOperations.push(() =>
              writeData(config.authDir, `${category}-${entry.id}.json`, entry.raw)
            )
          }
          for (const id of toDelete) {
            diskOperations.push(() => deleteData(config.authDir, `${category}-${id}.json`))
          }
          if (diskOperations.length) {
            await runWithConcurrency(diskOperations, DISK_READ_CONCURRENCY, async (op) => {
              await op()
            })
          }
        }
      }
      if (redisPipeline) await redisPipeline.exec()
    },
  }

  const saveCreds = async () => {
    const tasks: Array<Promise<unknown>> = [storeCredsInMysql(creds)]
    if (redisClient) tasks.push(redisClient.set(redisCredsKey, serialize(creds)))
    tasks.push(writeData(config.authDir, 'creds.json', creds))
    await Promise.all(tasks)
  }

  return { state: { creds, keys }, saveCreds }
}
