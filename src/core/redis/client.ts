import { createClient } from 'redis'
import { config } from '../../config/index.js'

const REDIS_CONNECT_RETRY_BASE_MS = Math.max(100, Number(process.env.WA_REDIS_CONNECT_RETRY_BASE_MS ?? 500))
const REDIS_CONNECT_RETRY_MAX_MS = Math.max(REDIS_CONNECT_RETRY_BASE_MS, Number(process.env.WA_REDIS_CONNECT_RETRY_MAX_MS ?? 10_000))
const REDIS_CONNECT_MAX_ATTEMPTS = Math.max(1, Number(process.env.WA_REDIS_CONNECT_MAX_ATTEMPTS ?? 4))

type AppRedisClient = ReturnType<typeof createClient>

let redisClient: AppRedisClient | null = null
let redisConnectPromise: Promise<AppRedisClient> | null = null
let redisClosePromise: Promise<void> | null = null
let shutdownHooksRegistered = false

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const computeBackoffMs = (attempt: number): number => {
  const exponential = REDIS_CONNECT_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1))
  const jitter = Math.floor(Math.random() * Math.max(1, REDIS_CONNECT_RETRY_BASE_MS * 0.25))
  return Math.min(REDIS_CONNECT_RETRY_MAX_MS, Math.floor(exponential + jitter))
}

const ensureRedisUrl = (): string => {
  if (!config.redisUrl) {
    throw new Error('WA_REDIS_URL nao configurada')
  }
  return config.redisUrl
}

const registerShutdownHooks = (): void => {
  if (shutdownHooksRegistered) return
  shutdownHooksRegistered = true
  process.once('beforeExit', () => {
    void closeRedisClient()
  })
}

const createRedisConnection = (): AppRedisClient => {
  const url = ensureRedisUrl()
  const client = createClient({
    url,
    socket: {
      reconnectStrategy: (retries) => computeBackoffMs(retries + 1),
    },
  })
  client.on('error', (error) => {
    console.error('falha no cliente Redis', error)
  })
  client.on('end', () => {
    redisConnectPromise = null
  })
  registerShutdownHooks()
  return client
}

/**
 * Retorna um cliente Redis singleton pronto para uso.
 * Implementa tentativas de conexão com backoff e permite nova tentativa em chamadas futuras.
 */
export async function getRedisClient(): Promise<AppRedisClient> {
  if (redisClient?.isReady) {
    return redisClient
  }
  if (redisConnectPromise) {
    return redisConnectPromise
  }

  if (!redisClient) {
    redisClient = createRedisConnection()
  }

  const client = redisClient
  redisConnectPromise = (async () => {
    let lastError: unknown
    for (let attempt = 1; attempt <= REDIS_CONNECT_MAX_ATTEMPTS; attempt++) {
      if (client.isReady) {
        return client
      }
      try {
        await client.connect()
        return client
      } catch (error) {
        lastError = error
        const hasMoreAttempts = attempt < REDIS_CONNECT_MAX_ATTEMPTS
        if (!hasMoreAttempts) break
        const delayMs = computeBackoffMs(attempt)
        await wait(delayMs)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('falha ao conectar no Redis')
  })()
    .catch((error) => {
      redisConnectPromise = null
      throw error
    })
    .finally(() => {
      if (client.isReady) {
        redisConnectPromise = null
      }
    })

  return redisConnectPromise
}

/**
 * Encerra o cliente Redis singleton de forma graciosa.
 */
export async function closeRedisClient(): Promise<void> {
  if (!redisClient) return
  if (redisClosePromise) {
    await redisClosePromise
    return
  }

  const client = redisClient
  redisClosePromise = (async () => {
    try {
      if (client.isOpen) {
        await client.quit()
      } else {
        await client.disconnect()
      }
    } catch (error) {
      console.error('falha ao encerrar cliente Redis, desconectando a conexao', error)
      await client.disconnect().catch(() => undefined)
    } finally {
      if (redisClient === client) {
        redisClient = null
      }
      redisConnectPromise = null
      redisClosePromise = null
    }
  })()

  await redisClosePromise
}
