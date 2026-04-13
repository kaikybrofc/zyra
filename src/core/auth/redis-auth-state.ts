import { type AuthenticationCreds, type AuthenticationState, type SignalDataSet, type SignalDataTypeMap, type SignalKeyStore } from '@whiskeysockets/baileys'
import { config } from '../../config/index.js'
import { getRedisClient } from '../redis/client.js'
import { getLegacyRedisNamespace, getRedisNamespace } from '../redis/prefix.js'
import { resolveAuthDir } from './auth-dir.js'
import { selectBestCreds } from './creds-utils.js'
import { deleteData, deserialize, ensureAuthFolder, normalizeKeyValue, readData, serialize, writeData } from './storage-utils.js'

/**
 * Representa o estado de autenticação configurado especificamente para o Redis.
 */
type RedisAuthState = {
  /** Estado compatível com o Baileys contendo credenciais e gerenciador de chaves */
  state: AuthenticationState
  /** Persiste as credenciais atuais no Redis e no Disco */
  saveCreds: () => Promise<void>
}

const DISK_READ_CONCURRENCY = Math.max(1, Number(process.env.WA_AUTH_DISK_CONCURRENCY ?? 50))

const runWithConcurrency = async <T>(items: T[], concurrency: number, handler: (item: T) => Promise<void>) => {
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
    legacyRedisKeysKey: (type: string) => (legacyRedisKeyPrefix ? `${legacyRedisKeyPrefix}:keys:${type}` : null),
  }
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
  const authDir = resolveAuthDir(connectionId)
  await ensureAuthFolder(authDir)
  const client = await getRedisClient()
  const persistKeysOnDisk = config.authPersistKeysOnDisk
  const { redisCredsKey, legacyRedisCredsKey, redisKeysKey, legacyRedisKeysKey } = buildRedisKeys(connectionId)
  let redisFailureLogged = false
  let redisRecoveryLogged = false

  const markRedisUnhealthy = (error: unknown) => {
    if (!redisFailureLogged) {
      redisFailureLogged = true
      redisRecoveryLogged = false
      console.warn('[auth] falha ao acessar redis, usando disco como fallback', { error })
    }
  }

  const markRedisHealthy = () => {
    if (!redisFailureLogged || redisRecoveryLogged) return
    redisRecoveryLogged = true
    redisFailureLogged = false
    console.info('[auth] redis recuperado, reativando cache')
  }

  const withRedis = async <T>(fn: (redisClient: typeof client) => Promise<T>, fallback: T): Promise<T> => {
    try {
      const result = await fn(client)
      if (redisFailureLogged) markRedisHealthy()
      return result
    } catch (error) {
      markRedisUnhealthy(error)
      return fallback
    }
  }

  // --- Recuperação de Credenciais ---
  const credsFromDisk = await readData<AuthenticationCreds>(authDir, 'creds.json')
  const credsFromRedisRaw = await withRedis((redisClient) => redisClient.get(redisCredsKey), null)
  const credsFromLegacyRaw = legacyRedisCredsKey ? await withRedis((redisClient) => redisClient.get(legacyRedisCredsKey), null) : null

  const credsFromRedis = credsFromRedisRaw ? deserialize<AuthenticationCreds>(credsFromRedisRaw) : credsFromLegacyRaw ? deserialize<AuthenticationCreds>(credsFromLegacyRaw) : null

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
    await withRedis((redisClient) => redisClient.set(redisCredsKey, serializedCurrent), undefined)
  }

  const serializedDisk = credsFromDisk ? serialize(credsFromDisk) : null
  if (!serializedDisk || serializedDisk !== serializedCurrent) {
    await writeData(authDir, 'creds.json', creds)
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
      const emptyValues: Array<string | null> = ids.map(() => null)
      const values = await withRedis<Array<string | null>>((redisClient) => redisClient.hmGet(redisKey, ids) as Promise<Array<string | null>>, emptyValues)
      const legacyRedisKey = legacyRedisKeysKey(type)
      const toWarm: Record<string, string> = {}

      await runWithConcurrency(
        values.map((raw: string | null, index: number) => ({ raw, index })),
        DISK_READ_CONCURRENCY,
        async ({ raw, index }) => {
          const id = ids[index]
          if (!id) return

          let value: SignalDataTypeMap[typeof type] | null = null

          // 1. Tentar Redis Atual
          if (raw) {
            value = deserialize<SignalDataTypeMap[typeof type]>(raw)
          } else {
            // 2. Tentar Redis Legado (Migração)
            if (legacyRedisKey) {
              const legacyRaw = await withRedis((redisClient) => redisClient.hGet(legacyRedisKey, id), null)
              if (legacyRaw) {
                value = deserialize<SignalDataTypeMap[typeof type]>(legacyRaw)
                toWarm[id] = legacyRaw
              }
            }
          }

          // 3. Tentar Disco Local
          if (!value) {
            const diskValue = await readData<SignalDataTypeMap[typeof type]>(authDir, `${type}-${id}.json`)
            if (diskValue) {
              value = diskValue
              toWarm[id] = serialize(diskValue)
            }
          }

          const normalized = normalizeKeyValue(type, value)
          if (normalized) {
            data[id] = normalized
          }
        }
      )

      // Salva no Redis Atual o que foi encontrado em outras fontes para acelerar o próximo 'get'
      if (Object.keys(toWarm).length) {
        await withRedis((redisClient) => redisClient.hSet(redisKey, toWarm), undefined)
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
        const diskOperations: Array<() => Promise<void>> = []

        for (const [id, value] of Object.entries(entries)) {
          if (value) {
            toSet[id] = serialize(value)
            if (persistKeysOnDisk) {
              diskOperations.push(() => writeData(authDir, `${category}-${id}.json`, value))
            }
          } else {
            toDelete.push(id)
            if (persistKeysOnDisk) {
              diskOperations.push(() => deleteData(authDir, `${category}-${id}.json`))
            }
          }
        }

        if (Object.keys(toSet).length) {
          pipeline.hSet(redisKey, toSet)
        }
        if (toDelete.length) {
          pipeline.hDel(redisKey, toDelete)
        }
        if (diskOperations.length) {
          await runWithConcurrency(diskOperations, DISK_READ_CONCURRENCY, async (operation) => {
            await operation()
          })
        }
      }

      await withRedis((redisClient) => {
        void redisClient
        return pipeline.exec()
      }, undefined)
    },
  }

  /**
   * Sincroniza o estado atual das credenciais no Disco e Redis.
   */
  const saveCreds = async () => {
    await Promise.all([writeData(authDir, 'creds.json', creds), withRedis((redisClient) => redisClient.set(redisCredsKey, serialize(creds)), undefined)])
  }

  return { state: { creds, keys }, saveCreds }
}
