import type { AnyMessageContent, MiscMessageGenerationOptions, WAMessage, WAMessageKey } from 'baileys'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AppLogger } from '../../observability/logger.js'
import { getConnection, getActiveSocket } from '../../core/connection/manager.js'
import { readBody, parseJson, sendJson, sendError, matchRoute } from '../http.js'

type SendMessageOptionsPayload = {
  messageId?: string
  quoted?: WAMessage
  ephemeralExpiration?: number | string
  mediaUploadTimeoutMs?: number
  statusJidList?: string[] | string
  backgroundColor?: string
  font?: number
  broadcast?: boolean
}

type SendPayloadBase = {
  to: string
  options?: SendMessageOptionsPayload
}

type SendTextPayload = SendPayloadBase & {
  type: 'text'
  text: string
}

type SendMediaPayload = SendPayloadBase & {
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker'
  url: string
  caption?: string
  fileName?: string
  mimetype?: string
  ptt?: boolean
  seconds?: number
  gifPlayback?: boolean
  ptv?: boolean
  isAnimated?: boolean
}

type SendPinPayload = SendPayloadBase & {
  type: 'pin'
  messageKey: WAMessageKey
  time?: 86400 | 604800 | 2592000
}

type SendContactsPayload = SendPayloadBase & {
  type: 'contacts'
  contacts: {
    displayName?: string
    contacts: Array<Record<string, unknown>>
  }
}

type SendLocationPayload = SendPayloadBase & {
  type: 'location'
  degreesLatitude?: number
  degreesLongitude?: number
  latitude?: number
  longitude?: number
  name?: string
  address?: string
  url?: string
}

type SendReactPayload = SendPayloadBase & {
  type: 'react'
  text: string
  messageKey: WAMessageKey
}

type SendPollPayload = SendPayloadBase & {
  type: 'poll'
  name: string
  values: string[]
  selectableCount?: number
  toAnnouncementGroup?: boolean
}

type SendEventPayload = SendPayloadBase & {
  type: 'event'
  name: string
  startDate: string | number | Date
  endDate?: string | number | Date
  description?: string
  location?: Record<string, unknown>
  call?: 'audio' | 'video'
  isCancelled?: boolean
  isScheduleCall?: boolean
  extraGuestsAllowed?: boolean
}

type SendButtonReplyPayload = SendPayloadBase & {
  type: 'buttonReply'
  displayText: string
  id: string
  index: number
  replyType?: 'template' | 'plain'
}

type SendGroupInvitePayload = SendPayloadBase & {
  type: 'groupInvite'
  inviteCode: string
  inviteExpiration: number
  text: string
  jid: string
  subject: string
}

type SendListReplyPayload = SendPayloadBase & {
  type: 'listReply'
  listReply: Record<string, unknown>
}

type SendForwardPayload = SendPayloadBase & {
  type: 'forward'
  message: WAMessage
  force?: boolean
}

type SendDeletePayload = SendPayloadBase & {
  type: 'delete'
  messageKey: WAMessageKey
}

type SendDisappearingMessagesPayload = SendPayloadBase & {
  type: 'disappearingMessagesInChat'
  value: boolean | number
}

type SendLimitSharingPayload = SendPayloadBase & {
  type: 'limitSharing'
  value: boolean
}

type SendSharePhoneNumberPayload = SendPayloadBase & {
  type: 'sharePhoneNumber'
}

type SendRequestPhoneNumberPayload = SendPayloadBase & {
  type: 'requestPhoneNumber'
}

type SendRawPayload = SendPayloadBase & {
  type: 'raw'
  content: Record<string, unknown>
}

type SendMessagePayload =
  | SendTextPayload
  | SendMediaPayload
  | SendPinPayload
  | SendContactsPayload
  | SendLocationPayload
  | SendReactPayload
  | SendPollPayload
  | SendEventPayload
  | SendButtonReplyPayload
  | SendGroupInvitePayload
  | SendListReplyPayload
  | SendForwardPayload
  | SendDeletePayload
  | SendDisappearingMessagesPayload
  | SendLimitSharingPayload
  | SendSharePhoneNumberPayload
  | SendRequestPhoneNumberPayload
  | SendRawPayload

