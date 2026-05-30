import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createMetricsHandler } from 'baileys-antiban'
import { config } from '../config/index.js'
import type { AppLogger } from './logger.js'

/**
 * Snapshot operacional agregado para inspeção rápida do runtime.
 */
type OperationalSnapshot = {
  connectionId?: string | null
  socketActive?: boolean
  reconnectInFlight?: boolean
  socketGeneration?: number
  lastReconnectAtMs?: number
  nodeUptimeSeconds?: number
  processUptimeSeconds?: number
  rssBytes?: number
  heapUsedBytes?: number
  heapTotalBytes?: number
  externalBytes?: number
  arrayBuffersBytes?: number
  antibanEnabled?: boolean
  metricsEnabled?: boolean
}

type OperationalSnapshotProvider = () => OperationalSnapshot[]

/**
 * Opções para inicialização do servidor de métricas do anti-ban.
 */
type StartAntiBanMetricsServerOptions = {
  /** Logger de aplicação para eventos de boot/erro do endpoint. */
  logger: AppLogger
  /** Provedor de estatísticas nativas do `baileys-antiban`. */
  getStats: () => unknown
  /** Provedor de estatísticas anti-ban por conexão para ambientes multi-conexão. */
  getStatsByConnection?: () => Record<string, unknown>
  /** Provedor de snapshots operacionais adicionais do runtime. */
  getOperationalSnapshots?: OperationalSnapshotProvider
}

/**
 * Handle de ciclo de vida do servidor de métricas.
 */
type MetricsServerHandle = {
  /** Encerra o servidor HTTP de métricas. */
  stop: () => Promise<void>
}

/**
 * Responde 404 padronizado para rotas não reconhecidas.
 */
const notFound = (res: ServerResponse) => {
  res.statusCode = 404
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end('not found')
}

/**
 * Verifica se a requisição aponta para o endpoint principal de métricas.
 */
const isMetricsPath = (req: IncomingMessage): boolean => {
  const url = req.url ?? ''
  const pathOnly = url.split('?')[0] ?? ''
  return pathOnly === config.antibanMetricsPath
}

/**
 * Verifica se a requisição aponta para o endpoint complementar de operação.
 */
const isOpsPath = (req: IncomingMessage): boolean => {
  const url = req.url ?? ''
  const pathOnly = url.split('?')[0] ?? ''
  return pathOnly === `${config.antibanMetricsPath}/ops`
}

/**
 * Faz parse resiliente da URL recebida no servidor HTTP nativo.
 */
const parseRequestUrl = (req: IncomingMessage): URL => {
  const raw = req.url ?? config.antibanMetricsPath
  return new URL(raw, 'http://localhost')
}

/**
 * Escapa valores de label Prometheus.
 */
const escapeLabel = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/**
 * Converte número possivelmente inválido em `undefined`.
 */
const asFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number') return undefined
  return Number.isFinite(value) ? value : undefined
}

/**
 * Coleta snapshot operacional com fallback seguro e metadados básicos de processo.
 */
const buildOperationalSnapshots = (provider?: OperationalSnapshotProvider): OperationalSnapshot[] => {
  const memory = process.memoryUsage()
  const base = {
    antibanEnabled: config.antibanEnabled,
    metricsEnabled: config.antibanMetricsEnabled,
    nodeUptimeSeconds: Math.max(0, process.uptime()),
    processUptimeSeconds: Math.max(0, process.uptime()),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  }
  const provided = provider?.() ?? []
  if (!provided.length) {
    return [{ ...base }]
  }
  return provided.map((external) => ({
    ...base,
    ...external,
    antibanEnabled: external.antibanEnabled ?? base.antibanEnabled,
    metricsEnabled: external.metricsEnabled ?? base.metricsEnabled,
    nodeUptimeSeconds: external.nodeUptimeSeconds ?? base.nodeUptimeSeconds,
    processUptimeSeconds: external.processUptimeSeconds ?? base.processUptimeSeconds,
    rssBytes: external.rssBytes ?? base.rssBytes,
    heapUsedBytes: external.heapUsedBytes ?? base.heapUsedBytes,
    heapTotalBytes: external.heapTotalBytes ?? base.heapTotalBytes,
    externalBytes: external.externalBytes ?? base.externalBytes,
    arrayBuffersBytes: external.arrayBuffersBytes ?? base.arrayBuffersBytes,
  }))
}

/**
 * Renderiza métricas operacionais extras no formato Prometheus.
 */
