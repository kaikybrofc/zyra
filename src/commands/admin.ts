import type { Command } from './types.js'

type AdminGuardResult = { ok: true } | { ok: false }
type ParticipantActionKind = 'add' | 'remove' | 'promote' | 'demote'

const ensureAdminContext = async (ctx: Parameters<Command['execute']>[0]): Promise<AdminGuardResult> => {
  if (!ctx.isGroup) {
    await ctx.reply('❌ Este comando só funciona em grupos.')
    return { ok: false }
  }

  const senderIsAdmin = await ctx.isAdmin()
  if (!senderIsAdmin) {
    await ctx.reply('❌ Apenas administradores podem usar este comando.')
    return { ok: false }
  }

  return { ok: true }
}

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

const parseParticipants = (values: string[]): string[] => {
  const normalized = values.map(normalizeParticipant).filter(Boolean)
  return [...new Set(normalized)]
}

const toComparableJid = (jid: string): string => jid.trim().toLowerCase()

const validateParticipantActionResult = async (
  ctx: Parameters<Command['execute']>[0],
  participants: string[],
  actionKind: ParticipantActionKind
): Promise<boolean> => {
  const metadata = await ctx.getMetadata()
  const participantByJid = new Map(metadata.participants.map((participant) => [toComparableJid(participant.id), participant]))

  switch (actionKind) {
    case 'add':
      return participants.every((jid) => participantByJid.has(toComparableJid(jid)))
    case 'remove':
      return participants.every((jid) => !participantByJid.has(toComparableJid(jid)))
    case 'promote':
      return participants.every((jid) => {
        const participant = participantByJid.get(toComparableJid(jid))
        return Boolean(participant && (participant.admin === 'admin' || participant.admin === 'superadmin'))
      })
    case 'demote':
      return participants.every((jid) => {
        const participant = participantByJid.get(toComparableJid(jid))
        return Boolean(participant && !participant.admin)
      })
    default:
      return false
  }
}

const extractErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim().length > 0) {
      return message
    }
  }
  return 'erro desconhecido'
}

const toFriendlyParticipantActionError = (rawReason: string): string => {
  const reason = rawReason.toLowerCase().trim()

  if (reason.includes('not-authorized') || reason.includes('401') || reason.includes('forbidden')) {
    return 'sem permissão para executar esta ação. Verifique se o bot é admin do grupo'
  }
  if (reason.includes('participant-not-found') || reason.includes('not in group') || reason.includes('404')) {
    return 'participante não encontrado no grupo'
  }
  if (reason.includes('already a participant') || reason.includes('already in group')) {
    return 'o participante já está no grupo'
  }
  if (reason.includes('already admin') || reason.includes('is an admin')) {
    return 'o participante já é administrador'
  }
  if (reason.includes('not admin')) {
    return 'o participante não é administrador'
  }
  if (reason.includes('internal-server-error') || reason === '500') {
    return 'erro interno temporário do WhatsApp. Tente novamente em instantes'
  }
  if (reason.includes('rate-overlimit') || reason.includes('429') || reason.includes('too many requests')) {
    return 'limite de requisições atingido. Aguarde um pouco e tente novamente'
  }

  return rawReason
}

const parseOnOff = (value: string | undefined): boolean | null => {
  if (!value) return null
  const normalized = value.toLowerCase()
  if (['on', '1', 'true', 'ativar', 'aberto'].includes(normalized)) return true
  if (['off', '0', 'false', 'desativar', 'fechado'].includes(normalized)) return false
  return null
}

const parseEphemeral = (value: string | undefined): number | null => {
  if (!value) return null
  const normalized = value.toLowerCase()

  if (['off', '0', 'desativar'].includes(normalized)) return 0
  if (['24h', '1d', '86400'].includes(normalized)) return 86400
  if (['7d', '7dias', '604800'].includes(normalized)) return 604800
  if (['90d', '90dias', '7776000'].includes(normalized)) return 7776000

  const numeric = Number(normalized)
  if (Number.isInteger(numeric) && numeric >= 0) return numeric

  return null
}

const executeParticipantAction = async (
  ctx: Parameters<Command['execute']>[0],
  actionLabel: string,
  actionKind: ParticipantActionKind,
  handler: (participants: string[]) => Promise<unknown>
): Promise<void> => {
  const allowed = await ensureAdminContext(ctx)
  if (!allowed.ok) return

  const participants = parseParticipants([...ctx.args, ...ctx.mentionedJids, ...(ctx.quotedSender ? [ctx.quotedSender] : [])])
  if (!participants.length) {
    await ctx.reply(`Uso: !${ctx.commandName} 5511999999999, @usuario ou respondendo a mensagem do usuário`)
    return
  }

  try {
    await handler(participants)
    await ctx.reply(`✅ ${actionLabel} aplicado para ${participants.length} participante(s).`)
  } catch (error) {
    try {
      const confirmed = await validateParticipantActionResult(ctx, participants, actionKind)
      if (confirmed) {
        await ctx.reply(`✅ ${actionLabel} aplicado para ${participants.length} participante(s).`)
        return
      }
    } catch {
      // Se a validação falhar, mantemos o fluxo de erro amigável abaixo.
    }

    const reason = toFriendlyParticipantActionError(extractErrorMessage(error))
    await ctx.reply(`❌ Falha ao aplicar ${actionLabel.toLowerCase()}: ${reason}.`)
  }
}

