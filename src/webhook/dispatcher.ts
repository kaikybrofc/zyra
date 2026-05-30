import { WEBHOOK_SUPPORTED_EVENTS } from './events.js'
import { getActiveWebhooksForEvent } from './store.js'
import { sendWebhookEvent } from './delivery.js'

export { WEBHOOK_SUPPORTED_EVENTS }

export const dispatchWebhookEvent = async (connectionId: string, event: string, data: unknown): Promise<void> => {
  if (!WEBHOOK_SUPPORTED_EVENTS.has(event)) return

  const webhooks = await getActiveWebhooksForEvent(connectionId, event)
  if (!webhooks.length) return

  const payload = {
    event,
    connectionId,
    timestamp: Date.now(),
    data,
  }

  await Promise.allSettled(webhooks.map((wh) => sendWebhookEvent(wh, payload)))
}
