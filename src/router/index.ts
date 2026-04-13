import { type WASocket, type proto } from '@whiskeysockets/baileys'
import type { AppLogger } from '../observability/logger.js'
import { createSqlStore, type SqlStore } from '../store/sql-store.js'
import { createCommandProcessor } from '../core/command-runtime/processor.js'

let defaultSqlStore: SqlStore | null = null
const chatQueues = new Map<string, Promise<void>>()

const resolveSqlStore = (sqlStore?: SqlStore): SqlStore => {
  if (sqlStore) return sqlStore
  if (!defaultSqlStore) {
    defaultSqlStore = createSqlStore()
  }
  return defaultSqlStore
}

const resolveQueueKey = (message: proto.IWebMessageInfo): string => {
  return message.key?.remoteJid ?? message.key?.id ?? '__unknown_chat__'
}

const enqueueMessageProcessing = (
  queueKey: string,
  task: () => Promise<void>,
  logger: AppLogger
): void => {
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
      if (chatQueues.get(queueKey) === next) {
        chatQueues.delete(queueKey)
      }
    })

  chatQueues.set(queueKey, next)
}

/**
 * Enfileira mensagens recebidas para execucao assíncrona preservando a ordem por chat.
 * Permite injetar a store SQL para multi-tenant.
 */
export async function handleIncomingMessages(sock: WASocket, messages: proto.IWebMessageInfo[], logger: AppLogger, sqlStore?: SqlStore): Promise<void> {
  const resolvedSqlStore = resolveSqlStore(sqlStore)
  const processor = createCommandProcessor({ logger, sqlStore: resolvedSqlStore })
  if (!messages.length) {
    logger.info('messages.upsert sem mensagens')
    return
  }
  for (const message of messages) {
    const queueKey = resolveQueueKey(message)
    enqueueMessageProcessing(
      queueKey,
      async () => {
        await processor.process(sock, message)
      },
      logger
    )
  }
}
