import { type WASocket, type proto } from '@whiskeysockets/baileys'
import type { AppLogger } from '../observability/logger.js'
import type { SqlStore } from '../store/sql-store.js'
import { createCommandProcessor } from '../core/command-runtime/processor.js'
const chatQueues = new Map<string, Promise<void>>()
const queueSizes = new Map<string, number>()
const MAX_PENDING_PER_QUEUE = Math.max(1, Number(process.env.WA_ROUTER_MAX_PENDING_PER_QUEUE ?? 500))

const resolveQueueKey = (message: proto.IWebMessageInfo, connectionId: string): string => {
  const chatKey = message.key?.remoteJid ?? message.key?.id ?? '__unknown_chat__'
  // Um processo pode manter múltiplas conexões; isolamos a fila por conexão para evitar head-of-line blocking.
  return `${connectionId}:${chatKey}`
}

const enqueueMessageProcessing = (
  queueKey: string,
  task: () => Promise<void>,
  logger: AppLogger
): boolean => {
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
export async function handleIncomingMessages(
  sock: WASocket,
  messages: proto.IWebMessageInfo[],
  logger: AppLogger,
  connectionId: string,
  sqlStore: SqlStore
): Promise<void> {
  const processor = createCommandProcessor({ logger, sqlStore })
  if (!messages.length) {
    logger.info('messages.upsert sem mensagens')
    return
  }
  for (const message of messages) {
    const queueKey = resolveQueueKey(message, connectionId)
    const enqueued = enqueueMessageProcessing(
      queueKey,
      async () => {
        await processor.process(sock, message)
      },
      logger
    )
    if (!enqueued) {
      logger.debug('mensagem descartada por backpressure da fila', {
        queueKey,
        messageId: message.key?.id ?? null,
      })
    }
  }
}