type BuildResult<T> = { ok: true; value: T } | { ok: false; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isStatusBroadcastJid = (jid: string): boolean => jid.trim().toLowerCase() === 'status@broadcast'

const normalizeStatusRecipient = (value: string): string => {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return ''

  const explicitJidMatch = normalized.match(/^([a-z0-9._-]+)@(s\.whatsapp\.net|lid)$/)
  if (explicitJidMatch) {
    return `${explicitJidMatch[1]}@${explicitJidMatch[2]}`
  }

  const digits = normalized.replace(/\D/g, '')
  return digits ? `${digits}@s.whatsapp.net` : ''
}

const parseStatusJidList = (input: string[] | string | undefined): string[] => {
  const rawValues = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : []
  const uniqueByBase = new Map<string, string>()

  for (const value of rawValues) {
    const normalized = normalizeStatusRecipient(value)
    if (!normalized) continue
    const [base] = normalized.split('@')
    const dedupeKey = base ?? normalized
    if (!uniqueByBase.has(dedupeKey)) uniqueByBase.set(dedupeKey, normalized)
  }

  return [...uniqueByBase.values()]
}

const parseDateInput = (value: unknown, fieldName: string): BuildResult<Date> => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { ok: false, error: `campo ${fieldName} deve ser uma data válida` }
    return { ok: true, value }
  }

  if (typeof value !== 'string' && typeof value !== 'number') {
    return { ok: false, error: `campo ${fieldName} deve ser string ISO, timestamp ou Date` }
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: `campo ${fieldName} deve ser uma data válida` }
  }

  return { ok: true, value: date }
}

const normalizeEventPayload = (input: Record<string, unknown>): BuildResult<AnyMessageContent> => {
  const name = typeof input['name'] === 'string' ? input['name'].trim() : ''
  if (!name) return { ok: false, error: 'campo name é obrigatório para type=event' }

  const startDate = parseDateInput(input['startDate'], 'startDate')
  if (!startDate.ok) return startDate

  let endDate: Date | undefined
  if (input['endDate'] !== undefined) {
    const parsedEndDate = parseDateInput(input['endDate'], 'endDate')
    if (!parsedEndDate.ok) return parsedEndDate
    endDate = parsedEndDate.value
  }

  const call = input['call']
  if (call !== undefined && call !== 'audio' && call !== 'video') {
    return { ok: false, error: 'campo call deve ser audio ou video para type=event' }
  }

  const location = input['location']
  if (location !== undefined && !isRecord(location)) {
    return { ok: false, error: 'campo location deve ser um objeto para type=event' }
  }

  return {
    ok: true,
    value: {
      event: {
        name,
        ...(typeof input['description'] === 'string' && input['description'].trim() ? { description: input['description'].trim() } : {}),
        startDate: startDate.value,
        ...(endDate ? { endDate } : {}),
        ...(location ? { location: location as never } : {}),
        ...(call ? { call } : {}),
        ...(typeof input['isCancelled'] === 'boolean' ? { isCancelled: input['isCancelled'] } : {}),
        ...(typeof input['isScheduleCall'] === 'boolean' ? { isScheduleCall: input['isScheduleCall'] } : {}),
        ...(typeof input['extraGuestsAllowed'] === 'boolean' ? { extraGuestsAllowed: input['extraGuestsAllowed'] } : {}),
      },
    },
  }
}

const normalizeRawContent = (content: Record<string, unknown>): BuildResult<AnyMessageContent> => {
  if (Object.keys(content).length === 0) {
    return { ok: false, error: 'campo content deve conter ao menos uma chave válida para type=raw' }
  }

  if ('event' in content) {
    const event = content['event']
    if (!isRecord(event)) {
      return { ok: false, error: 'campo content.event deve ser um objeto válido' }
    }

    const normalizedEvent = normalizeEventPayload(event)
    if (!normalizedEvent.ok) return normalizedEvent

    return {
      ok: true,
      value: {
        ...content,
        ...normalizedEvent.value,
      } as unknown as AnyMessageContent,
    }
  }

  return { ok: true, value: content as unknown as AnyMessageContent }
}

