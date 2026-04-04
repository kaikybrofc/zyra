import {
  BufferJSON,
  initAuthCreds,
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

type RedisAuthState = {
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
const deserialize = <T>(value: string) => JSON.parse(value, BufferJSON.reviver) as T

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

const redisKeyPrefix = getRedisNamespace()
const legacyRedisKeyPrefix = getLegacyRedisNamespace()
const redisCredsKey = `${redisKeyPrefix}:creds`
const legacyRedisCredsKey = legacyRedisKeyPrefix ? `${legacyRedisKeyPrefix}:creds` : null
const redisKeysKey = (type: string) => `${redisKeyPrefix}:keys:${type}`
const legacyRedisKeysKey = (type: string) =>
  legacyRedisKeyPrefix ? `${legacyRedisKeyPrefix}:keys:${type}` : null

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
 * Cria estado de autenticacao persistido no Redis.
 */
export async function useRedisAuthState(): Promise<RedisAuthState> {
  await ensureAuthFolder(config.authDir)
  const client = await getRedisClient()

  const credsFromDisk = await readData<AuthenticationCreds>(config.authDir, 'creds.json')
  const credsFromRedisRaw = await client.get(redisCredsKey)
  const credsFromLegacyRaw = legacyRedisCredsKey ? await client.get(legacyRedisCredsKey) : null
  const credsFromRedis = credsFromRedisRaw
    ? deserialize<AuthenticationCreds>(credsFromRedisRaw)
    : credsFromLegacyRaw
      ? deserialize<AuthenticationCreds>(credsFromLegacyRaw)
      : null
  const creds = credsFromDisk ?? credsFromRedis ?? initAuthCreds()

  if (credsFromDisk && !credsFromRedisRaw) {
    await client.set(redisCredsKey, serialize(credsFromDisk))
  }

  const keys: SignalKeyStore = {
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

          if (raw) {
            value = deserialize<SignalDataTypeMap[typeof type]>(raw)
          } else {
            if (legacyRedisKey) {
              const legacyRaw = await client.hGet(legacyRedisKey, id)
              if (legacyRaw) {
                value = deserialize<SignalDataTypeMap[typeof type]>(legacyRaw)
                toWarm[id] = legacyRaw
              }
            }
          }

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

      if (Object.keys(toWarm).length) {
        await client.hSet(redisKey, toWarm)
      }

      return data
    },
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

  const saveCreds = async () => {
    await writeData(config.authDir, 'creds.json', creds)
    await client.set(redisCredsKey, serialize(creds))
  }

  return { state: { creds, keys }, saveCreds }
}
