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
 * Interface que estende o estado de autenticação do Baileys com a função de persistência.
 */
type MysqlAuthState = {
  /** Estado de autenticação compatível com o Baileys (creds e keys) */
  state: AuthenticationState
  /** Função assíncrona para persistir as credenciais atuais em todas as camadas de storage */
  saveCreds: () => Promise<void>
}

/** Controle de concorrência para garantir que a pasta de autenticação seja criada apenas uma vez */
let authFolderReady: Promise<void> | null = null

/**
 * Garante a existência do diretório de autenticação de forma assíncrona e segura.
 * @internal
 */
const ensureAuthFolder = async (folder: string) => {
  if (!authFolderReady) {
    authFolderReady = mkdir(folder, { recursive: true }).then(() => undefined)
  }
  await authFolderReady
}

/**
 * Sanitiza nomes de arquivos para evitar conflitos com separadores de diretório.
 * @internal
 */
const fixFileName = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-')

/**
 * Serializa dados usando o replacer específico do Baileys para lidar com Buffers e tipos proto.
 * @internal
 */
const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)

/**
 * Desserializa strings ou objetos para o formato original, convertendo JSON de volta para Buffers/Uint8Arrays.
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
 * Lê dados do sistema de arquivos local.
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
 * Escreve dados no sistema de arquivos local de forma atômica.
 * @internal
 */
const writeData = async (folder: string, file: string, data: unknown): Promise<void> => {
  const filePath = join(folder, fixFileName(file))
  await writeFile(filePath, serialize(data))
}

/**
 * Normaliza valores de chaves específicas para garantir compatibilidade com as classes do ProtoBuf.
 * @remarks Necessário principalmente para chaves de sincronização de estado do app.
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
 * Gera os nomes das chaves do Redis baseadas no ID da conexão e namespaces de legado.
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
 * Inicializa e gerencia o estado de autenticação multitarefa (MySQL, Redis e Disco).
 * * @remarks
 * Este hook é responsável por:
 * 1. Recuperar credenciais de 3 fontes diferentes e escolher a melhor via {@link selectBestCreds}.
 * 2. Sincronizar automaticamente as fontes caso estejam defasadas.
 * 3. Implementar um `SignalKeyStore` que utiliza Redis como cache (L1) e MySQL/Disco como storage permanente (L2).
 * * @example
 * ```typescript
 * const { state, saveCreds } = await useMysqlAuthState('minha-sessao');
 * const sock = makeWASocket({ auth: state });
 * sock.ev.on('creds.update', saveCreds);
 * ```
 * * @param connectionId - Identificador único da conexão (instância do bot).
 * @returns Um objeto contendo o estado de autenticação e o método de persistência.
 * @throws Error caso a conexão com o MySQL não esteja configurada.
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

  /** Busca credenciais no banco de dados MySQL */
  const fetchCredsFromMysql = async (): Promise<AuthenticationCreds | null> => {
    type CredsRow = RowDataPacket & { creds_json: unknown }
    const [rows] = await pool.execute<CredsRow[]>(
      `SELECT creds_json FROM auth_creds WHERE connection_id = ? LIMIT 1`,
      [resolvedConnectionId]
    )
    const row = rows[0]
    return row ? deserialize<AuthenticationCreds>(row.creds_json) : null
  }

  /** Salva credenciais no banco de dados MySQL com UPSERT */
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

  // --- Fase de Recuperação e Eleição de Credenciais ---
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

  // Seleciona o melhor conjunto de dados disponível entre as camadas
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

  // --- Sincronização Proativa ---
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
   * Implementação do armazenamento de chaves do Signal (pre-keys, sessions, etc).
   * Segue o padrão: Tenta Redis -> Se falhar, tenta MySQL -> Se falhar, tenta Disco -> Faz cache no Redis.
   */
  const keys: SignalKeyStore = {
    get: async (type, ids) => {
      const data: { [id: string]: SignalDataTypeMap[typeof type] } = {}
      if (!ids.length) return data

      const remaining = new Set(ids)
      const toWarm: Record<string, string> = {}

      // 1. Tentar Cache L1 (Redis)
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
        
        // Fallback para namespace antigo no Redis
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

      // 2. Tentar Storage L2 (MySQL)
      if (remaining.size) {
        const idsToFetch = Array.from(remaining)
        const placeholders = idsToFetch.map(() => '?').join(', ')
        type KeyRow = RowDataPacket & { key_id: string; value_json: unknown }
        const [rows] = await pool.execute<KeyRow[]>(
          `SELECT key_id, value_json FROM signal_keys 
           WHERE connection_id = ? AND key_type = ? AND key_id IN (${placeholders})`,
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

      // 3. Tentar Fallback L3 (Disco) e Sincronizar com MySQL
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
              
              await ensureMysqlConnection(pool)
              await pool.execute(
                `INSERT INTO signal_keys (connection_id, key_type, key_id, value_json)
                 VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)`,
                [resolvedConnectionId, type, id, serialize(diskValue)]
              )
            }
          })
        )
      }

      // "Aquecer" o Redis com os dados encontrados no MySQL/Disco
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

        // Persistência em Lote (Batch) no MySQL e Redis
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
             VALUES ${values} ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = CURRENT_TIMESTAMP`,
            params
          )
          if (redisPipeline) {
            const payload: Record<string, string> = {}
            for (const entry of toSet) payload[entry.id] = entry.value
            redisPipeline.hSet(redisKeysKey(category), payload)
          }
        }

        if (toDelete.length) {
          const placeholders = toDelete.map(() => '?').join(', ')
          await ensureMysqlConnection(pool)
          await pool.execute(
            `DELETE FROM signal_keys 
             WHERE connection_id = ? AND key_type = ? AND key_id IN (${placeholders})`,
            [resolvedConnectionId, category, ...toDelete]
          )
          if (redisPipeline) {
            redisPipeline.hDel(redisKeysKey(category), toDelete)
          }
        }
      }

      if (redisPipeline) await redisPipeline.exec()
    },
  }

  /**
   * Persiste as credenciais principais (AuthenticationCreds) em todas as camadas.
   * Deve ser chamado sempre que o evento 'creds.update' for disparado.
   */
  const saveCreds = async () => {
    await storeCredsInMysql(creds)
    if (redisClient) {
      await redisClient.set(redisCredsKey, serialize(creds))
    }
    await writeData(config.authDir, 'creds.json', creds)
  }

  return { state: { creds, keys }, saveCreds }
}