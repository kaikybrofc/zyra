import { beforeEach, describe, expect, it, vi } from 'vitest'
import { antilinkCommand } from '../src/commands/antilink.ts'

const { mockGroupFeatureStore } = vi.hoisted(() => ({
  mockGroupFeatureStore: {
    isAntilinkEnabled: vi.fn(),
    setAntilinkEnabled: vi.fn(),
    getAntilinkAllowedDomains: vi.fn(),
    addAntilinkAllowedDomain: vi.fn(),
    removeAntilinkAllowedDomain: vi.fn(),
    isAntilinkAllowOwnGroupInviteEnabled: vi.fn(),
    setAntilinkAllowOwnGroupInviteEnabled: vi.fn(),
  },
}))

vi.mock('../src/store/group-feature-store.js', () => ({ groupFeatureStore: mockGroupFeatureStore }))

type Ctx = {
  isGroup: boolean
  args: string[]
  chatId: string
  reply: ReturnType<typeof vi.fn>
  isAdmin: ReturnType<typeof vi.fn>
}

const createCtx = (overrides: Partial<Ctx> = {}): Ctx => ({
  isGroup: true,
  args: [],
  chatId: 'grupo@g.us',
  reply: vi.fn().mockResolvedValue(undefined),
  isAdmin: vi.fn().mockResolvedValue(true),
  ...overrides,
})

beforeEach(() => {
  mockGroupFeatureStore.isAntilinkEnabled.mockReset().mockResolvedValue(false)
  mockGroupFeatureStore.setAntilinkEnabled.mockReset().mockResolvedValue(undefined)
  mockGroupFeatureStore.getAntilinkAllowedDomains.mockReset().mockResolvedValue([])
  mockGroupFeatureStore.addAntilinkAllowedDomain.mockReset().mockResolvedValue(undefined)
  mockGroupFeatureStore.removeAntilinkAllowedDomain.mockReset().mockResolvedValue(undefined)
  mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockReset().mockResolvedValue(false)
  mockGroupFeatureStore.setAntilinkAllowOwnGroupInviteEnabled.mockReset().mockResolvedValue(undefined)
})

describe('antilink command', () => {
  it('bloqueia fora de grupo', async () => {
    const ctx = createCtx({ isGroup: false, args: ['on'] })

    await antilinkCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('❌ Este comando só funciona em grupos.')
    expect(mockGroupFeatureStore.setAntilinkEnabled).not.toHaveBeenCalled()
  })

  it('bloqueia para nao admin', async () => {
    const ctx = createCtx({ isAdmin: vi.fn().mockResolvedValue(false), args: ['off'] })

    await antilinkCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('❌ Apenas administradores podem usar este comando.')
    expect(mockGroupFeatureStore.setAntilinkEnabled).not.toHaveBeenCalled()
  })

  it('ativa e desativa antilink', async () => {
    const onCtx = createCtx({ args: ['on'] })
    const offCtx = createCtx({ args: ['off'] })

    await antilinkCommand.execute(onCtx as never)
    await antilinkCommand.execute(offCtx as never)

    expect(mockGroupFeatureStore.setAntilinkEnabled).toHaveBeenNthCalledWith(1, 'grupo@g.us', true)
    expect(mockGroupFeatureStore.setAntilinkEnabled).toHaveBeenNthCalledWith(2, 'grupo@g.us', false)
    expect(onCtx.reply).toHaveBeenCalledWith('✅ Antilink ativado neste grupo.')
    expect(offCtx.reply).toHaveBeenCalledWith('✅ Antilink desativado neste grupo.')
  })

  it('mostra status completo quando sem argumento', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue(['exemplo.com'])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(true)

    const ctx = createCtx({ args: [] })

    await antilinkCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith('ℹ️ Status do antilink: *ATIVADO*\n' + 'ℹ️ Convite do próprio grupo: *PERMITIDO*\n' + 'ℹ️ Whitelist: exemplo.com\n' + 'Uso: !antilink on|off | !antilink allow add|remove|list dominio.com | !antilink invite on|off')
  })

  it('gerencia whitelist: add, list, remove e validacao', async () => {
    const addCtx = createCtx({ args: ['allow', 'add', 'https://www.exemplo.com/path'] })
    const listCtx = createCtx({ args: ['allow', 'list'] })
    const removeCtx = createCtx({ args: ['allow', 'remove', 'exemplo.com'] })
    const invalidCtx = createCtx({ args: ['allow', 'add'] })

    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValueOnce(['exemplo.com'])

    await antilinkCommand.execute(addCtx as never)
    await antilinkCommand.execute(listCtx as never)
    await antilinkCommand.execute(removeCtx as never)
    await antilinkCommand.execute(invalidCtx as never)

    expect(mockGroupFeatureStore.addAntilinkAllowedDomain).toHaveBeenCalledWith('grupo@g.us', 'exemplo.com')
    expect(listCtx.reply).toHaveBeenCalledWith('✅ Domínios permitidos:\n- exemplo.com')
    expect(mockGroupFeatureStore.removeAntilinkAllowedDomain).toHaveBeenCalledWith('grupo@g.us', 'exemplo.com')
    expect(invalidCtx.reply).toHaveBeenCalledWith('Uso: !antilink allow add|remove|list dominio.com')
  })

  it('configura invite on/off e valida uso', async () => {
    const onCtx = createCtx({ args: ['invite', 'on'] })
    const offCtx = createCtx({ args: ['invite', 'off'] })
    const invalidCtx = createCtx({ args: ['invite'] })

    await antilinkCommand.execute(onCtx as never)
    await antilinkCommand.execute(offCtx as never)
    await antilinkCommand.execute(invalidCtx as never)

    expect(mockGroupFeatureStore.setAntilinkAllowOwnGroupInviteEnabled).toHaveBeenNthCalledWith(1, 'grupo@g.us', true)
    expect(mockGroupFeatureStore.setAntilinkAllowOwnGroupInviteEnabled).toHaveBeenNthCalledWith(2, 'grupo@g.us', false)
    expect(onCtx.reply).toHaveBeenCalledWith('✅ Convite do próprio grupo agora está permitido no antilink.')
    expect(offCtx.reply).toHaveBeenCalledWith('✅ Convite do próprio grupo agora está bloqueado no antilink.')
    expect(invalidCtx.reply).toHaveBeenCalledWith('Uso: !antilink invite on|off')
  })
})
