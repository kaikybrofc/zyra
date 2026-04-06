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

/**
 * Representa o estado de autenticação multicamadas com foco em persistência SQL.
 * Estende a funcionalidade padrão do Baileys para suportar sincronização entre MySQL, Redis e Disco.
 */
type MysqlAuthState = {
  /** Objeto de estado contendo credenciais ativas e o gerenciador de chaves criptográficas. */
  state: AuthenticationState
  /** * Sincroniza e persiste as credenciais principais em todas as camadas de storage disponíveis.
   * Deve ser vinculada ao evento 'creds.update' do socket.
   */
  saveCreds: () => Promise<void>
}

/** * Mutex simples para evitar condições de corrida na criação do diretório de fallback. 
 * @internal 
 */
let authFolderReady: Promise<void> | null = null

/**
 * Cria recursivamente a pasta de autenticação se ela não existir.
 * @internal
 */
const ensureAuthFolder = async (folder: string) => {
  if (!authFolderReady) {
    authFolderReady = mkdir(folder, { recursive: true }).then(() => undefined)
  }
  await authFolderReady
}

/**
 * Normaliza nomes de arquivos removendo caracteres reservados do sistema de arquivos.
 * @internal
 */
const fixFileName = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-')

/**
 * Transforma objetos em JSON preservando tipos binários (Buffers/Uint8Arrays).
 * @internal
 */
const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)

/**
 * Reconstitui objetos a partir de strings JSON, restaurando tipos binários.
 * @internal
 */
const deserialize = <T>(value: unknown) => {
  if (value === null || value === undefined) return null as T
  if (typeof value === 'string') {
    return JSON.parse(value, BufferJSON.reviver) as T
  }
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T
}

/**
 * Lê e desserializa dados do armazenamento em disco local.
 * @internal
 */
const readData = async <T>(folder: string, file: string): Promise<T | null> => {
  try {
    const filePath = join(folder, fixFileName(file))
    const data = await readFile(filePath, { encoding: 'utf-8' })
    return deserialize<T>(data)
  } catch {
    return null
  }
}

/**
 * Serializa e escreve dados no armazenamento em disco local.
 * @internal
 */
const writeData = async (folder: string, file: string, data: unknown): Promise<void> => {
  const filePath = join(folder, fixFileName(file))
  await writeFile(filePath, serialize(data))
}

/**
 * Converte chaves brutas para instâncias de classe do ProtoBuf quando necessário.
 * @remarks Essencial para chaves de sincronização de dados do WhatsApp Web/Desktop.
 * @internal
 */
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
 * * @param connectionId - Identificador único para isolamento de dados da sessão.
 * @returns Promessa com estado de autenticação compatível com `makeWASocket`.
 */
export async function useMysqlAuthState(connectionId?: string): Promise<MysqlAuthState> {
  const pool = getMysqlPool()
  let mysqlHealthy = Boolean(pool)
  let mysqlFailureLogged = false
  
  if (!pool) {
    console.warn('[auth] mysql indisponivel, usando redis/disco como fallback')
  }

  await ensureAuthFolder(config.authDir)
  const redisClient = config.redisUrl ? await getRedisClient() : null
  const { redisCredsKey, legacyRedisCredsKey, redisKeysKey } = buildRedisKeys(connectionId)

  const resolvedConnectionId = connectionId ?? config.connectionId ?? 'default'

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
    if (!pool || !mysqlHealthy) return fallback
    try {
      await ensureMysqlConnection(pool)
      return await fn(pool)
    } catch (error) {
      mysqlHealthy = false
      if (!mysqlFailureLogged) {
        mysqlFailureLogged = true
        console.warn('[auth] falha crítica ao acessar mysql, fallback ativado', { error })
      }
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
        await Promise.all(
          Array.from(remaining).map(async (id) => {
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
        )
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
          await withMysql(async (client) => {
            await client.execute(
              `INSERT INTO signal_keys (connection_id, key_type, key_id, value_json)
               VALUES ${values} ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = CURRENT_TIMESTAMP`,
              params
            )
          }, undefined)
          
          if (redisPipeline) {
            const payload: Record<string, string> = {}
            for (const entry of toSet) payload[entry.id] = entry.value
            redisPipeline.hSet(redisKeysKey(category), payload)
          }
        }

        if (toDelete.length) {
          const placeholders = toDelete.map(() => '?').join(', ')
          await withMysql(async (client) => {
            await client.execute(
              `DELETE FROM signal_keys WHERE connection_id = ? AND key_type = ? AND key_id IN (${placeholders})`,
              [resolvedConnectionId, category, ...toDelete]
            )
          }, undefined)
          if (redisPipeline) redisPipeline.hDel(redisKeysKey(category), toDelete)
        }
      }
      if (redisPipeline) await redisPipeline.exec()
    },
  }

  const saveCreds = async () => {
    await storeCredsInMysql(creds)
    if (redisClient) await redisClient.set(redisCredsKey, serialize(creds))
    await writeData(config.authDir, 'creds.json', creds)
  }

  return { state: { creds, keys }, saveCreds }
}
