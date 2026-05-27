import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppLogger } from '../../observability/logger.js'
import { config } from '../../config/index.js'
import {
  createConnection,
  getConnection,
  connect,
  restart,
  disconnect,
  pause,
  resume,
  deleteConnection,
  setConnectionLabel,
} from '../../core/connection/manager.js'
import { startPairing, cancelPairing } from '../../core/connection/pairing-service.js'
import {
  BodyTooLargeError,
  matchRoute,
  parseJson,
  readBody,
  sendError,
  sendJson,
} from '../http.js'
import {
  finishWebhookCommand,
  getWebhookCommand,
  saveWebhookCommandReceived,
} from '../../store/connection-admin-store.js'

type CommandActionType =
  | 'register'
  | 'start'
  | 'reconnect'
  | 'disconnect'
  | 'pause'
  | 'resume'
  | 'delete_soft'
  | 'delete_hard'
  | 'sync_status'
  | 'pairing_start'
  | 'pairing_cancel'

type ConnectionCommandPayload = {
  event: string
  version?: string
  command_id?: string
  sent_at?: string
  connection?: {
    id?: string
    display_name?: string | null
  }
  action?: {
    type?: string
    reason?: string
  }
  options?: {
    force?: boolean
  }
  metadata?: Record<string, unknown>
}

type CommandResponse = {
  ok: boolean
  command_id: string
  connection_id: string
  accepted: boolean
  action: string
  current_state: string | null
  desired_state: 'running' | 'stopped' | 'paused' | 'deleted'
  reason?: string
}

const COMMAND_ACTIONS: ReadonlySet<string> = new Set([
  'register',
  'start',
  'reconnect',
  'disconnect',
  'pause',
  'resume',
  'delete_soft',
  'delete_hard',
  'sync_status',
  'pairing_start',
  'pairing_cancel',
])

const normalizeSignature = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.startsWith('sha256=')) return trimmed.slice('sha256='.length)
  return trimmed
}

const isValidSignature = (secret: string, timestamp: string, body: string, provided: string): boolean => {
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')
  const normalized = normalizeSignature(provided)
  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(normalized)
  if (expectedBuffer.length !== providedBuffer.length) return false
  return timingSafeEqual(expectedBuffer, providedBuffer)
}

const toTimestampMs = (value: string): number | null => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  if (parsed <= 0) return null
  if (parsed < 1_000_000_000_000) return Math.trunc(parsed * 1000)
  return Math.trunc(parsed)
}

const resolveDesiredState = (action: CommandActionType): CommandResponse['desired_state'] => {
  if (action === 'pause') return 'paused'
  if (action === 'disconnect') return 'stopped'
  if (action === 'pairing_cancel') return 'stopped'
  if (action === 'delete_soft' || action === 'delete_hard') return 'deleted'
  return 'running'
}

const ensureConnectionExists = (connectionId: string): { created: boolean } => {
  const existing = getConnection(connectionId)
  if (existing) return { created: false }
  createConnection(connectionId)
  return { created: true }
}

const requireJsonContentType = (req: IncomingMessage): boolean => {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
  return contentType.includes('application/json')
}

const invalidResponse = (
  commandId: string,
  connectionId: string,
  action: string,
  reason: string
): CommandResponse => ({
  ok: false,
  command_id: commandId,
  connection_id: connectionId,
  accepted: false,
  action,
  current_state: getConnection(connectionId)?.status ?? null,
  desired_state: 'running',
  reason,
})

const finalizeAndReply = async (
  commandId: string,
  response: CommandResponse,
  result: { status: 'accepted' | 'rejected' | 'failed'; httpStatus: number },
  res: ServerResponse
) => {
  await finishWebhookCommand(commandId, {
    status: result.status,
    response,
  })
  sendJson(res, result.httpStatus, response)
}

/**
 * Ingress de comandos administrativos de conexão via webhook autenticado por HMAC.
 */
