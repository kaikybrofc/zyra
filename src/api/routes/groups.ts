import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppLogger } from '../../observability/logger.js'
import { getConnection, getActiveSocket } from '../../core/connection/manager.js'
import { sendJson, sendError, matchRoute, readBody, parseJson } from '../http.js'

type GroupAdminParticipantAction = 'add' | 'kick' | 'remove' | 'ban' | 'promote' | 'demote'
type GroupAdminModeAction = 'announcementMode' | 'lockedMode'
type GroupAdminReadAction = 'getInviteCode' | 'revokeInvite' | 'listJoinRequests'
type GroupAdminMemberAddModeAction = 'memberAddMode'
type GroupAdminJoinApprovalModeAction = 'joinApprovalMode'
type GroupAdminJoinRequestAction = 'approveJoinRequests' | 'rejectJoinRequests'

type GroupAdminParticipantsPayload = {
  action: GroupAdminParticipantAction
  participants: string[] | string
}

type GroupAdminModePayload = {
  action: GroupAdminModeAction
  enabled: boolean
}

type GroupAdminSubjectPayload = {
  action: 'subject'
  subject: string
}

type GroupAdminDescriptionPayload = {
  action: 'description'
  description: string | null
}

type GroupAdminEphemeralPayload = {
  action: 'ephemeral'
  expirationSeconds: number
}

type GroupAdminReadPayload = {
  action: GroupAdminReadAction
}

type GroupAdminMemberAddModePayload = {
  action: GroupAdminMemberAddModeAction
  mode: 'admin_add' | 'all_member_add'
}

type GroupAdminJoinApprovalModePayload = {
  action: GroupAdminJoinApprovalModeAction
  mode: 'on' | 'off'
}

type GroupAdminJoinRequestPayload = {
  action: GroupAdminJoinRequestAction
  participants: string[] | string
}

type GroupAdminPayload =
  | GroupAdminParticipantsPayload
  | GroupAdminModePayload
  | GroupAdminSubjectPayload
  | GroupAdminDescriptionPayload
  | GroupAdminEphemeralPayload
  | GroupAdminReadPayload
  | GroupAdminMemberAddModePayload
  | GroupAdminJoinApprovalModePayload
  | GroupAdminJoinRequestPayload

const normalizeParticipant = (value: string): string => {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return ''

  const explicitJidMatch = normalized.match(/^([a-z0-9._-]+)@(s\.whatsapp\.net|lid)$/)
  if (explicitJidMatch) {
    return `${explicitJidMatch[1]}@${explicitJidMatch[2]}`
  }

  const digits = normalized.replace(/\D/g, '')
  return digits ? `${digits}@s.whatsapp.net` : ''
}

const parseParticipants = (input: string[] | string | undefined): string[] => {
  const rawValues = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : []
  const uniqueByBase = new Map<string, string>()

  for (const value of rawValues) {
    const normalized = normalizeParticipant(value)
    if (!normalized) continue
    const [base] = normalized.split('@')
    const dedupeKey = base ?? normalized
    if (!uniqueByBase.has(dedupeKey)) {
      uniqueByBase.set(dedupeKey, normalized)
    }
  }

  return [...uniqueByBase.values()]
}

const isValidGroupJid = (jid: string): boolean => jid.trim().toLowerCase().endsWith('@g.us')
const isValidMemberAddMode = (value: unknown): value is GroupAdminMemberAddModePayload['mode'] => value === 'admin_add' || value === 'all_member_add'
const isValidJoinApprovalMode = (value: unknown): value is GroupAdminJoinApprovalModePayload['mode'] => value === 'on' || value === 'off'

