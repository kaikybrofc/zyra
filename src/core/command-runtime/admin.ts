import { jidNormalizedUser, type GroupMetadata, type ParticipantAction, type WASocket } from '@whiskeysockets/baileys'

/**
 * Alvo de um participante, pode ser um único JID ou uma lista de JIDs.
 */
export type ParticipantTarget = string | string[]

/**
 * Resultado da atualização de participantes de um grupo.
 */
export type GroupParticipantsUpdateResult = Awaited<ReturnType<WASocket['groupParticipantsUpdate']>>
export type GroupJoinRequestListResult = Awaited<ReturnType<WASocket['groupRequestParticipantsList']>>
export type GroupJoinRequestUpdateResult = Awaited<ReturnType<WASocket['groupRequestParticipantsUpdate']>>
export type GroupSettingValue = Parameters<WASocket['groupSettingUpdate']>[1]
export type GroupMemberAddModeValue = Parameters<WASocket['groupMemberAddMode']>[1]
export type GroupJoinApprovalModeValue = Parameters<WASocket['groupJoinApprovalMode']>[1]
export type GroupInviteCodeResult = Awaited<ReturnType<WASocket['groupInviteCode']>>
export type GroupRevokeInviteResult = Awaited<ReturnType<WASocket['groupRevokeInvite']>>

/**
 * Interface que define as ações administrativas disponíveis para um comando.
 */
export type CommandAdminActions = {
  /**
   * Obtém os metadados atuais do grupo.
   */
  getMetadata: () => Promise<GroupMetadata>

  /**
   * Verifica se um usuário é administrador do grupo.
   * @param jid JID do usuário a ser verificado. Se omitido, verifica o remetente da mensagem.
   */
  isAdmin: (jid?: string) => Promise<boolean>

  /**
   * Adiciona participantes ao grupo.
   * @param participants Lista de JIDs ou JID único a ser adicionado.
   */
  add: (participants: ParticipantTarget) => Promise<GroupParticipantsUpdateResult>

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

  /**
   * Atualiza o assunto (nome) do grupo.
   */
  setSubject: (subject: string) => Promise<void>

  /**
   * Atualiza a descrição do grupo. Use undefined para limpar.
   */
  setDescription: (description?: string) => Promise<void>

  /**
   * Busca o código de convite atual do grupo.
   */
  getInviteCode: () => Promise<GroupInviteCodeResult>

  /**
   * Revoga o código de convite atual e retorna o novo, quando disponível.
   */
  revokeInvite: () => Promise<GroupRevokeInviteResult>

  /**
   * Define a duração das mensagens temporárias em segundos (0 para desativar).
   */
  setEphemeral: (expirationSeconds: number) => Promise<void>

  /**
   * Atualiza uma configuração bruta de grupo no formato do Baileys.
   */
  setGroupSetting: (setting: GroupSettingValue) => Promise<void>

  /**
   * Controla se apenas admins podem enviar mensagens.
   */
  setAnnouncementMode: (enabled: boolean) => Promise<void>

  /**
   * Controla se apenas admins podem editar informações do grupo.
   */
  setLockedMode: (enabled: boolean) => Promise<void>

  /**
   * Define quem pode adicionar membros diretamente.
   */
  setMemberAddMode: (mode: GroupMemberAddModeValue) => Promise<void>

  /**
   * Ativa/desativa aprovação de entrada no grupo.
   */
  setJoinApprovalMode: (mode: GroupJoinApprovalModeValue) => Promise<void>

  /**
   * Lista solicitações pendentes para entrar no grupo.
   */
  listJoinRequests: () => Promise<GroupJoinRequestListResult>

  /**
   * Aprova solicitações de entrada de participantes.
   */
  approveJoinRequests: (participants: ParticipantTarget) => Promise<GroupJoinRequestUpdateResult>

  /**
   * Rejeita solicitações de entrada de participantes.
   */
  rejectJoinRequests: (participants: ParticipantTarget) => Promise<GroupJoinRequestUpdateResult>
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
    throw new Error(`A ação de administração exige um grupo. Chat atual: ${chatId}`)
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

  const updateJoinRequests = async (
    participants: ParticipantTarget,
    action: 'approve' | 'reject'
  ): Promise<GroupJoinRequestUpdateResult> => {
    ensureGroupChat(chatId, isGroup)
    const targetList = toParticipantList(participants)
    if (!targetList.length) {
      return []
    }
    return sock.groupRequestParticipantsUpdate(chatId, targetList, action)
  }

  return {
    getMetadata,
    async isAdmin(jid?: string): Promise<boolean> {
      if (!isGroup) return false
      const metadata = await getMetadata()
      return isAdminParticipant(metadata, jid ?? sender)
    },
    add(participants) {
      return updateParticipants(participants, 'add')
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
    async setSubject(subject) {
      ensureGroupChat(chatId, isGroup)
      await sock.groupUpdateSubject(chatId, subject)
    },
    async setDescription(description) {
      ensureGroupChat(chatId, isGroup)
      await sock.groupUpdateDescription(chatId, description)
    },
    async getInviteCode() {
      ensureGroupChat(chatId, isGroup)
      return sock.groupInviteCode(chatId)
    },
    async revokeInvite() {
      ensureGroupChat(chatId, isGroup)
      return sock.groupRevokeInvite(chatId)
    },
    async setEphemeral(expirationSeconds) {
      ensureGroupChat(chatId, isGroup)
      await sock.groupToggleEphemeral(chatId, expirationSeconds)
    },
    async setGroupSetting(setting) {
      ensureGroupChat(chatId, isGroup)
      await sock.groupSettingUpdate(chatId, setting)
    },
    async setAnnouncementMode(enabled) {
      ensureGroupChat(chatId, isGroup)
      await sock.groupSettingUpdate(chatId, enabled ? 'announcement' : 'not_announcement')
    },
    async setLockedMode(enabled) {
      ensureGroupChat(chatId, isGroup)
      await sock.groupSettingUpdate(chatId, enabled ? 'locked' : 'unlocked')
    },
    async setMemberAddMode(mode) {
      ensureGroupChat(chatId, isGroup)
      await sock.groupMemberAddMode(chatId, mode)
    },
    async setJoinApprovalMode(mode) {
      ensureGroupChat(chatId, isGroup)
      await sock.groupJoinApprovalMode(chatId, mode)
    },
    async listJoinRequests() {
      ensureGroupChat(chatId, isGroup)
      return sock.groupRequestParticipantsList(chatId)
    },
    approveJoinRequests(participants) {
      return updateJoinRequests(participants, 'approve')
    },
    rejectJoinRequests(participants) {
      return updateJoinRequests(participants, 'reject')
    },
  }
}
