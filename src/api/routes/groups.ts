import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppLogger } from '../../observability/logger.js'
import { getConnection, getActiveSocket } from '../../core/connection/manager.js'
import { sendJson, sendError, matchRoute } from '../http.js'

/**
 * Trata requisições HTTP para listagem de grupos de uma instância conectada.
 * Retorna `true` se a rota foi reconhecida e tratada, `false` caso contrário.
 */
export async function handleGroupsRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, logger: AppLogger): Promise<boolean> {
  const method = req.method ?? 'GET'

  // GET /connections/:id/groups
  const groupsMatch = matchRoute('/connections/:id/groups', pathname)
  if (method === 'GET' && groupsMatch) {
    const connectionId = groupsMatch.params['id'] ?? ''
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

    try {
      const groupMap = await sock.groupFetchAllParticipating()
      sendJson(res, 200, groupMap)
    } catch (error) {
      logger.error('falha ao buscar grupos via API', { err: error, connectionId })
      sendError(res, 500, 'falha ao buscar grupos')
    }

    return true
  }

  return false
}
