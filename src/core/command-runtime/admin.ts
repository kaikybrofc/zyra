import { jidNormalizedUser, type GroupMetadata, type ParticipantAction, type WASocket } from '@whiskeysockets/baileys'

export type ParticipantTarget = string | string[]
export type GroupParticipantsUpdateResult = Awaited<ReturnType<WASocket['groupParticipantsUpdate']>>

export type CommandAdminActions = {
  isAdmin: (jid?: string) => Promise<boolean>
  kick: (participants: ParticipantTarget) => Promise<GroupParticipantsUpdateResult>
  ban: (participants: ParticipantTarget) => Promise<GroupParticipantsUpdateResult>
  promote: (participants: ParticipantTarget) => Promise<GroupParticipantsUpdateResult>
  demote: (participants: ParticipantTarget) => Promise<GroupParticipantsUpdateResult>
}

type CreateCommandAdminActionsOptions = {
  sock: WASocket
  chatId: string
  sender: string
  isGroup: boolean
}

const toParticipantList = (participants: ParticipantTarget): string[] =>
  (Array.isArray(participants) ? participants : [participants]).filter((participant) => participant.trim().length > 0)

const ensureGroupChat = (chatId: string, isGroup: boolean): void => {
  if (!isGroup) {
    throw new Error(`A acao de administracao exige um grupo. Chat atual: ${chatId}`)
  }
}

const isAdminParticipant = (metadata: GroupMetadata, jid: string): boolean =>
  metadata.participants.some(
    (participant) =>
      jidNormalizedUser(participant.id) === jidNormalizedUser(jid) &&
      (participant.admin === 'admin' || participant.admin === 'superadmin')
  )

export function createCommandAdminActions({
  sock,
  chatId,
  sender,
  isGroup,
}: CreateCommandAdminActionsOptions): CommandAdminActions {
  const getMetadata = async (): Promise<GroupMetadata> => {
    ensureGroupChat(chatId, isGroup)
    return sock.groupMetadata(chatId)
  }

  const updateParticipants = async (
    participants: ParticipantTarget,
    action: ParticipantAction
  ): Promise<GroupParticipantsUpdateResult> => {
    ensureGroupChat(chatId, isGroup)
    const targetList = toParticipantList(participants)
    if (!targetList.length) {
      return []
    }
    return sock.groupParticipantsUpdate(chatId, targetList, action)
  }

  return {
    async isAdmin(jid?: string): Promise<boolean> {
      if (!isGroup) return false
      const metadata = await getMetadata()
      return isAdminParticipant(metadata, jid ?? sender)
    },
    kick(participants) {
      return updateParticipants(participants, 'remove')
    },
    ban(participants) {
      return updateParticipants(participants, 'remove')
    },
    promote(participants) {
      return updateParticipants(participants, 'promote')
    },
    demote(participants) {
      return updateParticipants(participants, 'demote')
    },
  }
}
