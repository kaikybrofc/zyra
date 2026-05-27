import {
  getLogger,
  bootstrapConnections,
  getAntiBanStats,
  getOperationalSnapshots,
} from '../core/connection/manager.js'
import { startAntiBanMetricsServer } from '../observability/antiban-metrics.js'
import { startApiServer } from '../api/server.js'
import { startWebhookRetryWorker } from '../webhook/retry-worker.js'
import { startWebhookOutboxWorker } from '../core/webhooks/outbox-dispatcher.js'
import { config } from '../config/index.js'

let metricsServerHandle: { stop: () => Promise<void> } | null = null
let apiServerHandle: { stop: () => Promise<void> } | null = null
let webhookWorkerHandle: { stop: () => void } | null = null
let webhookOutboxWorkerHandle: { stop: () => void } | null = null

/**
 * Executa o bootstrap da aplicação.
 *
 * Responsabilidades:
 * 1) Inicia servidor de métricas anti-ban (quando habilitado)
 * 2) Inicia servidor HTTP da API REST (quando habilitado)
 * 3) Inicia worker de retry de webhooks
 * 4) Executa o bootstrap do ConnectionManager (resolve ids + conecta)
 *
 * @throws Error Quando nenhuma conexão inicial puder ser resolvida.
 */
export async function start(): Promise<void> {
  const logger = getLogger()

  if (!metricsServerHandle && config.antibanEnabled && config.antibanMetricsEnabled) {
    metricsServerHandle = startAntiBanMetricsServer({
      logger,
      getStats: getAntiBanStats,
      getOperationalSnapshots,
    })
  }

  if (!apiServerHandle && config.apiEnabled) {
    apiServerHandle = startApiServer({ logger })
  }

  if (!webhookWorkerHandle) {
    webhookWorkerHandle = startWebhookRetryWorker(logger)
  }

  if (!webhookOutboxWorkerHandle && config.webhookOutboxEnabled) {
    webhookOutboxWorkerHandle = startWebhookOutboxWorker(logger)
  }

  await bootstrapConnections()
}