const buildMessageOptions = (to: string, options: SendMessageOptionsPayload | undefined): BuildResult<MiscMessageGenerationOptions | undefined> => {
  const statusJidList = parseStatusJidList(options?.statusJidList)
  const isStatusDestination = isStatusBroadcastJid(to)

  if (isStatusDestination && statusJidList.length === 0) {
    return { ok: false, error: 'campo options.statusJidList é obrigatório ao enviar para status@broadcast' }
  }

  const builtOptions: MiscMessageGenerationOptions = {
    ...(typeof options?.messageId === 'string' && options.messageId.trim() ? { messageId: options.messageId.trim() } : {}),
    ...(options?.quoted ? { quoted: options.quoted } : {}),
    ...(options?.ephemeralExpiration !== undefined ? { ephemeralExpiration: options.ephemeralExpiration } : {}),
    ...(typeof options?.mediaUploadTimeoutMs === 'number' ? { mediaUploadTimeoutMs: options.mediaUploadTimeoutMs } : {}),
    ...(statusJidList.length ? { statusJidList } : {}),
    ...(typeof options?.backgroundColor === 'string' && options.backgroundColor.trim() ? { backgroundColor: options.backgroundColor.trim() } : {}),
    ...(typeof options?.font === 'number' ? { font: options.font } : {}),
    ...(typeof options?.broadcast === 'boolean' ? { broadcast: options.broadcast } : {}),
  }

  if (isStatusDestination && builtOptions.broadcast !== true) {
    builtOptions.broadcast = true
  }

  return Object.keys(builtOptions).length > 0
    ? { ok: true, value: builtOptions }
    : { ok: true, value: undefined }
}

