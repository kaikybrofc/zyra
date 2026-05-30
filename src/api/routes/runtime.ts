import process from 'node:process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { config } from '../../config/index.js'
import { matchRoute, sendJson } from '../http.js'

type RuntimeProfile = 'full' | 'connections-only' | 'api-webhook' | 'stateless'

const resolveProfile = (): RuntimeProfile => {
  if (config.bootstrapConnectionsEnabled && config.apiEnabled) return 'full'
  if (config.bootstrapConnectionsEnabled && !config.apiEnabled) return 'connections-only'
  if (!config.bootstrapConnectionsEnabled && config.apiEnabled) return 'api-webhook'
  return 'stateless'
}

/**
 * Expõe metadados operacionais do processo para uso do dashboard.
 */
export async function handleRuntimeRoutes(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const method = req.method ?? 'GET'
  if (!(method === 'GET' && matchRoute('/system/runtime', pathname))) return false

  const profile = resolveProfile()
  sendJson(res, 200, {
    now: Date.now(),
    profile,
    capabilities: {
      managesConnections: config.bootstrapConnectionsEnabled,
      servesApi: config.apiEnabled,
      managesWebhookRetry: config.webhookRetryWorkerEnabled,
      managesWebhookOutbox: config.webhookOutboxEnabled,
      connectionWebhookIngress: Boolean(config.webhookSharedSecret?.trim()),
    },
    api: {
      enabled: config.apiEnabled,
      host: config.apiHost,
      port: config.apiPort,
      authRequired: config.apiKey !== null,
    },
    webhook: {
      retryWorkerEnabled: config.webhookRetryWorkerEnabled,
      outboxWorkerEnabled: config.webhookOutboxEnabled,
      timeoutMs: config.webhookTimeoutMs,
      maxAttempts: config.webhookMaxAttempts,
      allowedTargetsCount: config.webhookAllowedTargets.length,
    },
    process: {
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      pm2: {
        appName: process.env.name ?? null,
        processId: process.env.pm_id ?? null,
      },
    },
  })
  return true
}