const renderOperationalPrometheus = (snapshots: OperationalSnapshot[]): string => {
  const lines: string[] = ['# HELP zyra_antiban_enabled Anti-ban habilitado (1=true, 0=false).', '# TYPE zyra_antiban_enabled gauge', '# HELP zyra_antiban_metrics_enabled Endpoint de metricas anti-ban habilitado (1=true, 0=false).', '# TYPE zyra_antiban_metrics_enabled gauge', '# HELP zyra_antiban_socket_active Socket ativo no runtime (1=true, 0=false).', '# TYPE zyra_antiban_socket_active gauge', '# HELP zyra_antiban_reconnect_in_flight Reconnect em andamento (1=true, 0=false).', '# TYPE zyra_antiban_reconnect_in_flight gauge']

  for (const snapshot of snapshots) {
    const connectionId = snapshot.connectionId ? escapeLabel(snapshot.connectionId) : 'default'
    lines.push(`zyra_antiban_enabled{connection_id="${connectionId}"} ${snapshot.antibanEnabled ? 1 : 0}`)
    lines.push(`zyra_antiban_metrics_enabled{connection_id="${connectionId}"} ${snapshot.metricsEnabled ? 1 : 0}`)
    lines.push(`zyra_antiban_socket_active{connection_id="${connectionId}"} ${snapshot.socketActive ? 1 : 0}`)
    lines.push(`zyra_antiban_reconnect_in_flight{connection_id="${connectionId}"} ${snapshot.reconnectInFlight ? 1 : 0}`)

    const optionalMetrics: Array<{ name: string; value: unknown }> = [
      { name: 'zyra_antiban_socket_generation', value: snapshot.socketGeneration },
      { name: 'zyra_antiban_last_reconnect_at_ms', value: snapshot.lastReconnectAtMs },
      { name: 'zyra_process_uptime_seconds', value: snapshot.processUptimeSeconds },
      { name: 'zyra_node_uptime_seconds', value: snapshot.nodeUptimeSeconds },
      { name: 'zyra_process_memory_rss_bytes', value: snapshot.rssBytes },
      { name: 'zyra_process_memory_heap_used_bytes', value: snapshot.heapUsedBytes },
      { name: 'zyra_process_memory_heap_total_bytes', value: snapshot.heapTotalBytes },
      { name: 'zyra_process_memory_external_bytes', value: snapshot.externalBytes },
      { name: 'zyra_process_memory_array_buffers_bytes', value: snapshot.arrayBuffersBytes },
    ]

    for (const metric of optionalMetrics) {
      const value = asFiniteNumber(metric.value)
      if (value === undefined) continue
      lines.push(`${metric.name}{connection_id="${connectionId}"} ${value}`)
    }
  }

  return `${lines.join('\n')}\n`
}

/**
 * Inicializa o endpoint de métricas do anti-ban.
 *
 * Endpoints:
 * - `${WA_ANTIBAN_METRICS_PATH}`: métricas padrão do `baileys-antiban`
 * - `${WA_ANTIBAN_METRICS_PATH}?format=json`: payload JSON com stats + snapshot operacional
 * - `${WA_ANTIBAN_METRICS_PATH}/ops`: métricas operacionais extras (Prometheus)
 */
export const startAntiBanMetricsServer = ({ logger, getStats, getStatsByConnection, getOperationalSnapshots }: StartAntiBanMetricsServerOptions): MetricsServerHandle => {
  if (!config.antibanEnabled || !config.antibanMetricsEnabled) {
    return {
      stop: async () => undefined,
    }
  }

  const metrics = createMetricsHandler(() => getStats() as Parameters<typeof createMetricsHandler>[0] extends () => infer T ? T : never)
  const server: Server = createServer(async (req, res) => {
    if (isOpsPath(req)) {
      const snapshots = buildOperationalSnapshots(getOperationalSnapshots)
      res.statusCode = 200
      res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      res.end(renderOperationalPrometheus(snapshots))
      return
    }

    if (!isMetricsPath(req)) {
      notFound(res)
      return
    }

    const url = parseRequestUrl(req)
    if (url.searchParams.get('format') === 'json' || url.searchParams.get('details') === '1') {
      const payload = {
        generatedAt: new Date().toISOString(),
        stats: getStats(),
        statsByConnection: getStatsByConnection?.() ?? {},
        operations: buildOperationalSnapshots(getOperationalSnapshots),
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(payload))
      return
    }

    try {
      await metrics.handle(req, res)
    } catch (error) {
      logger.error('falha ao renderizar metricas do antiban', { err: error })
      res.statusCode = 500
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end('internal server error')
    }
  })

  server.listen(config.antibanMetricsPort, config.antibanMetricsHost, () => {
    logger.info('endpoint de metricas do antiban iniciado', {
      host: config.antibanMetricsHost,
      port: config.antibanMetricsPort,
      path: config.antibanMetricsPath,
      opsPath: `${config.antibanMetricsPath}/ops`,
    })
  })

  return {
    stop: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      }),
  }
}
