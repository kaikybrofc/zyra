import { describe, expect, it, vi } from 'vitest'
import {
  addCommand,
  banCommand,
  demoteCommand,
  descriptionCommand,
  ephemeralCommand,
  groupCommand,
  inviteCommand,
  kickCommand,
  lockCommand,
  promoteCommand,
  revokeInviteCommand,
  subjectCommand,
} from '../src/commands/admin.ts'

type AdminCtx = {
  isGroup: boolean
  args: string[]
  commandName: string
  mentionedJids: string[]
  quotedSender: string | null
  reply: ReturnType<typeof vi.fn>
  isAdmin: ReturnType<typeof vi.fn>
  add: ReturnType<typeof vi.fn>
  kick: ReturnType<typeof vi.fn>
  ban: ReturnType<typeof vi.fn>
  promote: ReturnType<typeof vi.fn>
  demote: ReturnType<typeof vi.fn>
  setAnnouncementMode: ReturnType<typeof vi.fn>
  setLockedMode: ReturnType<typeof vi.fn>
  setSubject: ReturnType<typeof vi.fn>
  setDescription: ReturnType<typeof vi.fn>
  getInviteCode: ReturnType<typeof vi.fn>
  revokeInvite: ReturnType<typeof vi.fn>
  setEphemeral: ReturnType<typeof vi.fn>
  getMetadata: ReturnType<typeof vi.fn>
}

const createCtx = (overrides: Partial<AdminCtx> = {}): AdminCtx => ({
  isGroup: true,
  args: [],
  commandName: 'admincmd',
  mentionedJids: [],
  quotedSender: null,
  reply: vi.fn().mockResolvedValue(undefined),
  isAdmin: vi.fn().mockResolvedValue(true),
  add: vi.fn().mockResolvedValue([]),
  kick: vi.fn().mockResolvedValue([]),
  ban: vi.fn().mockResolvedValue([]),
  promote: vi.fn().mockResolvedValue([]),
  demote: vi.fn().mockResolvedValue([]),
  setAnnouncementMode: vi.fn().mockResolvedValue(undefined),
  setLockedMode: vi.fn().mockResolvedValue(undefined),
  setSubject: vi.fn().mockResolvedValue(undefined),
  setDescription: vi.fn().mockResolvedValue(undefined),
  getInviteCode: vi.fn().mockResolvedValue('ABC123'),
  revokeInvite: vi.fn().mockResolvedValue('NEW456'),
  setEphemeral: vi.fn().mockResolvedValue(undefined),
  getMetadata: vi.fn().mockResolvedValue({
    participants: [],
  }),
  ...overrides,
})

