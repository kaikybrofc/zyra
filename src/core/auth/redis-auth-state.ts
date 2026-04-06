import {
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../../config/index.js'
import { getRedisClient } from '../redis/client.js'
import { getLegacyRedisNamespace, getRedisNamespace } from '../redis/prefix.js'
import { selectBestCreds } from './creds-utils.js'

/**
 * Representa o estado de autenticação configurado especificamente para o Redis.
 */
type RedisAuthState = {
  /** Estado compatível com o Baileys contendo credenciais e gerenciador de chaves */
  state: AuthenticationState
  /** Persiste as credenciais atuais no Redis e no Disco */
  saveCreds: () => Promise<void>
}

/** Controle de estado para garantir a criação da pasta de logs/auth apenas uma vez */
let authFolderReady: Promise<void> | null = null

/**
 * Assegura que o diretório base para arquivos de fallback exista.
 * @internal
 */
const ensureAuthFolder = async (folder: string) => {
  if (!authFolderReady) {
    authFolderReady = mkdir(folder, { recursive: true }).then(() => undefined)
  }
  await authFolderReady
}

/**
 * Formata o nome do arquivo para evitar caracteres inválidos no sistema de arquivos.
 * @internal
 */
const fixFileName = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-')

/**
 * Converte objetos em string JSON usando o replacer do Baileys (suporte a Buffer).
 * @internal
 */
const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)

/**
 * Converte string JSON de volta em objetos usando o reviver do Baileys (restaura Buffers).
 * @internal
 */
const deserialize = <T>(value: string) => JSON.parse(value, BufferJSON.reviver) as T

/**
 * Tenta ler um arquivo JSON do disco e desserializá-lo. Retorna null em caso de erro.
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
 * Salva dados no disco de forma serializada.
 * @internal
 */
const writeData = async (folder: string, file: string, data: unknown): Promise<void> => {
  const filePath = join(folder, fixFileName(file))
  await writeFile(filePath, serialize(data))
}

/**
 * Define as chaves de acesso ao Redis baseadas no ID da conexão e prefixos configurados.
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
 * Normaliza objetos do Signal para garantir que correspondam aos tipos do ProtoBuf.
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
 * Inicializa o estado de autenticação utilizando Redis como storage primário.
 * * @remarks
 * Esta função implementa uma estratégia de **dupla persistência**:
 * 1. **Fase de Boot:** Tenta recuperar as melhores credenciais entre Redis e Disco local.
 * 2. **Sincronização:** Se os dados do Disco estiverem defasados em relação ao Redis (ou vice-versa),
 * o sistema equaliza as fontes automaticamente.
 * 3. **Hierarquia de Chaves:** Ao buscar uma chave (get), o sistema tenta:
 * `Redis Atual` -> `Redis Legado (Migração)` -> `Disco Local`.
 * * @param connectionId - Identificador opcional da instância/conexão.
 * @returns Promessa contendo o estado de autenticação e método de salvamento.
 * * @example
 * ```typescript
 * const { state, saveCreds } = await useRedisAuthState('bot_01');
 * const socket = makeWASocket({ auth: state });
 * socket.ev.on('creds.update', saveCreds);
 * ```
 */
