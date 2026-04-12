import { jidNormalizedUser, type GroupMetadata, type ParticipantAction, type WASocket } from '@whiskeysockets/baileys'

/**
 * Alvo de um participante, pode ser um único JID ou uma lista de JIDs.
 */
export type ParticipantTarget = string | string[]

/**
 * Resultado da atualização de participantes de um grupo.
 */
export type GroupParticipantsUpdateResult = Awaited<ReturnType<WASocket['groupParticipantsUpdate']>>

/**
 * Interface que define as ações administrativas disponíveis para um comando.
 */
export type CommandAdminActions = {
  /**
   * Verifica se um usuário é administrador do grupo.
   * @param jid JID do usuário a ser verificado. Se omitido, verifica o remetente da mensagem.
   */
  isAdmin: (jid?: string) => Promise<boolean>

  /**
   * Remove participantes do grupo (kick).
   * @param participants Lista de JIDs ou JID único a ser removido.
   */
  kick: (participants: ParticipantTarget) => Promise<GroupParticipantsUpdateResult>

  /**
   * Bane participantes do grupo (atualmente mapeado para a mesma ação de kick).
   * @param participants Lista de JIDs ou JID único a ser banido.
   */
  ban: (participants: ParticipantTarget) => Promise<GroupParticipantsUpdateResult>

  /**
   * Promove participantes a administrador.
   * @param participants Lista de JIDs ou JID único a ser promovido.
   */
  promote: (participants: ParticipantTarget) => Promise<GroupParticipantsUpdateResult>

  /**
   * Rebaixa administradores a participantes comuns.
   * @param participants Lista de JIDs ou JID único a ser rebaixado.
   */
  demote: (participants: ParticipantTarget) => Promise<GroupParticipantsUpdateResult>
}

/**
 * Opções para criação das ações administrativas de comando.
 */
type CreateCommandAdminActionsOptions = {
  /** Instância do socket do Baileys. */
  sock: WASocket
  /** JID do chat (grupo). */
  chatId: string
  /** JID do remetente da mensagem. */
  sender: string
  /** Indica se o chat é um grupo. */
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

/**
 * Cria as ações administrativas para o contexto de um comando.
 * @param options Opções de inicialização.
 * @returns Um objeto contendo métodos para interagir com a administração do grupo.
 */
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
