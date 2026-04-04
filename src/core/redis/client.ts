import { createClient, type RedisClientType } from 'redis'
import { config } from '../../config/index.js'

let redisClient: RedisClientType | null = null
let redisReady: Promise<void> | null = null

/**
 * Retorna um cliente Redis singleton pronto para uso.
 */
export async function getRedisClient(): Promise<RedisClientType> {
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