const buildMessageContent = (payload: SendMessagePayload): BuildResult<AnyMessageContent> => {
  if (payload.type === 'text') {
    if (!payload.text?.trim()) return { ok: false, error: 'campo text é obrigatório para type=text' }
    return { ok: true, value: { text: payload.text } }
  }

  if (payload.type === 'image') {
    if (!payload.url?.trim()) return { ok: false, error: 'campo url é obrigatório para type=image' }
    return { ok: true, value: { image: { url: payload.url }, ...(payload.caption !== undefined ? { caption: payload.caption } : {}) } }
  }

  if (payload.type === 'video') {
    if (!payload.url?.trim()) return { ok: false, error: 'campo url é obrigatório para type=video' }
    return {
      ok: true,
      value: {
        video: { url: payload.url },
        ...(payload.caption !== undefined ? { caption: payload.caption } : {}),
        ...(typeof payload.gifPlayback === 'boolean' ? { gifPlayback: payload.gifPlayback } : {}),
        ...(typeof payload.ptv === 'boolean' ? { ptv: payload.ptv } : {}),
      },
    }
  }

  if (payload.type === 'audio') {
    if (!payload.url?.trim()) return { ok: false, error: 'campo url é obrigatório para type=audio' }
    return {
      ok: true,
      value: {
        audio: { url: payload.url },
        ...(typeof payload.ptt === 'boolean' ? { ptt: payload.ptt } : {}),
        ...(typeof payload.seconds === 'number' ? { seconds: payload.seconds } : {}),
      },
    }
  }

  if (payload.type === 'document') {
    if (!payload.url?.trim()) return { ok: false, error: 'campo url é obrigatório para type=document' }
    return {
      ok: true,
      value: {
        document: { url: payload.url },
        mimetype: payload.mimetype ?? 'application/octet-stream',
        ...(payload.fileName !== undefined ? { fileName: payload.fileName } : {}),
        ...(payload.caption !== undefined ? { caption: payload.caption } : {}),
      },
    }
  }

  if (payload.type === 'sticker') {
    if (!payload.url?.trim()) return { ok: false, error: 'campo url é obrigatório para type=sticker' }
    return {
      ok: true,
      value: {
        sticker: { url: payload.url },
        ...(typeof payload.isAnimated === 'boolean' ? { isAnimated: payload.isAnimated } : {}),
      },
    }
  }

  if (payload.type === 'contacts') {
    if (!isRecord(payload.contacts) || !Array.isArray(payload.contacts.contacts) || payload.contacts.contacts.length === 0) {
      return { ok: false, error: 'campo contacts.contacts deve conter ao menos um contato para type=contacts' }
    }
    return { ok: true, value: { contacts: payload.contacts as never } }
  }

  if (payload.type === 'location') {
    const latitude = typeof payload.degreesLatitude === 'number' ? payload.degreesLatitude : payload.latitude
    const longitude = typeof payload.degreesLongitude === 'number' ? payload.degreesLongitude : payload.longitude
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return { ok: false, error: 'campos latitude/longitude (ou degreesLatitude/degreesLongitude) são obrigatórios para type=location' }
    }
    return {
      ok: true,
      value: {
        location: {
          degreesLatitude: latitude,
          degreesLongitude: longitude,
          ...(payload.name !== undefined ? { name: payload.name } : {}),
          ...(payload.address !== undefined ? { address: payload.address } : {}),
          ...(payload.url !== undefined ? { url: payload.url } : {}),
        } as never,
      },
    }
  }

  if (payload.type === 'react') {
    if (!payload.messageKey?.id?.trim()) return { ok: false, error: 'campo messageKey.id é obrigatório para type=react' }
    if (typeof payload.text !== 'string') return { ok: false, error: 'campo text deve ser string para type=react' }
    return {
      ok: true,
      value: {
        react: {
          text: payload.text,
          key: payload.messageKey,
        },
      },
    }
  }

  if (payload.type === 'poll') {
    if (!payload.name?.trim()) return { ok: false, error: 'campo name é obrigatório para type=poll' }
    if (!Array.isArray(payload.values) || payload.values.length === 0 || payload.values.some((value) => typeof value !== 'string' || !value.trim())) {
      return { ok: false, error: 'campo values deve conter ao menos uma opção válida para type=poll' }
    }
    return {
      ok: true,
      value: {
        poll: {
          name: payload.name,
          values: payload.values,
          ...(typeof payload.selectableCount === 'number' ? { selectableCount: payload.selectableCount } : {}),
          ...(typeof payload.toAnnouncementGroup === 'boolean' ? { toAnnouncementGroup: payload.toAnnouncementGroup } : {}),
        },
      },
    }
  }

  if (payload.type === 'event') {
    return normalizeEventPayload(payload)
  }

  if (payload.type === 'buttonReply') {
    if (!payload.displayText?.trim() || !payload.id?.trim() || !Number.isInteger(payload.index)) {
      return { ok: false, error: 'campos displayText, id e index são obrigatórios para type=buttonReply' }
    }
    return {
      ok: true,
      value: {
        buttonReply: {
          displayText: payload.displayText,
          id: payload.id,
          index: payload.index,
        },
        type: payload.replyType ?? 'plain',
      },
    }
  }

  if (payload.type === 'groupInvite') {
    if (!payload.inviteCode?.trim() || !payload.text?.trim() || !payload.jid?.trim() || !payload.subject?.trim() || !Number.isFinite(payload.inviteExpiration)) {
      return { ok: false, error: 'campos inviteCode, inviteExpiration, text, jid e subject são obrigatórios para type=groupInvite' }
    }
    return {
      ok: true,
      value: {
        groupInvite: {
          inviteCode: payload.inviteCode,
          inviteExpiration: payload.inviteExpiration,
          text: payload.text,
          jid: payload.jid,
          subject: payload.subject,
        },
      },
    }
  }

  if (payload.type === 'listReply') {
    if (!isRecord(payload.listReply)) return { ok: false, error: 'campo listReply deve ser um objeto para type=listReply' }
    return { ok: true, value: { listReply: payload.listReply as never } }
  }

  if (payload.type === 'pin') {
    if (!payload.messageKey || typeof payload.messageKey !== 'object' || !payload.messageKey.id?.trim()) {
      return { ok: false, error: 'campo messageKey.id é obrigatório para type=pin' }
    }
    if (payload.time !== undefined && ![86400, 604800, 2592000].includes(payload.time)) {
      return { ok: false, error: 'campo time deve ser 86400, 604800 ou 2592000 para type=pin' }
    }
    return {
      ok: true,
      value: {
        pin: payload.messageKey,
        type: 1,
        ...(payload.time !== undefined ? { time: payload.time } : {}),
      },
    }
  }

  if (payload.type === 'sharePhoneNumber') {
    return { ok: true, value: { sharePhoneNumber: true } }
  }

  if (payload.type === 'requestPhoneNumber') {
    return { ok: true, value: { requestPhoneNumber: true } }
  }

  if (payload.type === 'forward') {
    if (!payload.message || !isRecord(payload.message)) return { ok: false, error: 'campo message é obrigatório para type=forward' }
    return {
      ok: true,
      value: {
        forward: payload.message,
        ...(typeof payload.force === 'boolean' ? { force: payload.force } : {}),
      },
    }
  }

  if (payload.type === 'delete') {
    if (!payload.messageKey?.id?.trim()) return { ok: false, error: 'campo messageKey.id é obrigatório para type=delete' }
    return { ok: true, value: { delete: payload.messageKey } }
  }

  if (payload.type === 'disappearingMessagesInChat') {
    if (typeof payload.value !== 'boolean' && typeof payload.value !== 'number') {
      return { ok: false, error: 'campo value deve ser boolean ou number para type=disappearingMessagesInChat' }
    }
    return { ok: true, value: { disappearingMessagesInChat: payload.value } }
  }

  if (payload.type === 'limitSharing') {
    if (typeof payload.value !== 'boolean') return { ok: false, error: 'campo value deve ser boolean para type=limitSharing' }
    return { ok: true, value: { limitSharing: payload.value } }
  }

  if (payload.type === 'raw') {
    if (!isRecord(payload.content)) return { ok: false, error: 'campo content deve ser um objeto para type=raw' }
    return normalizeRawContent(payload.content)
  }

  return {
    ok: false,
    error: 'type deve ser: text, image, video, audio, document, sticker, contacts, location, react, poll, event, buttonReply, groupInvite, listReply, pin, sharePhoneNumber, requestPhoneNumber, forward, delete, disappearingMessagesInChat, limitSharing ou raw',
  }
}

