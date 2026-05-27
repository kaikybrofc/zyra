import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppLogger } from '../../observability/logger.js'
import {
  createConnection,
  listConnections,
  getConnection,
  setConnectionLabel,
  connect,
  disconnect,
  restart,
  deleteConnection,
} from '../../core/connection/manager.js'
import { startPairing, getPairingState, cancelPairing } from '../../core/connection/pairing-service.js'
import { readBody, parseJson, sendJson, sendError, matchRoute } from '../http.js'

/**
 * Trata requisições HTTP para os endpoints de gerenciamento de conexões.
 * Retorna `true` se a rota foi reconhecida e tratada, `false` caso contrário.
 */
export async function handleConnectionsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  logger: AppLogger
): Promise<boolean> {
  const method = req.method ?? 'GET'

  // GET /connections
  if (method === 'GET' && pathname === '/connections') {
    sendJson(res, 200, listConnections())
    return true
  }

  // POST /connections — cria entrada sem conectar
  if (method === 'POST' && pathname === '/connections') {
    const body = parseJson<{ connectionId?: string }>(await readBody(req))
    const id = body?.connectionId?.trim()
    if (!id) {
      sendError(res, 400, 'connectionId é obrigatório')
      return true
    }
    if (getConnection(id)) {
      sendError(res, 409, 'connectionId já existe')
      return true
    }
    sendJson(res, 201, createConnection(id))
    return true
  }

  // GET /connections/:id
  const single = matchRoute('/connections/:id', pathname)
  if (method === 'GET' && single) {
    const info = getConnection(single.params['id'] ?? '')
    if (!info) { sendError(res, 404, 'conexão não encontrada'); return true }
    sendJson(res, 200, info)
    return true
  }

  // PATCH /connections/:id — atualiza label
  if (method === 'PATCH' && single) {
    const id = single.params['id'] ?? ''
    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    const body = parseJson<{ label?: string | null }>(await readBody(req))
    if (body && 'label' in body) setConnectionLabel(id, body.label ?? null)
    sendJson(res, 200, getConnection(id))
    return true
  }

  // DELETE /connections/:id
  if (method === 'DELETE' && single) {
    const id = single.params['id'] ?? ''
    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    await deleteConnection(id, logger)
    res.statusCode = 204
    res.end()
    return true
  }

  // POST /connections/:id/connect
  const connectMatch = matchRoute('/connections/:id/connect', pathname)
  if (method === 'POST' && connectMatch) {
    const id = connectMatch.params['id'] ?? ''
    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    await connect(id, logger)
    sendJson(res, 200, getConnection(id))
    return true
  }

  // POST /connections/:id/disconnect
  const disconnectMatch = matchRoute('/connections/:id/disconnect', pathname)
  if (method === 'POST' && disconnectMatch) {
    const id = disconnectMatch.params['id'] ?? ''
    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    await disconnect(id, logger)
    sendJson(res, 200, getConnection(id))
    return true
  }

  // POST /connections/:id/restart
  const restartMatch = matchRoute('/connections/:id/restart', pathname)
  if (method === 'POST' && restartMatch) {
    const id = restartMatch.params['id'] ?? ''
    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    await restart(id, logger)
    sendJson(res, 200, getConnection(id))
    return true
  }

  // POST /connections/:id/pairing/start
  const pairingStartMatch = matchRoute('/connections/:id/pairing/start', pathname)
  if (method === 'POST' && pairingStartMatch) {
    const id = pairingStartMatch.params['id'] ?? ''
    if (!getConnection(id)) {
      createConnection(id)
    }
    const state = await startPairing(id)
    sendJson(res, 202, state)
    return true
  }

  // POST /connections/:id/pairing/cancel
  const pairingCancelMatch = matchRoute('/connections/:id/pairing/cancel', pathname)
  if (method === 'POST' && pairingCancelMatch) {
    const id = pairingCancelMatch.params['id'] ?? ''
    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    const state = await cancelPairing(id)
    sendJson(res, 200, state)
    return true
  }

  // GET /connections/:id/pairing
  const pairingGetMatch = matchRoute('/connections/:id/pairing', pathname)
  if (method === 'GET' && pairingGetMatch) {
    const id = pairingGetMatch.params['id'] ?? ''
    if (!getConnection(id)) { sendError(res, 404, 'conexão não encontrada'); return true }
    const state = await getPairingState(id)
    sendJson(res, 200, state)
    return true
  }

  // GET /connections/:id/status
  const statusMatch = matchRoute('/connections/:id/status', pathname)
  if (method === 'GET' && statusMatch) {
    const info = getConnection(statusMatch.params['id'] ?? '')
    if (!info) { sendError(res, 404, 'conexão não encontrada'); return true }
    sendJson(res, 200, { connectionId: info.connectionId, status: info.status, socketActive: info.socketActive })
    return true
  }

  // GET /connections/:id/qr
  const qrMatch = matchRoute('/connections/:id/qr', pathname)
  if (method === 'GET' && qrMatch) {
    const info = getConnection(qrMatch.params['id'] ?? '')
    if (!info) { sendError(res, 404, 'conexão não encontrada'); return true }
    if (!info.qrCode) { sendError(res, 404, 'QR code não disponível'); return true }
    sendJson(res, 200, { connectionId: info.connectionId, qrCode: info.qrCode, qrCodeAt: info.qrCodeAt })
    return true
  }

  return false
}