export async function handleConnectionWebhookRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  logger: AppLogger
): Promise<boolean> {
  if (!matchRoute('/webhooks/connections', pathname)) return false

  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, 405, 'método não permitido')
    return true
  }

  if (!requireJsonContentType(req)) {
    sendError(res, 415, 'content-type deve ser application/json')
    return true
  }

  const sharedSecret = config.webhookSharedSecret?.trim() ?? ''
  if (!sharedSecret) {
    sendError(res, 503, 'webhook de conexões indisponível: segredo não configurado')
    return true
  }

  const timestampHeader = String(req.headers['x-zyra-timestamp'] ?? '').trim()
  const signatureHeader = String(req.headers['x-zyra-signature'] ?? '').trim()
  const deliveryId = String(req.headers['x-zyra-delivery-id'] ?? '').trim()

  if (!timestampHeader || !signatureHeader || !deliveryId) {
    sendError(res, 401, 'headers de autenticação do webhook ausentes')
    return true
  }

  const timestampMs = toTimestampMs(timestampHeader)
  if (!timestampMs) {
    sendError(res, 401, 'x-zyra-timestamp inválido')
    return true
  }

  const now = Date.now()
  if (Math.abs(now - timestampMs) > config.webhookTimestampToleranceMs) {
    sendError(res, 401, 'x-zyra-timestamp fora da janela permitida')
    return true
  }

  let rawBody = ''
  try {
    rawBody = await readBody(req, { maxBytes: config.webhookMaxBodyBytes })
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendError(res, 413, 'payload maior que o limite permitido')
      return true
    }
    throw error
  }

  if (!isValidSignature(sharedSecret, timestampHeader, rawBody, signatureHeader)) {
    sendError(res, 401, 'assinatura HMAC inválida')
    return true
  }

  const payload = parseJson<ConnectionCommandPayload>(rawBody)
  if (!payload || typeof payload !== 'object') {
    sendError(res, 400, 'payload inválido')
    return true
  }

  const commandId = String(payload.command_id ?? '').trim()
  const connectionId = String(payload.connection?.id ?? '').trim()
  const action = String(payload.action?.type ?? '').trim()

  if (payload.event !== 'connection.command') {
    sendError(res, 400, 'event deve ser connection.command')
    return true
  }
  if (!commandId) {
    sendError(res, 400, 'command_id é obrigatório')
    return true
  }
  if (!connectionId) {
    sendError(res, 400, 'connection.id é obrigatório')
    return true
  }
  const isKnownAction = action.length > 0 && COMMAND_ACTIONS.has(action)

  const duplicate = await getWebhookCommand(commandId)
  if (duplicate) {
    if (duplicate.response && typeof duplicate.response === 'object') {
      sendJson(res, 200, { ...duplicate.response, duplicate: true })
    } else {
      sendJson(res, 409, {
        ok: false,
        command_id: commandId,
        connection_id: connectionId,
        accepted: false,
        action,
        current_state: getConnection(connectionId)?.status ?? null,
        desired_state: resolveDesiredState(action as CommandActionType),
        reason: 'comando já recebido e ainda em processamento',
      })
    }
    return true
  }

  const received = await saveWebhookCommandReceived({
    commandId,
    connectionId,
    deliveryId,
    actionType: action || 'unknown',
    payload,
  })
  if (!received.created && received.record.response && typeof received.record.response === 'object') {
    sendJson(res, 200, { ...received.record.response, duplicate: true })
    return true
  }
  if (!received.created) {
    sendJson(res, 409, {
      ok: false,
      command_id: commandId,
      connection_id: connectionId,
      accepted: false,
      action,
      current_state: getConnection(connectionId)?.status ?? null,
      desired_state: resolveDesiredState(action as CommandActionType),
      reason: 'comando duplicado e ainda sem resposta final',
    })
    return true
  }

  if (!isKnownAction) {
    const rejected = invalidResponse(commandId, connectionId, action || 'unknown', 'action.type inválido')
    await finalizeAndReply(commandId, rejected, { status: 'rejected', httpStatus: 422 }, res)
    return true
  }

  const actionType = action as CommandActionType
  const desiredState = resolveDesiredState(actionType)

  try {
    if (actionType === 'register') {
      ensureConnectionExists(connectionId)
      if (payload.connection?.display_name !== undefined) {
        setConnectionLabel(connectionId, payload.connection.display_name ?? null)
      }
    } else if (actionType === 'start') {
      ensureConnectionExists(connectionId)
      await connect(connectionId, logger)
    } else if (actionType === 'reconnect') {
      ensureConnectionExists(connectionId)
      await restart(connectionId, logger)
    } else if (actionType === 'disconnect') {
      ensureConnectionExists(connectionId)
      await disconnect(connectionId, logger)
    } else if (actionType === 'pause') {
      ensureConnectionExists(connectionId)
      await pause(connectionId, logger)
    } else if (actionType === 'resume') {
      ensureConnectionExists(connectionId)
      await resume(connectionId, logger)
    } else if (actionType === 'pairing_start') {
      ensureConnectionExists(connectionId)
      await startPairing(connectionId)
    } else if (actionType === 'pairing_cancel') {
      ensureConnectionExists(connectionId)
      await cancelPairing(connectionId)
    } else if (actionType === 'delete_soft' || actionType === 'delete_hard') {
      if (!getConnection(connectionId)) {
        const response: CommandResponse = invalidResponse(commandId, connectionId, action, 'conexão não encontrada')
        await finalizeAndReply(commandId, response, { status: 'rejected', httpStatus: 404 }, res)
        return true
      }
      await deleteConnection(connectionId, logger)
    } else if (actionType === 'sync_status') {
      // no-op, apenas devolve status atual
    }

    const state = getConnection(connectionId)
    const response: CommandResponse = {
      ok: true,
      command_id: commandId,
      connection_id: connectionId,
      accepted: true,
      action,
      current_state: state?.status ?? null,
      desired_state: desiredState,
    }
    await finalizeAndReply(commandId, response, { status: 'accepted', httpStatus: 200 }, res)
    return true
  } catch (error) {
    logger.error('falha ao processar webhook de comando de conexão', {
      err: error,
      commandId,
      connectionId,
      action,
    })
    const response: CommandResponse = {
      ok: false,
      command_id: commandId,
      connection_id: connectionId,
      accepted: false,
      action,
      current_state: getConnection(connectionId)?.status ?? null,
      desired_state: desiredState,
      reason: 'erro interno ao processar comando',
    }
    await finalizeAndReply(commandId, response, { status: 'failed', httpStatus: 500 }, res)
    return true
  }
}