const resolveConnectedSocket = (connectionId: string, res: ServerResponse): ReturnType<typeof getActiveSocket> => {
  const info = getConnection(connectionId)
  if (!info) {
    sendError(res, 404, 'conexão não encontrada')
    return null
  }
  if (info.status !== 'open') {
    sendError(res, 409, `instância não está conectada (status: ${info.status})`)
    return null
  }

  const sock = getActiveSocket(connectionId)
  if (!sock) {
    sendError(res, 409, 'socket não disponível')
    return null
  }

  return sock
}

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
    const sock = resolveConnectedSocket(connectionId, res)
    if (!sock) return true

    try {
      const groupMap = await sock.groupFetchAllParticipating()
      sendJson(res, 200, groupMap)
    } catch (error) {
      logger.error('falha ao buscar grupos via API', { err: error, connectionId })
      sendError(res, 500, 'falha ao buscar grupos')
    }

    return true
  }

  // POST /connections/:id/groups/:groupJid/admin
  const adminMatch = matchRoute('/connections/:id/groups/:groupJid/admin', pathname)
  if (method === 'POST' && adminMatch) {
    const connectionId = adminMatch.params['id'] ?? ''
    const groupJid = adminMatch.params['groupJid'] ?? ''

    if (!isValidGroupJid(groupJid)) {
      sendError(res, 400, 'groupJid inválido; use um JID de grupo no formato ...@g.us')
      return true
    }

    const sock = resolveConnectedSocket(connectionId, res)
    if (!sock) return true

    const payload = parseJson<GroupAdminPayload>(await readBody(req))
    if (!payload || typeof payload !== 'object' || typeof payload.action !== 'string') {
      sendError(res, 400, 'corpo da requisição inválido')
      return true
    }

    try {
      if (['add', 'kick', 'remove', 'ban', 'promote', 'demote'].includes(payload.action)) {
        const participants = parseParticipants((payload as GroupAdminParticipantsPayload).participants)
        if (!participants.length) {
          sendError(res, 400, 'campo participants deve conter ao menos um participante válido')
          return true
        }

        const action = payload.action === 'add' || payload.action === 'promote' || payload.action === 'demote'
          ? payload.action
          : 'remove'
        const result = await sock.groupParticipantsUpdate(groupJid, participants, action)
        sendJson(res, 200, { ok: true, action: payload.action, participants, result })
        return true
      }

      if (payload.action === 'announcementMode' || payload.action === 'lockedMode') {
        if (typeof (payload as GroupAdminModePayload).enabled !== 'boolean') {
          sendError(res, 400, 'campo enabled deve ser boolean')
          return true
        }

        const enabled = (payload as GroupAdminModePayload).enabled
        const setting = payload.action === 'announcementMode'
          ? (enabled ? 'announcement' : 'not_announcement')
          : (enabled ? 'locked' : 'unlocked')
        await sock.groupSettingUpdate(groupJid, setting)
        sendJson(res, 200, { ok: true, action: payload.action, enabled })
        return true
      }

      if (payload.action === 'subject') {
        const subject = (payload as GroupAdminSubjectPayload).subject?.trim()
        if (!subject) {
          sendError(res, 400, 'campo subject é obrigatório')
          return true
        }
        await sock.groupUpdateSubject(groupJid, subject)
        sendJson(res, 200, { ok: true, action: payload.action, subject })
        return true
      }

      if (payload.action === 'description') {
        const descriptionPayload = payload as GroupAdminDescriptionPayload
        if (descriptionPayload.description !== null && typeof descriptionPayload.description !== 'string') {
          sendError(res, 400, 'campo description deve ser string ou null')
          return true
        }
        const description = typeof descriptionPayload.description === 'string' ? descriptionPayload.description.trim() : undefined
        await sock.groupUpdateDescription(groupJid, description || undefined)
        sendJson(res, 200, { ok: true, action: payload.action, description: description ?? null })
        return true
      }

      if (payload.action === 'ephemeral') {
        const expirationSeconds = (payload as GroupAdminEphemeralPayload).expirationSeconds
        if (!Number.isInteger(expirationSeconds) || expirationSeconds < 0) {
          sendError(res, 400, 'campo expirationSeconds deve ser um inteiro maior ou igual a zero')
          return true
        }
        await sock.groupToggleEphemeral(groupJid, expirationSeconds)
        sendJson(res, 200, { ok: true, action: payload.action, expirationSeconds })
        return true
      }

      if (payload.action === 'getInviteCode') {
        const inviteCode = await sock.groupInviteCode(groupJid)
        sendJson(res, 200, { ok: true, action: payload.action, inviteCode, inviteLink: `https://chat.whatsapp.com/${inviteCode}` })
        return true
      }

      if (payload.action === 'revokeInvite') {
        const inviteCode = await sock.groupRevokeInvite(groupJid)
        sendJson(res, 200, { ok: true, action: payload.action, inviteCode, inviteLink: `https://chat.whatsapp.com/${inviteCode}` })
        return true
      }

      if (payload.action === 'listJoinRequests') {
        const requests = await sock.groupRequestParticipantsList(groupJid)
        sendJson(res, 200, { ok: true, action: payload.action, requests })
        return true
      }

      if (payload.action === 'memberAddMode') {
        const mode = (payload as GroupAdminMemberAddModePayload).mode
        if (!isValidMemberAddMode(mode)) {
          sendError(res, 400, 'campo mode deve ser admin_add ou all_member_add')
          return true
        }
        await sock.groupMemberAddMode(groupJid, mode)
        sendJson(res, 200, { ok: true, action: payload.action, mode })
        return true
      }

      if (payload.action === 'joinApprovalMode') {
        const mode = (payload as GroupAdminJoinApprovalModePayload).mode
        if (!isValidJoinApprovalMode(mode)) {
          sendError(res, 400, 'campo mode deve ser on ou off')
          return true
        }
        await sock.groupJoinApprovalMode(groupJid, mode)
        sendJson(res, 200, { ok: true, action: payload.action, mode })
        return true
      }

      if (payload.action === 'approveJoinRequests' || payload.action === 'rejectJoinRequests') {
        const participants = parseParticipants((payload as GroupAdminJoinRequestPayload).participants)
        if (!participants.length) {
          sendError(res, 400, 'campo participants deve conter ao menos um participante válido')
          return true
        }

        const result = await sock.groupRequestParticipantsUpdate(groupJid, participants, payload.action === 'approveJoinRequests' ? 'approve' : 'reject')
        sendJson(res, 200, { ok: true, action: payload.action, participants, result })
        return true
      }

      sendError(res, 400, 'action inválida; use add, kick, remove, ban, promote, demote, announcementMode, lockedMode, subject, description, getInviteCode, revokeInvite, ephemeral, memberAddMode, joinApprovalMode, listJoinRequests, approveJoinRequests ou rejectJoinRequests')
    } catch (error) {
      logger.error('falha ao executar ação administrativa de grupo via API', {
        err: error,
        connectionId,
        groupJid,
        action: payload.action,
      })
      sendError(res, 500, 'falha ao executar ação administrativa de grupo')
    }

    return true
  }

  return false
}
