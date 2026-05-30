import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppLogger } from '../../observability/logger.js'
import { readBody, parseJson, sendJson, sendError, matchRoute } from '../http.js'
import { createWebhook, listWebhooks, getWebhook, updateWebhook, deleteWebhook, listDeliveries, retryDelivery, getDelivery, GLOBAL_WEBHOOK_CONNECTION_ID } from '../../webhook/store.js'
import { attemptDelivery } from '../../webhook/delivery.js'
import { resolveAllowedWebhookTarget } from '../../webhook/url-validation.js'

const G = GLOBAL_WEBHOOK_CONNECTION_ID

type CreateWebhookBody = {
  url: string
  eventsFilter: string[]
  secret?: string | null
}

type UpdateWebhookBody = {
  url?: string
  eventsFilter?: string[]
  active?: boolean
  secret?: string | null
}

/**
 * Trata requisições HTTP para gerenciamento de webhooks globais (todas as instâncias).
 * Retorna `true` se a rota foi reconhecida e tratada, `false` caso contrário.
 */
export async function handleGlobalWebhooksRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, logger: AppLogger): Promise<boolean> {
  const method = req.method ?? 'GET'

  // GET/POST /webhooks
  if (matchRoute('/webhooks', pathname)) {
    if (method === 'GET') {
      const items = await listWebhooks(G)
      sendJson(res, 200, items)
      return true
    }

    if (method === 'POST') {
      const body = parseJson<CreateWebhookBody>(await readBody(req))
      if (!body) {
        sendError(res, 400, 'corpo da requisição inválido')
        return true
      }
      if (typeof body.url !== 'string' || !body.url.trim()) {
        sendError(res, 400, 'campo url é obrigatório')
        return true
      }
      if (!Array.isArray(body.eventsFilter) || !body.eventsFilter.length) {
        sendError(res, 400, 'campo eventsFilter deve ser um array não-vazio')
        return true
      }
      const resolvedTarget = resolveAllowedWebhookTarget(body.url)
      if (!resolvedTarget.ok) {
        sendError(res, 400, resolvedTarget.reason)
        return true
      }
      try {
        const webhook = await createWebhook(G, {
          url: resolvedTarget.targetUrl,
          eventsFilter: body.eventsFilter,
          secret: body.secret ?? null,
        })
        sendJson(res, 201, webhook)
      } catch (error) {
        logger.error('falha ao criar webhook global', { err: error })
        sendError(res, 500, 'falha ao criar webhook global')
      }
      return true
    }
  }

  // GET/PATCH/DELETE /webhooks/:webhookId
  const webhookMatch = matchRoute('/webhooks/:webhookId', pathname)
  if (webhookMatch) {
    const webhookId = webhookMatch.params['webhookId'] ?? ''

    if (method === 'GET') {
      const webhook = await getWebhook(webhookId, G)
      if (!webhook) {
        sendError(res, 404, 'webhook não encontrado')
        return true
      }
      sendJson(res, 200, webhook)
      return true
    }

    if (method === 'PATCH') {
      const body = parseJson<UpdateWebhookBody>(await readBody(req))
      if (!body) {
        sendError(res, 400, 'corpo da requisição inválido')
        return true
      }
      if (body.url !== undefined) {
        if (typeof body.url !== 'string') {
          sendError(res, 400, 'campo url inválido')
          return true
        }
        const resolvedTarget = resolveAllowedWebhookTarget(body.url)
        if (!resolvedTarget.ok) {
          sendError(res, 400, resolvedTarget.reason)
          return true
        }
        body.url = resolvedTarget.targetUrl
      }
      const updated = await updateWebhook(webhookId, G, body)
      if (!updated) {
        sendError(res, 404, 'webhook não encontrado')
        return true
      }
      sendJson(res, 200, updated)
      return true
    }

    if (method === 'DELETE') {
      const deleted = await deleteWebhook(webhookId, G)
      if (!deleted) {
        sendError(res, 404, 'webhook não encontrado')
        return true
      }
      res.statusCode = 204
      res.end()
      return true
    }
  }

  // GET /webhooks/:webhookId/deliveries
  const deliveriesMatch = matchRoute('/webhooks/:webhookId/deliveries', pathname)
  if (method === 'GET' && deliveriesMatch) {
    const webhookId = deliveriesMatch.params['webhookId'] ?? ''
    const webhook = await getWebhook(webhookId, G)
    if (!webhook) {
      sendError(res, 404, 'webhook não encontrado')
      return true
    }
    const items = await listDeliveries(webhookId)
    sendJson(res, 200, items)
    return true
  }

  // POST /webhooks/:webhookId/deliveries/:deliveryId/retry
  const retryMatch = matchRoute('/webhooks/:webhookId/deliveries/:deliveryId/retry', pathname)
  if (method === 'POST' && retryMatch) {
    const webhookId = retryMatch.params['webhookId'] ?? ''
    const deliveryId = retryMatch.params['deliveryId'] ?? ''

    const webhook = await getWebhook(webhookId, G)
    if (!webhook) {
      sendError(res, 404, 'webhook não encontrado')
      return true
    }

    const delivery = await retryDelivery(deliveryId)
    if (!delivery || delivery.webhookId !== webhookId) {
      sendError(res, 404, 'entrega não encontrada')
      return true
    }

    try {
      await attemptDelivery(delivery, webhook)
      const updated = getDelivery(deliveryId)
      sendJson(res, 200, updated ?? delivery)
    } catch (error) {
      logger.error('falha ao retentar entrega de webhook global', { err: error, deliveryId })
      sendError(res, 500, 'falha ao retentar entrega')
    }
    return true
  }

  return false
}
