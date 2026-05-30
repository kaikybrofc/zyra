import { createHmac } from 'node:crypto'
import { config } from '../config/index.js'
import type { WebhookRecord, DeliveryRecord } from './types.js'
import type { WebhookPayload } from './types.js'
import { createDelivery, updateDelivery } from './store.js'
import { resolveAllowedWebhookTarget } from './url-validation.js'

const RETRY_DELAYS_MS = [
  30 * 1000, // 1st retry: 30s
  5 * 60 * 1000, // 2nd retry: 5min
  30 * 60 * 1000, // 3rd retry: 30min
]

const sign = (secret: string, body: string): string => {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

export const attemptDelivery = async (delivery: DeliveryRecord, webhook: WebhookRecord): Promise<void> => {
  const body = JSON.stringify(delivery.payload)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-webhook-event': delivery.eventType,
    'x-webhook-delivery': delivery.id,
  }
  if (webhook.secret) {
    headers['x-webhook-signature'] = sign(webhook.secret, body)
  }

  let responseStatus: number | null = null
  let responseBody: string | null = null
  let success = false

  const resolvedTarget = resolveAllowedWebhookTarget(webhook.url)
  if (!resolvedTarget.ok) {
    responseBody = resolvedTarget.reason
  } else {
    const timeoutMs = config.webhookTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(resolvedTarget.targetUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })
      responseStatus = response.status
      responseBody = (await response.text()).slice(0, 1000)
      success = response.ok
    } catch {
      // network error or timeout
    } finally {
      clearTimeout(timer)
    }
  }

  const attempts = delivery.attempts + 1
  const now = Date.now()

  if (success) {
    await updateDelivery(delivery.id, {
      status: 'delivered',
      attempts,
      lastAttemptAt: now,
      nextRetryAt: null,
      responseStatus,
      responseBody,
    })
    return
  }

  const maxAttempts = config.webhookMaxAttempts
  if (attempts >= maxAttempts) {
    await updateDelivery(delivery.id, {
      status: 'dead_letter',
      attempts,
      lastAttemptAt: now,
      nextRetryAt: null,
      responseStatus,
      responseBody,
    })
    return
  }

  const delayMs = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!
  await updateDelivery(delivery.id, {
    status: 'failed',
    attempts,
    lastAttemptAt: now,
    nextRetryAt: now + delayMs,
    responseStatus,
    responseBody,
  })
}

export const sendWebhookEvent = async (webhook: WebhookRecord, payload: WebhookPayload): Promise<void> => {
  const delivery = await createDelivery({
    webhookId: webhook.id,
    connectionId: webhook.connectionId,
    eventType: payload.event,
    payload,
  })
  await attemptDelivery(delivery, webhook)
}
