import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WAMessage,
} from '@whiskeysockets/baileys'
import type {
  CommandAdminActions,
  GroupInviteCodeResult,
  GroupJoinApprovalModeValue,
  GroupJoinRequestListResult,
  GroupJoinRequestUpdateResult,
  GroupMemberAddModeValue,
  GroupParticipantsUpdateResult,
  GroupRevokeInviteResult,
  GroupSettingValue,
  ParticipantTarget,
} from './admin.js'

/** Extrai de `AnyMessageContent` o shape que contém a chave `K`. */
type MessageContentByKey<K extends string> = Extract<AnyMessageContent, Record<K, unknown>>
/** Shape de conteúdo textual aceito pelo Baileys. */
type TextContent = MessageContentByKey<'text'>

export type CommandSendOptions = MiscMessageGenerationOptions & {
  /**
   * Quando true (padrão), envia citando a mensagem original do comando.
   * Defina false para envio "solto" no chat.
   */
  quote?: boolean
}

/**
 * Opções de inicialização do contexto do comando.
 */
type CommandContextInit = {
  /** JID do chat onde o comando foi enviado. */
  chatId: string
  /** JID do remetente da mensagem. */
  sender: string
  /** Texto completo da mensagem recebida. */
  text: string
  /** Argumentos do comando (texto separado por espaços após o nome do comando). */
  args: string[]
  /** Indica se a mensagem foi enviada em um grupo. */
  isGroup: boolean
  /** Nome do comando invocado. */
  commandName: string
  /** ID único da mensagem original. */
  messageId: string | null
  /** Nome público do remetente (push name). */
  pushName: string | null
  /** JIDs mencionados na mensagem de comando. */
  mentionedJids?: string[]
  /** JID do autor da mensagem citada (quando o comando é enviado como resposta). */
  quotedSender?: string | null
  /** Função interna para envio genérico de mensagens (AnyMessageContent). */
  send: (content: AnyMessageContent, options?: CommandSendOptions) => Promise<WAMessage | undefined>
  /** Função interna para responder à mensagem. */
  reply: (text: string) => Promise<void>
  /** Função interna para reagir à mensagem. */
  react: (emoji: string) => Promise<void>
  /** Ações administrativas disponíveis no contexto. */
  admin: CommandAdminActions
}

/**
 * Contexto normalizado entregue aos comandos.
 * Os detalhes técnicos de socket/mensagem do Baileys ficam encapsulados aqui,
 * fornecendo uma interface simplificada para o desenvolvimento de comandos.
 */
export class CommandContext {
  /** JID do chat onde o comando foi enviado. */
  public readonly chatId: string
  /** JID do remetente da mensagem. */
  public readonly sender: string
  /** Texto completo da mensagem recebida. */
  public readonly text: string
  /** Argumentos do comando (tokens após o nome do comando). */
  public readonly args: string[]
  /** Indica se o chat atual é um grupo. */
  public readonly isGroup: boolean
  /** Nome do comando que disparou esta execução. */
  public readonly commandName: string
  /** ID único da mensagem que originou o comando. */
  public readonly messageId: string | null
  /** Nome público do usuário no WhatsApp. */
  public readonly pushName: string | null
  /** JIDs mencionados na mensagem que disparou o comando. */
  public readonly mentionedJids: string[]
  /** JID do autor da mensagem citada (quando existir). */
  public readonly quotedSender: string | null
  /** Interface de ações administrativas (kick, ban, promote, etc.). */
  public readonly admin: CommandAdminActions

  readonly #sendAction: CommandContextInit['send']
  readonly #replyAction: CommandContextInit['reply']
  readonly #reactAction: CommandContextInit['react']

  /**
   * @param options Dados iniciais do contexto vindos do processador.
   */
  constructor({
    chatId,
    sender,
    text,
    args,
    isGroup,
    commandName,
    messageId,
    pushName,
    mentionedJids = [],
    quotedSender = null,
    send,
    reply,
    react,
    admin,
  }: CommandContextInit) {
    this.chatId = chatId
    this.sender = sender
    this.text = text
    this.args = args
    this.isGroup = isGroup
    this.commandName = commandName
    this.messageId = messageId
    this.pushName = pushName
    this.mentionedJids = mentionedJids
    this.quotedSender = quotedSender
    this.admin = admin
    this.#sendAction = send
    this.#replyAction = reply
    this.#reactAction = react
  }

