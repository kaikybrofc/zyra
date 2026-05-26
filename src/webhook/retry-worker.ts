import type { AppLogger } from '../observability/logger.js'
import { getPendingRetries, getWebhook } from './store.js'
import { attemptDelivery } from './delivery.js'

const POLL_INTERVAL_MS = 60_000

export const startWebhookRetryWorker = (logger: AppLogger): { stop: () => void } => {
  const interval = setInterval(async () => {
    try {
      const pending = await getPendingRetries()
      if (!pending.length) return

      logger.info('webhook retry worker: processando entregas pendentes', { count: pending.length })

      await Promise.allSettled(
        pending.map(async (delivery) => {
          const webhook = await getWebhook(delivery.webhookId, delivery.connectionId)
          if (!webhook || !webhook.active) return
          await attemptDelivery(delivery, webhook)
        })
      )
    } catch (error) {
      logger.error('webhook retry worker: erro inesperado', { err: error })
    }
  }, POLL_INTERVAL_MS)

  interval.unref()

  return {
    stop: () => clearInterval(interval),
  }
}
