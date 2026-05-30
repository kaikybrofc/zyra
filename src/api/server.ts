import { createServer, type Server } from 'node:http'
import { config } from '../config/index.js'
import type { AppLogger } from '../observability/logger.js'
import { parseUrl, sendError } from './http.js'
import { handleConnectionsRoutes } from './routes/connections.js'
import { handleMessagesRoutes } from './routes/messages.js'
import { handleGroupsRoutes } from './routes/groups.js'
import { handleWebhooksRoutes } from './routes/webhooks.js'
import { handleGlobalWebhooksRoutes } from './routes/webhooks-global.js'
import { handleConnectionWebhookRoutes } from './routes/connection-webhook.js'
import { handleRuntimeRoutes } from './routes/runtime.js'
import { handleHealthRoutes } from './routes/health.js'
import { serveDashboard } from './routes/dashboard.js'

/**
 * Opções de inicialização do servidor HTTP da API REST.
 */
type StartApiServerOptions = {
  /** Logger da aplicação. */
  logger: AppLogger
}

/**
 * Handle de ciclo de vida do servidor da API.
 */
type ApiServerHandle = {
  /** Encerra o servidor HTTP. */
  stop: () => Promise<void>
}

/**
 * Inicializa o servidor HTTP da API REST.
 *
 * Endpoints disponíveis:
 * - `POST   /connections`                    — criar instância
 * - `GET    /connections`                    — listar instâncias
 * - `GET    /connections/:id`                — detalhes de uma instância
 * - `PATCH  /connections/:id`                — atualizar label
 * - `DELETE /connections/:id`                — deletar instância
 * - `POST   /connections/:id/connect`        — conectar (gera QR)
 * - `POST   /connections/:id/start`          — alias de conectar
 * - `POST   /connections/:id/disconnect`     — desconectar
 * - `POST   /connections/:id/restart`        — reiniciar conexão
 * - `POST   /connections/:id/reconnect`      — alias de reiniciar conexão
 * - `POST   /connections/:id/pairing/start`  — iniciar pairing remoto
 * - `POST   /connections/:id/pairing/cancel` — cancelar pairing remoto
 * - `GET    /connections/:id/pairing`        — consultar estado do pairing
 * - `GET    /connections/:id/status`         — verificar status
 * - `GET    /connections/:id/qr`             — obter QR code atual
 * - `POST   /connections/:id/webhook/start`  — iniciar conexão via webhook assinado
 * - `POST   /connections/:id/messages/send`  — enviar mensagem
 * - `GET    /connections/:id/groups`         — listar grupos
 * - `GET    /system/runtime`                  — status operacional do processo
 * - `GET    /health/live`                    — liveness do processo
 * - `GET    /health/ready`                   — readiness (infra/control-plane)
 * - `GET    /health/connections`             — resumo de estados por conexão
 * - `POST   /webhooks/connections`           — ingress de comando assinado (HMAC)
 */
export const startApiServer = ({ logger }: StartApiServerOptions): ApiServerHandle => {
  const server: Server = createServer(async (req, res) => {
    const url = parseUrl(req)
    const pathname = url.pathname

    // Dashboard served before auth — auth is handled client-side by the page
    if (pathname === '/' || pathname === '/dashboard') {
      serveDashboard(req, res)
      return
    }

    // Webhook de controle usa autenticação HMAC própria e não depende de Bearer da API.
    if (await handleConnectionWebhookRoutes(req, res, pathname, logger)) return
    // Health checks operacionais para orquestradores (liveness/readiness).
    if (await handleHealthRoutes(req, res, pathname, logger)) return

    const apiKey = config.apiKey
    if (apiKey) {
      const auth = req.headers['authorization'] ?? ''
      if (auth !== `Bearer ${apiKey}`) {
        res.statusCode = 401
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'não autorizado' }))
        return
      }
    }

    try {
      if (await handleConnectionsRoutes(req, res, pathname, logger)) return
      if (await handleMessagesRoutes(req, res, pathname, logger)) return
      if (await handleGroupsRoutes(req, res, pathname, logger)) return
      if (await handleRuntimeRoutes(req, res, pathname)) return
      if (await handleGlobalWebhooksRoutes(req, res, pathname, logger)) return
      if (await handleWebhooksRoutes(req, res, pathname, logger)) return

      sendError(res, 404, 'rota não encontrada')
    } catch (error) {
      logger.error('erro interno no servidor da API', { err: error, method: req.method, pathname })
      if (!res.headersSent) {
        sendError(res, 500, 'erro interno do servidor')
      }
    }
  })

  server.listen(config.apiPort, config.apiHost, () => {
    logger.info('servidor HTTP da API REST iniciado', {
      host: config.apiHost,
      port: config.apiPort,
    })
  })

  return {
    stop: () =>
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
