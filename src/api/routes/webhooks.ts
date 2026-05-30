import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppLogger } from '../../observability/logger.js'
import { readBody, parseJson, sendJson, sendError, matchRoute } from '../http.js'
import { createWebhook, listWebhooks, getWebhook, updateWebhook, deleteWebhook, listDeliveries, retryDelivery, getDelivery } from '../../webhook/store.js'
import { attemptDelivery } from '../../webhook/delivery.js'
import { resolveAllowedWebhookTarget } from '../../webhook/url-validation.js'

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
 * Trata requisições HTTP para gerenciamento de webhooks.
 * Retorna `true` se a rota foi reconhecida e tratada, `false` caso contrário.
 */
export async function handleWebhooksRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, logger: AppLogger): Promise<boolean> {
  const method = req.method ?? 'GET'

  // POST /connections/:id/webhooks
  const listCreateMatch = matchRoute('/connections/:id/webhooks', pathname)
  if (listCreateMatch) {
    const connectionId = listCreateMatch.params['id'] ?? ''

    if (method === 'GET') {
      const items = await listWebhooks(connectionId)
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
        const webhook = await createWebhook(connectionId, {
          url: resolvedTarget.targetUrl,
          eventsFilter: body.eventsFilter,
          secret: body.secret ?? null,
        })
        sendJson(res, 201, webhook)
      } catch (error) {
        logger.error('falha ao criar webhook', { err: error, connectionId })
        sendError(res, 500, 'falha ao criar webhook')
      }
      return true
    }
  }

  // GET/PATCH/DELETE /connections/:id/webhooks/:webhookId
  const webhookMatch = matchRoute('/connections/:id/webhooks/:webhookId', pathname)
  if (webhookMatch) {
    const connectionId = webhookMatch.params['id'] ?? ''
    const webhookId = webhookMatch.params['webhookId'] ?? ''

    if (method === 'GET') {
      const webhook = await getWebhook(webhookId, connectionId)
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
      const updated = await updateWebhook(webhookId, connectionId, body)
      if (!updated) {
        sendError(res, 404, 'webhook não encontrado')
        return true
      }
      sendJson(res, 200, updated)
      return true
    }

    if (method === 'DELETE') {
      const deleted = await deleteWebhook(webhookId, connectionId)
      if (!deleted) {
        sendError(res, 404, 'webhook não encontrado')
        return true
      }
      res.statusCode = 204
      res.end()
      return true
    }
  }

  // GET /connections/:id/webhooks/:webhookId/deliveries
  const deliveriesMatch = matchRoute('/connections/:id/webhooks/:webhookId/deliveries', pathname)
  if (method === 'GET' && deliveriesMatch) {
    const connectionId = deliveriesMatch.params['id'] ?? ''
    const webhookId = deliveriesMatch.params['webhookId'] ?? ''
    const webhook = await getWebhook(webhookId, connectionId)
    if (!webhook) {
      sendError(res, 404, 'webhook não encontrado')
      return true
    }
    const items = await listDeliveries(webhookId)
    sendJson(res, 200, items)
    return true
  }

  // POST /connections/:id/webhooks/:webhookId/deliveries/:deliveryId/retry
  const retryMatch = matchRoute('/connections/:id/webhooks/:webhookId/deliveries/:deliveryId/retry', pathname)
  if (method === 'POST' && retryMatch) {
    const connectionId = retryMatch.params['id'] ?? ''
    const webhookId = retryMatch.params['webhookId'] ?? ''
    const deliveryId = retryMatch.params['deliveryId'] ?? ''

    const webhook = await getWebhook(webhookId, connectionId)
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
      logger.error('falha ao retentar entrega de webhook', { err: error, deliveryId })
      sendError(res, 500, 'falha ao retentar entrega')
    }
    return true
  }

  return false
}
