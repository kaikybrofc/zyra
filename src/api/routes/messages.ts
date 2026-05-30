import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppLogger } from '../../observability/logger.js'
import { getConnection, getActiveSocket } from '../../core/connection/manager.js'
import { readBody, parseJson, sendJson, sendError, matchRoute } from '../http.js'

type SendTextPayload = {
  type: 'text'
  to: string
  text: string
}

type SendMediaPayload = {
  type: 'image' | 'video' | 'audio' | 'document'
  to: string
  url: string
  caption?: string
  fileName?: string
  mimetype?: string
}

type SendMessagePayload = SendTextPayload | SendMediaPayload

/**
 * Trata requisições HTTP para envio de mensagens via uma instância conectada.
 * Retorna `true` se a rota foi reconhecida e tratada, `false` caso contrário.
 */
export async function handleMessagesRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, logger: AppLogger): Promise<boolean> {
  const method = req.method ?? 'GET'

  // POST /connections/:id/messages/send
  const sendMatch = matchRoute('/connections/:id/messages/send', pathname)
  if (method === 'POST' && sendMatch) {
    const connectionId = sendMatch.params['id'] ?? ''
    const info = getConnection(connectionId)
    if (!info) {
      sendError(res, 404, 'conexão não encontrada')
      return true
    }
    if (info.status !== 'open') {
      sendError(res, 409, `instância não está conectada (status: ${info.status})`)
      return true
    }

    const sock = getActiveSocket(connectionId)
    if (!sock) {
      sendError(res, 409, 'socket não disponível')
      return true
    }

    const payload = parseJson<SendMessagePayload>(await readBody(req))
    if (!payload) {
      sendError(res, 400, 'corpo da requisição inválido')
      return true
    }
    if (!payload.to?.trim()) {
      sendError(res, 400, 'destinatário (to) é obrigatório')
      return true
    }

    const to = payload.to.trim()

    try {
      let result: unknown

      if (payload.type === 'text') {
        if (!payload.text?.trim()) {
          sendError(res, 400, 'campo text é obrigatório para type=text')
          return true
        }
        result = await sock.sendMessage(to, { text: payload.text })
      } else if (payload.type === 'image') {
        if (!payload.url?.trim()) {
          sendError(res, 400, 'campo url é obrigatório para type=image')
          return true
        }
        result = await sock.sendMessage(to, { image: { url: payload.url }, caption: payload.caption })
      } else if (payload.type === 'video') {
        if (!payload.url?.trim()) {
          sendError(res, 400, 'campo url é obrigatório para type=video')
          return true
        }
        result = await sock.sendMessage(to, { video: { url: payload.url }, caption: payload.caption })
      } else if (payload.type === 'audio') {
        if (!payload.url?.trim()) {
          sendError(res, 400, 'campo url é obrigatório para type=audio')
          return true
        }
        result = await sock.sendMessage(to, { audio: { url: payload.url } })
      } else if (payload.type === 'document') {
        if (!payload.url?.trim()) {
          sendError(res, 400, 'campo url é obrigatório para type=document')
          return true
        }
        result = await sock.sendMessage(to, {
          document: { url: payload.url! },
          mimetype: payload.mimetype ?? 'application/octet-stream',
          ...(payload.fileName !== undefined && { fileName: payload.fileName }),
        })
      } else {
        sendError(res, 400, 'type deve ser: text, image, video, audio ou document')
        return true
      }

      sendJson(res, 200, result ?? null)
    } catch (error) {
      logger.error('falha ao enviar mensagem via API', { err: error, connectionId, to })
      sendError(res, 500, 'falha ao enviar mensagem')
    }

    return true
  }

  return false
}