describe('admin commands', () => {
  it('bloqueia comando fora de grupo', async () => {
    const ctx = createCtx({ isGroup: false, commandName: 'add', args: ['5511999999999'] })

    await addCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('❌ Este comando só funciona em grupos.')
    expect(ctx.add).not.toHaveBeenCalled()
  })

  it('bloqueia comando para nao admin', async () => {
    const ctx = createCtx({ isAdmin: vi.fn().mockResolvedValue(false), commandName: 'kick', args: ['5511999999999'] })

    await kickCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('❌ Apenas administradores podem usar este comando.')
    expect(ctx.kick).not.toHaveBeenCalled()
  })

  it('normaliza participantes e remove duplicados em add', async () => {
    const ctx = createCtx({ commandName: 'add', args: ['+55 (11) 99999-9999', '5511999999999', 'foo', 'JID@S.WHATSAPP.NET'] })

    await addCommand.execute(ctx as never)

    expect(ctx.add).toHaveBeenCalledWith(['5511999999999@s.whatsapp.net', 'jid@s.whatsapp.net'])
    expect(ctx.reply).toHaveBeenLastCalledWith('✅ Adição aplicado para 2 participante(s).')
  })

  it('retorna uso quando comando de participante nao recebe alvo', async () => {
    const ctx = createCtx({ commandName: 'ban' })

    await banCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith(
      'Uso: !ban 5511999999999, @usuario ou respondendo a mensagem do usuário'
    )
    expect(ctx.ban).not.toHaveBeenCalled()
  })

  it('executa kick/promote/demote com lista de participantes', async () => {
    const kickCtx = createCtx({ commandName: 'kick', args: ['5511111111111', '5522222222222'] })
    const promoteCtx = createCtx({ commandName: 'promote', args: ['5533333333333'] })
    const demoteCtx = createCtx({ commandName: 'demote', args: ['admin@s.whatsapp.net'] })

    await kickCommand.execute(kickCtx as never)
    await promoteCommand.execute(promoteCtx as never)
    await demoteCommand.execute(demoteCtx as never)

    expect(kickCtx.kick).toHaveBeenCalledWith(['5511111111111@s.whatsapp.net', '5522222222222@s.whatsapp.net'])
    expect(promoteCtx.promote).toHaveBeenCalledWith(['5533333333333@s.whatsapp.net'])
    expect(demoteCtx.demote).toHaveBeenCalledWith(['admin@s.whatsapp.net'])
  })

  it('aceita alvo por mencao no comando', async () => {
    const ctx = createCtx({ commandName: 'kick', mentionedJids: ['5511888888888@s.whatsapp.net'] })

    await kickCommand.execute(ctx as never)

    expect(ctx.kick).toHaveBeenCalledWith(['5511888888888@s.whatsapp.net'])
  })

  it('aceita alvo ao responder mensagem de outro usuario', async () => {
    const ctx = createCtx({ commandName: 'promote', quotedSender: '5511777777777@s.whatsapp.net' })

    await promoteCommand.execute(ctx as never)

    expect(ctx.promote).toHaveBeenCalledWith(['5511777777777@s.whatsapp.net'])
  })

  it('trata erro de API em comando de participante sem quebrar a execucao', async () => {
    const ctx = createCtx({
      commandName: 'ban',
      args: ['5511999999999'],
      ban: vi.fn().mockRejectedValue(new Error('internal-server-error')),
      getMetadata: vi.fn().mockResolvedValue({
        participants: [{ id: '5511999999999@s.whatsapp.net' }],
      }),
    })

    await expect(banCommand.execute(ctx as never)).resolves.toBeUndefined()

    expect(ctx.reply).toHaveBeenCalledWith(
      '❌ Falha ao aplicar banimento: erro interno temporário do WhatsApp. Tente novamente em instantes.'
    )
  })

  it('confirma sucesso quando API retorna erro mas o usuario ja foi removido', async () => {
    const ctx = createCtx({
      commandName: 'ban',
      args: ['5511999999999'],
      ban: vi.fn().mockRejectedValue(new Error('internal-server-error')),
      getMetadata: vi.fn().mockResolvedValue({
        participants: [],
      }),
    })

    await banCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('✅ Banimento aplicado para 1 participante(s).')
  })

  it('traduz erros comuns de permissao e participante nao encontrado', async () => {
    const notAuthorizedCtx = createCtx({
      commandName: 'kick',
      args: ['5511999999999'],
      kick: vi.fn().mockRejectedValue(new Error('not-authorized')),
      getMetadata: vi.fn().mockResolvedValue({
        participants: [{ id: '5511999999999@s.whatsapp.net' }],
      }),
    })
    const notFoundCtx = createCtx({
      commandName: 'promote',
      args: ['5511888888888'],
      promote: vi.fn().mockRejectedValue(new Error('participant-not-found')),
    })

    await kickCommand.execute(notAuthorizedCtx as never)
    await promoteCommand.execute(notFoundCtx as never)

    expect(notAuthorizedCtx.reply).toHaveBeenCalledWith(
      '❌ Falha ao aplicar remoção: sem permissão para executar esta ação. Verifique se o bot é admin do grupo.'
    )
    expect(notFoundCtx.reply).toHaveBeenCalledWith('❌ Falha ao aplicar promoção: participante não encontrado no grupo.')
  })

  it('traduz internal-server-error para mensagem amigavel', async () => {
    const ctx = createCtx({
      commandName: 'ban',
      args: ['5511999999999'],
      ban: vi.fn().mockRejectedValue(new Error('internal-server-error')),
      getMetadata: vi.fn().mockResolvedValue({
        participants: [{ id: '5511999999999@s.whatsapp.net' }],
      }),
    })

    await banCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith(
      '❌ Falha ao aplicar banimento: erro interno temporário do WhatsApp. Tente novamente em instantes.'
    )
  })

  it('grupo aplica announcement mode e aceita sinonimos de on/off', async () => {
    const onCtx = createCtx({ args: ['aberto'] })
    const offCtx = createCtx({ args: ['fechado'] })

    await groupCommand.execute(onCtx as never)
    await groupCommand.execute(offCtx as never)

    expect(onCtx.setAnnouncementMode).toHaveBeenCalledWith(true)
    expect(onCtx.reply).toHaveBeenLastCalledWith('✅ Grupo fechado: só admins podem enviar.')
    expect(offCtx.setAnnouncementMode).toHaveBeenCalledWith(false)
    expect(offCtx.reply).toHaveBeenLastCalledWith('✅ Grupo aberto para todos enviarem.')
  })

  it('grupo retorna instrucoes quando arg e invalido', async () => {
    const ctx = createCtx({ args: ['talvez'] })

    await groupCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('Uso: !grupo on|off')
    expect(ctx.setAnnouncementMode).not.toHaveBeenCalled()
  })

  it('lock aplica modo e valida argumento', async () => {
    const onCtx = createCtx({ args: ['on'] })
    const invalidCtx = createCtx({ args: [] })

    await lockCommand.execute(onCtx as never)
    await lockCommand.execute(invalidCtx as never)

    expect(onCtx.setLockedMode).toHaveBeenCalledWith(true)
    expect(onCtx.reply).toHaveBeenLastCalledWith('✅ Edição de info travada para não-admins.')
    expect(invalidCtx.reply).toHaveBeenCalledWith('Uso: !lock on|off')
    expect(invalidCtx.setLockedMode).not.toHaveBeenCalled()
  })

  it('assunto atualiza e valida texto obrigatorio', async () => {
    const okCtx = createCtx({ args: ['Novo', 'Nome'] })
    const invalidCtx = createCtx({ args: [] })

    await subjectCommand.execute(okCtx as never)
    await subjectCommand.execute(invalidCtx as never)

    expect(okCtx.setSubject).toHaveBeenCalledWith('Novo Nome')
    expect(okCtx.reply).toHaveBeenLastCalledWith('✅ Assunto do grupo atualizado.')
    expect(invalidCtx.reply).toHaveBeenCalledWith('Uso: !assunto Novo nome do grupo')
    expect(invalidCtx.setSubject).not.toHaveBeenCalled()
  })

  it('descricao atualiza, limpa e valida uso', async () => {
    const updateCtx = createCtx({ args: ['descricao', 'nova'] })
    const clearCtx = createCtx({ args: ['limpar'] })
    const invalidCtx = createCtx({ args: [] })

    await descriptionCommand.execute(updateCtx as never)
    await descriptionCommand.execute(clearCtx as never)
    await descriptionCommand.execute(invalidCtx as never)

    expect(updateCtx.setDescription).toHaveBeenCalledWith('descricao nova')
    expect(updateCtx.reply).toHaveBeenLastCalledWith('✅ Descrição do grupo atualizada.')
    expect(clearCtx.setDescription).toHaveBeenCalledWith(undefined)
    expect(clearCtx.reply).toHaveBeenLastCalledWith('✅ Descrição do grupo removida.')
    expect(invalidCtx.reply).toHaveBeenCalledWith('Uso: !descricao texto... | !descricao limpar')
  })

  it('linkgrupo responde URL de convite atual', async () => {
    const ctx = createCtx({ getInviteCode: vi.fn().mockResolvedValue('INVITECODE') })

    await inviteCommand.execute(ctx as never)

    expect(ctx.getInviteCode).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith('🔗 https://chat.whatsapp.com/INVITECODE')
  })

  it('revogarlink revoga e envia novo link', async () => {
    const ctx = createCtx({ revokeInvite: vi.fn().mockResolvedValue('NOVOCODE') })

    await revokeInviteCommand.execute(ctx as never)

    expect(ctx.revokeInvite).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith('✅ Link revogado. Novo link: https://chat.whatsapp.com/NOVOCODE')
  })

  it('ephemeral aceita presets, off e segundos', async () => {
    const offCtx = createCtx({ args: ['off'] })
    const presetCtx = createCtx({ args: ['7d'] })
    const secondsCtx = createCtx({ args: ['120'] })

    await ephemeralCommand.execute(offCtx as never)
    await ephemeralCommand.execute(presetCtx as never)
    await ephemeralCommand.execute(secondsCtx as never)

    expect(offCtx.setEphemeral).toHaveBeenCalledWith(0)
    expect(offCtx.reply).toHaveBeenLastCalledWith('✅ Mensagens temporárias desativadas.')
    expect(presetCtx.setEphemeral).toHaveBeenCalledWith(604800)
    expect(presetCtx.reply).toHaveBeenLastCalledWith('✅ Mensagens temporárias: 604800s.')
    expect(secondsCtx.setEphemeral).toHaveBeenCalledWith(120)
    expect(secondsCtx.reply).toHaveBeenLastCalledWith('✅ Mensagens temporárias: 120s.')
  })

  it('ephemeral valida argumento', async () => {
    const ctx = createCtx({ args: ['abc'] })

    await ephemeralCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('Uso: !ephemeral off|24h|7d|90d|<segundos>')
    expect(ctx.setEphemeral).not.toHaveBeenCalled()
  })
})
