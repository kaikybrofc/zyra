import { type WASocket, type proto } from '@whiskeysockets/baileys'
import type { AppLogger } from '../observability/logger.js'
import { createSqlStore, type SqlStore } from '../store/sql-store.js'
import { createCommandProcessor } from '../core/command-runtime/processor.js'

let defaultSqlStore: SqlStore | null = null

const resolveSqlStore = (sqlStore?: SqlStore): SqlStore => {
  if (sqlStore) return sqlStore
  if (!defaultSqlStore) {
    defaultSqlStore = createSqlStore()
  }
  return defaultSqlStore
}

/**
 * Processa mensagens recebidas e executa comandos quando aplicavel.
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
    await processor.process(sock, message)
  }
}
