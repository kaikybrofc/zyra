import type { CommandAdminActions, GroupParticipantsUpdateResult, ParticipantTarget } from './admin.js'

type CommandContextInit = {
  chatId: string
  sender: string
  text: string
  args: string[]
  isGroup: boolean
  commandName: string
  messageId: string | null
  pushName: string | null
  reply: (text: string) => Promise<void>
  react: (emoji: string) => Promise<void>
  admin: CommandAdminActions
}

/**
 * Contexto normalizado entregue aos comandos.
 * Os detalhes de socket/mensagem ficam encapsulados no core.
 */
export class CommandContext {
  public readonly chatId: string
  public readonly sender: string
  public readonly text: string
  public readonly args: string[]
  public readonly isGroup: boolean
  public readonly commandName: string
  public readonly messageId: string | null
  public readonly pushName: string | null
  public readonly admin: CommandAdminActions

  readonly #replyAction: CommandContextInit['reply']
  readonly #reactAction: CommandContextInit['react']

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

  async reply(text: string): Promise<void> {
    await this.#replyAction(text)
  }

  async react(emoji: string): Promise<void> {
    await this.#reactAction(emoji)
  }

  async isAdmin(jid?: string): Promise<boolean> {
    return this.admin.isAdmin(jid)
  }

  async kick(participants: ParticipantTarget): Promise<GroupParticipantsUpdateResult> {
    return this.admin.kick(participants)
  }

  async ban(participants: ParticipantTarget): Promise<GroupParticipantsUpdateResult> {
    return this.admin.ban(participants)
  }

  async promote(participants: ParticipantTarget): Promise<GroupParticipantsUpdateResult> {
    return this.admin.promote(participants)
  }

  async demote(participants: ParticipantTarget): Promise<GroupParticipantsUpdateResult> {
    return this.admin.demote(participants)
  }
}