const sendWithOptionalOptions = async (
  sock: NonNullable<ReturnType<typeof getActiveSocket>>,
  to: string,
  content: AnyMessageContent,
  options: MiscMessageGenerationOptions | undefined
) => (options ? sock.sendMessage(to, content, options) : sock.sendMessage(to, content))

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
    if (!payload || !isRecord(payload)) {
      sendError(res, 400, 'corpo da requisição inválido')
      return true
    }
    if (!payload.to?.trim()) {
      sendError(res, 400, 'destinatário (to) é obrigatório')
      return true
    }
    if (typeof payload.type !== 'string') {
      sendError(res, 400, 'campo type é obrigatório')
      return true
    }

    const to = payload.to.trim()
    const contentResult = buildMessageContent(payload)
    if (!contentResult.ok) {
      sendError(res, 400, contentResult.error)
      return true
    }

    const optionsResult = buildMessageOptions(to, payload.options)
    if (!optionsResult.ok) {
      sendError(res, 400, optionsResult.error)
      return true
    }

    try {
      const result = await sendWithOptionalOptions(sock, to, contentResult.value, optionsResult.value)
      sendJson(res, 200, result ?? null)
    } catch (error) {
      logger.error('falha ao enviar mensagem via API', { err: error, connectionId, to, type: payload.type })
      sendError(res, 500, 'falha ao enviar mensagem')
    }

    return true
  }

  return false
}
