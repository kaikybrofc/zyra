import type { CommandAdminActions, GroupParticipantsUpdateResult, ParticipantTarget } from './admin.js'

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
  /** Interface de ações administrativas (kick, ban, promote, etc.). */
  public readonly admin: CommandAdminActions

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
    this.admin = admin
    this.#replyAction = reply
    this.#reactAction = react
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
   * Atalho para verificar se o usuário é administrador.
   * @param jid JID a ser verificado. Omissão verifica o sender.
   */
  async isAdmin(jid?: string): Promise<boolean> {
    return this.admin.isAdmin(jid)
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
}