export async function useRedisAuthState(connectionId?: string): Promise<RedisAuthState> {
  await ensureAuthFolder(config.authDir)
  const client = await getRedisClient()
  const { redisCredsKey, legacyRedisCredsKey, redisKeysKey, legacyRedisKeysKey } =
    buildRedisKeys(connectionId)

  // --- Recuperação de Credenciais ---
  const credsFromDisk = await readData<AuthenticationCreds>(config.authDir, 'creds.json')
  const credsFromRedisRaw = await client.get(redisCredsKey)
  const credsFromLegacyRaw = legacyRedisCredsKey ? await client.get(legacyRedisCredsKey) : null
  
  const credsFromRedis = credsFromRedisRaw
    ? deserialize<AuthenticationCreds>(credsFromRedisRaw)
    : credsFromLegacyRaw
      ? deserialize<AuthenticationCreds>(credsFromLegacyRaw)
      : null

  // Eleição da melhor credencial disponível
  const selection = selectBestCreds(
    [
      { source: 'redis', creds: credsFromRedis },
      { source: 'disk', creds: credsFromDisk },
    ],
    ['redis', 'disk']
  )
  const creds = selection.creds

  if (selection.meta.missingCritical.length) {
    console.warn('[auth] credenciais incompletas detectadas', {
      source: selection.meta.source,
      missing: selection.meta.missingCritical,
    })
  }

  // --- Sincronização Inicial ---
  const serializedCurrent = serialize(creds)
  if (credsFromRedisRaw !== serializedCurrent) {
    await client.set(redisCredsKey, serializedCurrent)
  }

  const serializedDisk = credsFromDisk ? serialize(credsFromDisk) : null
  if (!serializedDisk || serializedDisk !== serializedCurrent) {
    await writeData(config.authDir, 'creds.json', creds)
  }

  /**
   * Implementação da interface SignalKeyStore para o Baileys.
   * Gerencia chaves de criptografia, sessões e pre-keys.
   */
  const keys: SignalKeyStore = {
    /**
     * Recupera chaves específicas do storage.
     * Implementa 'Warm-up': chaves lidas do Disco ou Redis Legado são promovidas para o Redis Atual.
     */
    get: async (type, ids) => {
      const data: { [id: string]: SignalDataTypeMap[typeof type] } = {}
      if (!ids.length) return data

      const redisKey = redisKeysKey(type)
      const values = await client.hmGet(redisKey, ids)
      const legacyRedisKey = legacyRedisKeysKey(type)
      const toWarm: Record<string, string> = {}

      await Promise.all(
        values.map(async (raw: string | null, index: number) => {
          const id = ids[index]
          if (!id) return

          let value: SignalDataTypeMap[typeof type] | null = null

          // 1. Tentar Redis Atual
          if (raw) {
            value = deserialize<SignalDataTypeMap[typeof type]>(raw)
          } else {
            // 2. Tentar Redis Legado (Migração)
            if (legacyRedisKey) {
              const legacyRaw = await client.hGet(legacyRedisKey, id)
              if (legacyRaw) {
                value = deserialize<SignalDataTypeMap[typeof type]>(legacyRaw)
                toWarm[id] = legacyRaw
              }
            }
          }

          // 3. Tentar Disco Local
          if (!value) {
            const diskValue = await readData<SignalDataTypeMap[typeof type]>(
              config.authDir,
              `${type}-${id}.json`
            )
            if (diskValue) {
              value = diskValue
              toWarm[id] = serialize(diskValue)
            }
          }

          const normalized = normalizeKeyValue(type, value)
          if (normalized) {
            data[id] = normalized
          }
        })
      )

      // Salva no Redis Atual o que foi encontrado em outras fontes para acelerar o próximo 'get'
      if (Object.keys(toWarm).length) {
        await client.hSet(redisKey, toWarm)
      }

      return data
    },

    /**
     * Persiste um lote de chaves no Redis usando Pipelines para alta performance.
     */
    set: async (data: SignalDataSet) => {
      const pipeline = client.multi()
      for (const category of Object.keys(data) as Array<keyof SignalDataSet>) {
        const entries = data[category]
        if (!entries) continue

        const redisKey = redisKeysKey(category)
        const toSet: Record<string, string> = {}
        const toDelete: string[] = []

        for (const [id, value] of Object.entries(entries)) {
          if (value) {
            toSet[id] = serialize(value)
          } else {
            toDelete.push(id)
          }
        }

        if (Object.keys(toSet).length) {
          pipeline.hSet(redisKey, toSet)
        }
        if (toDelete.length) {
          pipeline.hDel(redisKey, toDelete)
        }
      }

      await pipeline.exec()
    },
  }

  /**
   * Sincroniza o estado atual das credenciais no Disco e Redis.
   */
  const saveCreds = async () => {
    await writeData(config.authDir, 'creds.json', creds)
    await client.set(redisCredsKey, serialize(creds))
  }

  return { state: { creds, keys }, saveCreds }
}