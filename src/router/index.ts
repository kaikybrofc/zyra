import { type WASocket, type proto } from 'baileys'
import type { AppLogger } from '../observability/logger.js'
import type { SqlStore } from '../store/sql-store.js'
import { createCommandProcessor } from '../core/command-runtime/processor.js'

const chatQueues = new Map<string, Promise<void>>()
const queueSizes = new Map<string, number>()
const MAX_PENDING_PER_QUEUE = Math.max(1, Number(process.env.WA_ROUTER_MAX_PENDING_PER_QUEUE ?? 500))
/** 0 = no timeout */
const COMMAND_TIMEOUT_MS = Math.max(0, Number(process.env.WA_COMMAND_TIMEOUT_MS ?? 60_000))

/** Cached per-connection processor — preserves antilink and rate-limit state across message batches. */
const processorCache = new Map<string, ReturnType<typeof createCommandProcessor>>()

const resolveQueueKey = (message: proto.IWebMessageInfo, connectionId: string): string => {
  const chatKey = message.key?.remoteJid ?? message.key?.id ?? '__unknown_chat__'
  // Um processo pode manter múltiplas conexões; isolamos a fila por conexão para evitar head-of-line blocking.
  return `${connectionId}:${chatKey}`
}

const withCommandTimeout = (task: () => Promise<void>, logger: AppLogger, queueKey: string, messageId: string | null | undefined): Promise<void> => {
  if (COMMAND_TIMEOUT_MS <= 0) return task()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      logger.error('command processing timed out', {
        queueKey,
        messageId,
        timeoutMs: COMMAND_TIMEOUT_MS,
      })
      resolve()
    }, COMMAND_TIMEOUT_MS)
    void task().then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

const enqueueMessageProcessing = (queueKey: string, task: () => Promise<void>, logger: AppLogger): boolean => {
  const pending = queueSizes.get(queueKey) ?? 0
  if (pending >= MAX_PENDING_PER_QUEUE) {
    logger.warn('fila de processamento saturada; mensagem descartada para proteger memoria', {
      queueKey,
      pending,
      maxPending: MAX_PENDING_PER_QUEUE,
    })
    return false
  }

  queueSizes.set(queueKey, pending + 1)
  const previous = chatQueues.get(queueKey) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(task)
    .catch((error) => {
      logger.error('falha ao processar mensagem enfileirada', {
        err: error,
        queueKey,
      })
    })
    .finally(() => {
      const currentSize = (queueSizes.get(queueKey) ?? 1) - 1
      if (currentSize > 0) {
        queueSizes.set(queueKey, currentSize)
      } else {
        queueSizes.delete(queueKey)
      }
      if (chatQueues.get(queueKey) === next) {
        chatQueues.delete(queueKey)
      }
    })

  chatQueues.set(queueKey, next)
  return true
}

/**
 * Enfileira mensagens recebidas para execucao assíncrona preservando a ordem por chat.
 * Permite injetar a store SQL para multi-tenant.
 */
export async function handleIncomingMessages(sock: WASocket, messages: proto.IWebMessageInfo[], logger: AppLogger, connectionId: string, sqlStore: SqlStore): Promise<void> {
  if (!messages.length) {
    logger.info('messages.upsert sem mensagens')
    return
  }

  if (!processorCache.has(connectionId)) {
    processorCache.set(connectionId, createCommandProcessor({ logger, sqlStore }))
  }
  const processor = processorCache.get(connectionId)!

  for (const message of messages) {
    const queueKey = resolveQueueKey(message, connectionId)
    const enqueued = enqueueMessageProcessing(queueKey, () => withCommandTimeout(() => processor.process(sock, message), logger, queueKey, message.key?.id), logger)
    if (!enqueued) {
      logger.debug('mensagem descartada por backpressure da fila', {
        queueKey,
        messageId: message.key?.id ?? null,
      })
    }
  }
}
