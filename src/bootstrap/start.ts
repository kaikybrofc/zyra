import {
  getLogger,
  getOrCreateRuntime,
  resolveStartupConnectionIds,
  scheduleReconnect,
  getAntiBanStats,
  getOperationalSnapshots,
} from '../core/connection/manager.js'
import { startAntiBanMetricsServer } from '../observability/antiban-metrics.js'
import { startApiServer } from '../api/server.js'
import { config } from '../config/index.js'

let metricsServerHandle: { stop: () => Promise<void> } | null = null
let apiServerHandle: { stop: () => Promise<void> } | null = null

/**
 * Executa o bootstrap da aplicação.
 *
 * Responsabilidades:
 * 1) Inicia servidor de métricas anti-ban (quando habilitado)
 * 2) Inicia servidor HTTP da API REST (quando habilitado)
 * 3) Resolve as conexões de inicialização
 * 4) Garante runtime de cada conexão
 * 5) Dispara conexão inicial via `scheduleReconnect('startup')`
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

  const connectionIds = await resolveStartupConnectionIds()
  if (!connectionIds.length) {
    throw new Error('nenhuma conexão inicial pôde ser resolvida para o boot')
  }
  logger.info('conexões resolvidas para inicialização', { connectionIds, total: connectionIds.length })
  for (const connectionId of connectionIds) {
    getOrCreateRuntime(connectionId)
    await scheduleReconnect(connectionId, 'startup')
  }
}
