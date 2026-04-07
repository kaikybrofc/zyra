import { extractMessageContent, getContentType, normalizeMessageContent, proto } from '@whiskeysockets/baileys'

type NormalizedMessage = {
  content: proto.IMessage | undefined
  type: keyof proto.IMessage | null
}

/**
 * Normaliza o payload da mensagem e identifica o tipo principal.
 */
export const getNormalizedMessage = (message: proto.IWebMessageInfo): NormalizedMessage => {
  const content = extractMessageContent(normalizeMessageContent(message.message))
  const type = content ? (getContentType(content) ?? null) : null
  return { content, type }
}

/**
 * Extrai o texto mais relevante de uma mensagem do WhatsApp.
 */
export function getMessageText(message: proto.IWebMessageInfo): string | null {
  const { content: normalized, type: contentType } = getNormalizedMessage(message)
  if (!normalized || !contentType) return null

  const pickText = (...values: Array<unknown>): string | null => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value
      }
    }
    return null
  }

  const pickTextFromRecord = (record: Record<string, unknown> | null): string | null => {
    if (!record) return null
    return pickText(record.text, record.caption, record.contentText, record.hydratedContentText, record.title, record.description, record.displayName, record.name, record.comment, record.address, record.url, record.selectedDisplayText, record.selectedButtonId, record.selectedId, record.buttonText) ?? pickTextFromRecord(record.body as Record<string, unknown> | null) ?? pickTextFromRecord(record.nativeFlowResponseMessage as Record<string, unknown> | null)
  }

  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (typeof value !== 'object' || value === null) return null
    return value as Record<string, unknown>
  }

  const eventResponseToText = (value: proto.Message.EventResponseMessage.EventResponseType | null | undefined): string | null => {
    switch (value) {
      case proto.Message.EventResponseMessage.EventResponseType.GOING:
        return 'GOING'
      case proto.Message.EventResponseMessage.EventResponseType.NOT_GOING:
        return 'NOT_GOING'
      case proto.Message.EventResponseMessage.EventResponseType.MAYBE:
        return 'MAYBE'
      default:
        return null
    }
  }

  const eventResponse = (normalized as unknown as { eventResponseMessage?: proto.Message.IEventResponseMessage }).eventResponseMessage
  const eventResponseText = eventResponseToText(eventResponse?.response)
  if (eventResponseText) return eventResponseText

  switch (contentType) {
    case 'conversation':
      return pickText(normalized.conversation)
    case 'extendedTextMessage':
      return pickText(normalized.extendedTextMessage?.text, normalized.extendedTextMessage?.description, normalized.extendedTextMessage?.title, normalized.extendedTextMessage?.matchedText)
    case 'imageMessage':
      return pickText(normalized.imageMessage?.caption)
    case 'videoMessage':
      return pickText(normalized.videoMessage?.caption)
    case 'documentMessage':
      return pickText(normalized.documentMessage?.caption)
    case 'audioMessage':
      return pickText(normalized.audioMessage?.contextInfo?.quotedMessage?.conversation)
    case 'buttonsMessage':
      return pickText(normalized.buttonsMessage?.contentText, normalized.buttonsMessage?.footerText, normalized.buttonsMessage?.text)
    case 'buttonsResponseMessage':
      return pickText(normalized.buttonsResponseMessage?.selectedDisplayText, normalized.buttonsResponseMessage?.selectedButtonId)
    case 'templateButtonReplyMessage':
      return pickText(normalized.templateButtonReplyMessage?.selectedDisplayText, normalized.templateButtonReplyMessage?.selectedId)
    case 'listMessage':
      return pickText(normalized.listMessage?.title, normalized.listMessage?.description, normalized.listMessage?.buttonText)
    case 'listResponseMessage':
      return pickText(normalized.listResponseMessage?.title, normalized.listResponseMessage?.description, normalized.listResponseMessage?.singleSelectReply?.selectedRowId)
    case 'interactiveMessage':
      return pickText(normalized.interactiveMessage?.body?.text)
    case 'interactiveResponseMessage':
      return pickText(normalized.interactiveResponseMessage?.body?.text, normalized.interactiveResponseMessage?.nativeFlowResponseMessage?.name, normalized.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson)
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
    case 'pollCreationMessageV5':
      return pickText((normalized[contentType] as proto.Message.IPollCreationMessage | null | undefined)?.name)
    case 'reactionMessage':
      return pickText(normalized.reactionMessage?.text)
    case 'contactMessage':
      return pickText(normalized.contactMessage?.displayName)
    case 'contactsArrayMessage':
      return pickText(normalized.contactsArrayMessage?.displayName, normalized.contactsArrayMessage?.contacts?.[0]?.displayName)
    case 'locationMessage':
      return pickText(normalized.locationMessage?.comment, normalized.locationMessage?.name, normalized.locationMessage?.address, normalized.locationMessage?.url)
    case 'liveLocationMessage':
      return pickText(normalized.liveLocationMessage?.caption)
    case 'groupInviteMessage':
      return pickText(normalized.groupInviteMessage?.caption, normalized.groupInviteMessage?.groupName)
    case 'eventMessage':
      return pickText(normalized.eventMessage?.name, normalized.eventMessage?.description, normalized.eventMessage?.joinLink)
    case 'encEventResponseMessage':
      return null
    case 'questionResponseMessage':
      return pickText(normalized.questionResponseMessage?.text)
    default: {
      const inner = (normalized as proto.IMessage)[contentType as keyof proto.IMessage]
      return pickTextFromRecord(asRecord(inner))
    }
  }
}