  /**
   * Envia qualquer payload suportado pelo Baileys (`AnyMessageContent`).
   */
  async send(content: AnyMessageContent, options?: CommandSendOptions): Promise<WAMessage | undefined> {
    return this.#sendAction(content, options)
  }

  /**
   * Responde à mensagem original com um texto.
   * @param text O conteúdo da resposta.
   */
  async reply(text: string): Promise<void> {
    await this.#replyAction(text)
  }

  /**
   * Adiciona uma reação de emoji à mensagem original.
   * @param emoji O emoji a ser usado como reação.
   */
  async react(emoji: string): Promise<void> {
    await this.#reactAction(emoji)
  }

  /**
   * Atalho para envio de texto.
   */
  async sendText(
    text: string,
    extras: Omit<TextContent, 'text'> = {},
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send({ ...extras, text }, options)
  }

  /**
   * Atalhos para todos os tipos de conteúdo aceitos em `AnyMessageContent`.
   */
  async sendImage(content: MessageContentByKey<'image'>, options?: CommandSendOptions): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de vídeo. */
  async sendVideo(content: MessageContentByKey<'video'>, options?: CommandSendOptions): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de áudio. */
  async sendAudio(content: MessageContentByKey<'audio'>, options?: CommandSendOptions): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de sticker. */
  async sendSticker(
    content: MessageContentByKey<'sticker'>,
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de documento. */
  async sendDocument(
    content: MessageContentByKey<'document'>,
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de evento. */
  async sendEvent(content: MessageContentByKey<'event'>, options?: CommandSendOptions): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de enquete. */
  async sendPoll(content: MessageContentByKey<'poll'>, options?: CommandSendOptions): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de contatos. */
  async sendContacts(
    content: MessageContentByKey<'contacts'>,
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de localização. */
  async sendLocation(
    content: MessageContentByKey<'location'>,
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de reação como conteúdo explícito. */
  async sendReaction(
    content: MessageContentByKey<'react'>,
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de resposta de botão. */
  async sendButtonReply(
    content: MessageContentByKey<'buttonReply'>,
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de convite de grupo. */
  async sendGroupInvite(
    content: MessageContentByKey<'groupInvite'>,
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de resposta de lista. */
  async sendListReply(
    content: MessageContentByKey<'listReply'>,
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de fixação (`pin`). */
  async sendPin(content: MessageContentByKey<'pin'>, options?: CommandSendOptions): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para envio de produto. */
  async sendProduct(
    content: MessageContentByKey<'product'>,
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para compartilhar o próprio número no chat. */
  async sendSharePhoneNumber(
    content: MessageContentByKey<'sharePhoneNumber'> = { sharePhoneNumber: true },
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para solicitar compartilhamento de número. */
  async sendRequestPhoneNumber(
    content: MessageContentByKey<'requestPhoneNumber'> = { requestPhoneNumber: true },
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para encaminhar mensagem. */
  async sendForward(
    content: MessageContentByKey<'forward'>,
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para apagar mensagem via payload de delete. */
  async sendDelete(content: MessageContentByKey<'delete'>, options?: CommandSendOptions): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para configurar mensagens temporárias no chat via payload nativo. */
  async setDisappearingMessages(
    content: MessageContentByKey<'disappearingMessagesInChat'>,
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /** Atalho para limitar compartilhamento via payload nativo. */
  async setLimitSharing(
    content: MessageContentByKey<'limitSharing'>,
    options?: CommandSendOptions
  ): Promise<WAMessage | undefined> {
    return this.send(content, options)
  }

  /**
   * Atalho para verificar se o usuário é administrador.
   * @param jid JID a ser verificado. Omissão verifica o sender.
   */
  async isAdmin(jid?: string): Promise<boolean> {
    return this.admin.isAdmin(jid)
  }

  /**
   * Retorna os metadados atuais do grupo.
   */
  async getMetadata() {
    return this.admin.getMetadata()
  }

  /**
   * Adiciona participantes ao grupo.
   * @param participants JID(s) do(s) participante(s).
   */
  async add(participants: ParticipantTarget): Promise<GroupParticipantsUpdateResult> {
    return this.admin.add(participants)
  }

  /**
   * Remove um ou mais participantes do grupo.
   * @param participants JID(s) do(s) participante(s).
   */
  async kick(participants: ParticipantTarget): Promise<GroupParticipantsUpdateResult> {
    return this.admin.kick(participants)
  }

  /**
   * Bane um ou mais participantes do grupo.
   * @param participants JID(s) do(s) participante(s).
   */
  async ban(participants: ParticipantTarget): Promise<GroupParticipantsUpdateResult> {
    return this.admin.ban(participants)
  }

  /**
   * Promove um ou mais participantes a administrador.
   * @param participants JID(s) do(s) participante(s).
   */
  async promote(participants: ParticipantTarget): Promise<GroupParticipantsUpdateResult> {
    return this.admin.promote(participants)
  }

  /**
   * Rebaixa um ou mais administradores a participantes comuns.
   * @param participants JID(s) do(s) participante(s).
   */
  async demote(participants: ParticipantTarget): Promise<GroupParticipantsUpdateResult> {
    return this.admin.demote(participants)
  }

  /**
   * Atualiza o assunto (nome) do grupo.
   */
  async setSubject(subject: string): Promise<void> {
    return this.admin.setSubject(subject)
  }

  /**
   * Atualiza a descrição do grupo.
   */
  async setDescription(description?: string): Promise<void> {
    return this.admin.setDescription(description)
  }

  /**
   * Obtém o código de convite atual do grupo.
   */
  async getInviteCode(): Promise<GroupInviteCodeResult> {
    return this.admin.getInviteCode()
  }

  /**
   * Revoga o código de convite atual do grupo.
   */
  async revokeInvite(): Promise<GroupRevokeInviteResult> {
    return this.admin.revokeInvite()
  }

  /**
   * Define o temporizador de mensagens temporárias do grupo em segundos (0 desativa).
   */
  async setEphemeral(expirationSeconds: number): Promise<void> {
    return this.admin.setEphemeral(expirationSeconds)
  }

  /**
   * Atualiza uma configuração bruta de grupo usando o enum do Baileys.
   */
  async setGroupSetting(setting: GroupSettingValue): Promise<void> {
    return this.admin.setGroupSetting(setting)
  }

  /**
   * Controla se apenas admins podem enviar mensagens no grupo.
   */
  async setAnnouncementMode(enabled: boolean): Promise<void> {
    return this.admin.setAnnouncementMode(enabled)
  }

  /**
   * Controla se apenas admins podem editar informações do grupo.
   */
  async setLockedMode(enabled: boolean): Promise<void> {
    return this.admin.setLockedMode(enabled)
  }

  /**
   * Define quem pode adicionar membros diretamente.
   */
  async setMemberAddMode(mode: GroupMemberAddModeValue): Promise<void> {
    return this.admin.setMemberAddMode(mode)
  }

  /**
   * Ativa/desativa aprovação manual de entrada.
   */
  async setJoinApprovalMode(mode: GroupJoinApprovalModeValue): Promise<void> {
    return this.admin.setJoinApprovalMode(mode)
  }

  /**
   * Lista solicitações pendentes de entrada no grupo.
   */
  async listJoinRequests(): Promise<GroupJoinRequestListResult> {
    return this.admin.listJoinRequests()
  }

  /**
   * Aprova solicitações de entrada de participantes.
   */
  async approveJoinRequests(participants: ParticipantTarget): Promise<GroupJoinRequestUpdateResult> {
    return this.admin.approveJoinRequests(participants)
  }

  /**
   * Rejeita solicitações de entrada de participantes.
   */
  async rejectJoinRequests(participants: ParticipantTarget): Promise<GroupJoinRequestUpdateResult> {
    return this.admin.rejectJoinRequests(participants)
  }
}
