import { createHmac, randomUUID } from 'node:crypto'
import { config } from '../../config/index.js'
import type { AppLogger } from '../../observability/logger.js'
import { createWebhookOutboxEntry, getDueWebhookOutboxEntries, updateWebhookOutboxEntry } from '../../store/connection-admin-store.js'
import { getActiveWebhooksForEvent, getWebhook, GLOBAL_WEBHOOK_CONNECTION_ID } from '../../webhook/store.js'
import { resolveAllowedWebhookTarget } from '../../webhook/url-validation.js'

const OUTBOX_VERSION = '2026-05-24'
const WORKER_INTERVAL_MS = 5_000

const sign = (secret: string, body: string): string => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')

const calcNextRetryAt = (attempt: number): number => {
  const growth = Math.max(0, attempt - 1)
  const candidate = config.webhookOutboxRetryBaseMs * 2 ** growth
  const bounded = Math.min(config.webhookOutboxRetryMaxMs, candidate)
  return Date.now() + bounded
}

type OutboxPayload = {
  event: string
  version: string
  occurred_at: string
  connection: { id: string }
  data: unknown
}

export const enqueueConnectionOutboxEvent = async (connectionId: string, eventType: string, data: unknown): Promise<void> => {
  if (!config.webhookOutboxEnabled) return
  const webhooks = await getActiveWebhooksForEvent(connectionId, eventType)
  if (!webhooks.length) return

  const payload: OutboxPayload = {
    event: eventType,
    version: OUTBOX_VERSION,
    occurred_at: new Date().toISOString(),
    connection: { id: connectionId },
    data,
  }

  await Promise.allSettled(
    webhooks.map((webhook) =>
      createWebhookOutboxEntry({
        id: randomUUID(),
        webhookId: webhook.id,
        connectionId,
        eventType,
        targetUrl: webhook.url,
        payload,
      })
    )
  )
}

const resolveWebhookSecret = async (webhookId: string, connectionId: string): Promise<string | null> => {
  const scoped = await getWebhook(webhookId, connectionId)
  if (scoped?.secret) return scoped.secret
  const global = await getWebhook(webhookId, GLOBAL_WEBHOOK_CONNECTION_ID)
  return global?.secret ?? null
}

const processOutboxEntry = async (entry: Awaited<ReturnType<typeof getDueWebhookOutboxEntries>>[number]) => {
  const payloadBody = JSON.stringify(entry.payload)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-zyra-event': entry.eventType,
    'x-zyra-outbox-id': entry.id,
  }

  const secret = await resolveWebhookSecret(entry.webhookId, entry.connectionId)
  if (secret) {
    headers['x-zyra-signature'] = sign(secret, payloadBody)
  }

  const attempts = entry.attemptCount + 1
  let responseStatus: number | null = null
  let lastError: string | null = null

  const resolvedTarget = resolveAllowedWebhookTarget(entry.targetUrl)
  if (!resolvedTarget.ok) {
    lastError = resolvedTarget.reason
  } else {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.webhookTimeoutMs)
    try {
      const response = await fetch(resolvedTarget.targetUrl, {
        method: 'POST',
        headers,
        body: payloadBody,
        signal: controller.signal,
      })
      responseStatus = response.status
      if (response.ok) {
        await updateWebhookOutboxEntry(entry.id, {
          status: 'delivered',
          attemptCount: attempts,
          nextAttemptAt: null,
          lastError: null,
          responseStatus,
        })
        return
      }
      lastError = `resposta HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
    }
  }

  const maxAttempts = config.webhookMaxAttempts
  if (attempts >= maxAttempts) {
    await updateWebhookOutboxEntry(entry.id, {
      status: 'dead_letter',
      attemptCount: attempts,
      nextAttemptAt: null,
      lastError,
      responseStatus,
    })
    return
  }

  await updateWebhookOutboxEntry(entry.id, {
    status: 'failed',
    attemptCount: attempts,
    nextAttemptAt: calcNextRetryAt(attempts),
    lastError,
    responseStatus,
  })
}

export const startWebhookOutboxWorker = (logger: AppLogger): { stop: () => void } => {
  const interval = setInterval(async () => {
    if (!config.webhookOutboxEnabled) return
    try {
      const pending = await getDueWebhookOutboxEntries(config.webhookOutboxBatchSize)
      if (!pending.length) return

      logger.debug('webhook outbox worker: processando itens pendentes', { count: pending.length })
      await Promise.allSettled(pending.map((entry) => processOutboxEntry(entry)))
    } catch (error) {
      logger.error('webhook outbox worker: erro inesperado', { err: error })
    }
  }, WORKER_INTERVAL_MS)

  interval.unref()

  return {
    stop: () => clearInterval(interval),
  }
}
