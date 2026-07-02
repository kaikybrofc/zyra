import { createServer, type Server } from 'node:http'
import process from 'node:process'
import { config } from '../config/index.js'
import type { AppLogger } from '../observability/logger.js'
import { parseUrl, sendError } from './http.js'
import { handleConnectionsRoutes } from './routes/connections.js'
import { handleMessagesRoutes } from './routes/messages.js'
import { handleGroupsRoutes } from './routes/groups.js'
import { handleDataRoutes } from './routes/data.js'
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

const API_PORT_FALLBACK_ATTEMPTS = 20

const isAddressInUseError = (error: unknown): boolean => {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EADDRINUSE'
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
 * - `POST   /connections/:id/pause`          — pausar conexão
 * - `POST   /connections/:id/resume`         — retomar conexão pausada
 * - `POST   /connections/:id/restart`        — reiniciar conexão
 * - `POST   /connections/:id/reconnect`      — alias de reiniciar conexão
 * - `DELETE /connections/:id/hard`           — hard delete com limpeza de sessão
 * - `POST   /connections/:id/pairing/start`  — iniciar pairing remoto
 * - `POST   /connections/:id/pairing/cancel` — cancelar pairing remoto
 * - `GET    /connections/:id/pairing`        — consultar estado do pairing
 * - `GET    /connections/:id/status`         — verificar status
 * - `GET    /connections/:id/diagnostics`    — diagnóstico ampliado da conexão
 * - `GET    /connections/:id/events`         — trilha administrativa da conexão
 * - `GET    /connections/:id/commands`       — comandos webhook recebidos na conexão
 * - `GET    /connections/commands/:commandId` — consultar comando webhook por id
 * - `GET    /connections/:id/qr`             — obter QR code atual
 * - `POST   /connections/:id/webhook/start`  — iniciar conexão via webhook assinado
 * - `POST   /connections/:id/messages/send`  — enviar mensagem
 * - `GET    /connections/:id/messages`       — listar histórico de mensagens enviadas pela API
 * - `GET    /connections/:id/messages/:messageId` — consultar status de mensagem enviada pela API
 * - `POST   /media`                          — fazer upload de mídia para uso via mediaId
 * - `GET    /connections/:id/groups`         — listar grupos
 * - `POST   /connections/:id/groups/:groupJid/admin` — executar ações administrativas de grupo
 * - `GET    /data/messages`                  — consultar mensagens persistidas
 * - `GET    /data/chats`                     — consultar chats persistidos
 * - `GET    /data/contacts`                  — consultar contatos persistidos
 * - `GET    /data/groups`                    — consultar grupos persistidos
 * - `GET    /data/events`                    — consultar eventos persistidos
 * - `GET    /data/commands`                  — consultar comandos executados
 * - `GET    /data/audit`                     — consultar auditoria administrativa
 * - `GET    /data/antiban`                   — consultar estatísticas antiban por conexão
 * - `GET    /data/antiban/:connectionId`     — consultar estatísticas antiban de uma conexão
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
      if (await handleDataRoutes(req, res, pathname, logger)) return
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

  const host = config.apiHost
  const initialPort = config.apiPort
  let port = initialPort
  let fallbackAttempts = 0
  let started = false

  server.on('error', (error) => {
    if (!started && isAddressInUseError(error) && fallbackAttempts < API_PORT_FALLBACK_ATTEMPTS) {
      const occupiedPort = port
      port += 1
      fallbackAttempts += 1
      logger.warn('porta da API REST ocupada; tentando próxima porta disponível', {
        err: error,
        host,
        occupiedPort,
        nextPort: port,
        attempt: fallbackAttempts,
        maxAttempts: API_PORT_FALLBACK_ATTEMPTS,
      })
      server.listen(port, host)
      return
    }

    logger.error('falha ao iniciar servidor HTTP da API REST', {
      err: error,
      host,
      port,
    })
    process.exit(1)
  })

  server.listen(port, host, () => {
    started = true
    process.env.WA_API_PORT = String(port)
    logger.info('servidor HTTP da API REST iniciado', {
      host,
      port,
      requestedPort: initialPort,
      fallback: port !== initialPort,
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
