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
import { createClient, type RedisClientType } from 'redis'
import { config } from '../../config/index.js'

type RedisAuthState = {
  state: AuthenticationState
  saveCreds: () => Promise<void>
}

let redisClient: RedisClientType | null = null
let redisReady: Promise<void> | null = null
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

const getRedisClient = async (): Promise<RedisClientType> => {
  if (!config.redisUrl) {
    throw new Error('WA_REDIS_URL nao configurada')
  }

  if (!redisClient) {
    redisClient = createClient({ url: config.redisUrl })
    redisClient.on('error', (error) => {
      console.error('falha ao conectar no Redis', error)
    })
    redisReady = redisClient.connect().then(() => undefined)
  }

  if (redisReady) {
    await redisReady
  }

  return redisClient
}

const redisKeyPrefix = config.redisPrefix ?? 'zyra:conexao'
const redisCredsKey = `${redisKeyPrefix}:creds`
const redisKeysKey = (type: string) => `${redisKeyPrefix}:keys:${type}`

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

export async function useRedisAuthState(): Promise<RedisAuthState> {
  await ensureAuthFolder(config.authDir)
  const client = await getRedisClient()

  const credsFromDisk = await readData<AuthenticationCreds>(config.authDir, 'creds.json')
  const credsFromRedisRaw = await client.get(redisCredsKey)
  const credsFromRedis = credsFromRedisRaw
    ? deserialize<AuthenticationCreds>(credsFromRedisRaw)
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
      const toWarm: Record<string, string> = {}

      await Promise.all(
        values.map(async (raw: string | null, index: number) => {
          const id = ids[index]
          if (!id) return

          let value: SignalDataTypeMap[typeof type] | null = null

          if (raw) {
            value = deserialize<SignalDataTypeMap[typeof type]>(raw)
          } else {
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