export const addCommand: Command = {
  name: 'add',
  description: 'Adiciona um ou mais participantes no grupo',
  async execute(ctx) {
    await executeParticipantAction(ctx, 'Adição', 'add', (participants) => ctx.add(participants))
  },
}

export const kickCommand: Command = {
  name: 'kick',
  description: 'Remove um ou mais participantes do grupo',
  async execute(ctx) {
    await executeParticipantAction(ctx, 'Remoção', 'remove', (participants) => ctx.kick(participants))
  },
}

export const banCommand: Command = {
  name: 'ban',
  description: 'Bane (remove) um ou mais participantes do grupo',
  async execute(ctx) {
    await executeParticipantAction(ctx, 'Banimento', 'remove', (participants) => ctx.ban(participants))
  },
}

export const promoteCommand: Command = {
  name: 'promote',
  description: 'Promove um ou mais participantes a admin',
  async execute(ctx) {
    await executeParticipantAction(ctx, 'Promoção', 'promote', (participants) => ctx.promote(participants))
  },
}

export const demoteCommand: Command = {
  name: 'demote',
  description: 'Remove cargo de admin de participantes',
  async execute(ctx) {
    await executeParticipantAction(ctx, 'Rebaixamento', 'demote', (participants) => ctx.demote(participants))
  },
}

export const groupCommand: Command = {
  name: 'grupo',
  description: 'Abre ou fecha o grupo para envio de mensagens',
  async execute(ctx) {
    const allowed = await ensureAdminContext(ctx)
    if (!allowed.ok) return

    const mode = parseOnOff(ctx.args[0])
    if (mode === null) {
      await ctx.reply('Uso: !grupo on|off')
      return
    }

    await ctx.setAnnouncementMode(mode)
    await ctx.reply(mode ? '✅ Grupo fechado: só admins podem enviar.' : '✅ Grupo aberto para todos enviarem.')
  },
}

export const lockCommand: Command = {
  name: 'lock',
  description: 'Trava ou destrava edição de info do grupo',
  async execute(ctx) {
    const allowed = await ensureAdminContext(ctx)
    if (!allowed.ok) return

    const mode = parseOnOff(ctx.args[0])
    if (mode === null) {
      await ctx.reply('Uso: !lock on|off')
      return
    }

    await ctx.setLockedMode(mode)
    await ctx.reply(mode ? '✅ Edição de info travada para não-admins.' : '✅ Edição de info liberada para todos.')
  },
}

export const subjectCommand: Command = {
  name: 'assunto',
  description: 'Atualiza o assunto (nome) do grupo',
  async execute(ctx) {
    const allowed = await ensureAdminContext(ctx)
    if (!allowed.ok) return

    const subject = ctx.args.join(' ').trim()
    if (!subject) {
      await ctx.reply('Uso: !assunto Novo nome do grupo')
      return
    }

    await ctx.setSubject(subject)
    await ctx.reply('✅ Assunto do grupo atualizado.')
  },
}

export const descriptionCommand: Command = {
  name: 'descricao',
  description: 'Atualiza ou limpa a descrição do grupo',
  async execute(ctx) {
    const allowed = await ensureAdminContext(ctx)
    if (!allowed.ok) return

    const description = ctx.args.join(' ').trim()
    if (!description) {
      await ctx.reply('Uso: !descricao texto... | !descricao limpar')
      return
    }

    if (['limpar', 'clear', 'off'].includes(description.toLowerCase())) {
      await ctx.setDescription(undefined)
      await ctx.reply('✅ Descrição do grupo removida.')
      return
    }

    await ctx.setDescription(description)
    await ctx.reply('✅ Descrição do grupo atualizada.')
  },
}

export const inviteCommand: Command = {
  name: 'linkgrupo',
  description: 'Mostra o link de convite atual do grupo',
  async execute(ctx) {
    const allowed = await ensureAdminContext(ctx)
    if (!allowed.ok) return

    const code = await ctx.getInviteCode()
    await ctx.reply(`🔗 https://chat.whatsapp.com/${code}`)
  },
}

export const revokeInviteCommand: Command = {
  name: 'revogarlink',
  description: 'Revoga o link atual e gera um novo',
  async execute(ctx) {
    const allowed = await ensureAdminContext(ctx)
    if (!allowed.ok) return

    const code = await ctx.revokeInvite()
    await ctx.reply(`✅ Link revogado. Novo link: https://chat.whatsapp.com/${code}`)
  },
}

export const ephemeralCommand: Command = {
  name: 'ephemeral',
  description: 'Controla mensagens temporárias do grupo',
  async execute(ctx) {
    const allowed = await ensureAdminContext(ctx)
    if (!allowed.ok) return

    const duration = parseEphemeral(ctx.args[0])
    if (duration === null) {
      await ctx.reply('Uso: !ephemeral off|24h|7d|90d|<segundos>')
      return
    }

    await ctx.setEphemeral(duration)
    await ctx.reply(duration === 0 ? '✅ Mensagens temporárias desativadas.' : `✅ Mensagens temporárias: ${duration}s.`)
  },
}
