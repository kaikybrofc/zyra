import { beforeEach, describe, expect, it, vi } from 'vitest'
import { welcomeCommand } from '../src/commands/welcome.ts'

const { mockGroupFeatureStore, mockMkdir, mockWriteFile } = vi.hoisted(() => ({
  mockGroupFeatureStore: {
    getWelcomeConfig: vi.fn(),
    getLeaveConfig: vi.fn(),
    setWelcomeEnabled: vi.fn(),
    setWelcomeText: vi.fn(),
    setWelcomeMedia: vi.fn(),
    setLeaveEnabled: vi.fn(),
    setLeaveText: vi.fn(),
  },
  mockMkdir: vi.fn(),
  mockWriteFile: vi.fn(),
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
}))

vi.mock('../src/store/group-feature-store.js', () => ({ groupFeatureStore: mockGroupFeatureStore }))

type Ctx = {
  isGroup: boolean
  args: string[]
  chatId: string
  text: string
  commandName: string
  reply: ReturnType<typeof vi.fn>
  isAdmin: ReturnType<typeof vi.fn>
  getMediaSource: ReturnType<typeof vi.fn>
}

const createCtx = (overrides: Partial<Ctx> = {}): Ctx => ({
  isGroup: true,
  args: [],
  chatId: 'grupo@g.us',
  text: '!welcome',
  commandName: 'welcome',
  reply: vi.fn().mockResolvedValue(undefined),
  isAdmin: vi.fn().mockResolvedValue(true),
  getMediaSource: vi.fn().mockResolvedValue(null),
  ...overrides,
})

beforeEach(() => {
  mockGroupFeatureStore.getWelcomeConfig.mockReset().mockResolvedValue({})
  mockGroupFeatureStore.getLeaveConfig.mockReset().mockResolvedValue({})
  mockGroupFeatureStore.setWelcomeEnabled.mockReset().mockResolvedValue(undefined)
  mockGroupFeatureStore.setWelcomeText.mockReset().mockResolvedValue(undefined)
  mockGroupFeatureStore.setWelcomeMedia.mockReset().mockResolvedValue(undefined)
  mockGroupFeatureStore.setLeaveEnabled.mockReset().mockResolvedValue(undefined)
  mockGroupFeatureStore.setLeaveText.mockReset().mockResolvedValue(undefined)
  mockMkdir.mockReset().mockResolvedValue(undefined)
  mockWriteFile.mockReset().mockResolvedValue(undefined)
})

describe('welcome command', () => {
  it('bloqueia fora de grupo e para nao admin', async () => {
    const privateCtx = createCtx({ isGroup: false, args: ['on'] })
    const memberCtx = createCtx({ isAdmin: vi.fn().mockResolvedValue(false), args: ['on'] })

    await welcomeCommand.execute(privateCtx as never)
    await welcomeCommand.execute(memberCtx as never)

    expect(privateCtx.reply).toHaveBeenCalledWith('❌ Este comando só funciona em grupos.')
    expect(memberCtx.reply).toHaveBeenCalledWith('❌ Apenas administradores podem usar este comando.')
    expect(mockGroupFeatureStore.setWelcomeEnabled).not.toHaveBeenCalled()
  })

  it('ativa, desativa e configura texto', async () => {
    const onCtx = createCtx({ args: ['on'] })
    const offCtx = createCtx({ args: ['off'] })
    const textCtx = createCtx({ args: ['text', 'Oi', '{user}', 'no', '{group}'], text: '!welcome text Oi {user} no {group}' })

    await welcomeCommand.execute(onCtx as never)
    await welcomeCommand.execute(offCtx as never)
    await welcomeCommand.execute(textCtx as never)

    expect(mockGroupFeatureStore.setWelcomeEnabled).toHaveBeenNthCalledWith(1, 'grupo@g.us', true)
    expect(mockGroupFeatureStore.setWelcomeEnabled).toHaveBeenNthCalledWith(2, 'grupo@g.us', false)
    expect(mockGroupFeatureStore.setWelcomeText).toHaveBeenCalledWith('grupo@g.us', 'Oi {user} no {group}')
  })

  it('ativa, desativa e configura texto de saida', async () => {
    const onCtx = createCtx({ args: ['leave', 'on'] })
    const offCtx = createCtx({ args: ['leave', 'off'] })
    const textCtx = createCtx({ args: ['leave', 'text', 'Tchau', '{user}', 'do', '{group}'], text: '!welcome leave text Tchau {user} do {group}' })

    await welcomeCommand.execute(onCtx as never)
    await welcomeCommand.execute(offCtx as never)
    await welcomeCommand.execute(textCtx as never)

    expect(mockGroupFeatureStore.setLeaveEnabled).toHaveBeenNthCalledWith(1, 'grupo@g.us', true)
    expect(mockGroupFeatureStore.setLeaveEnabled).toHaveBeenNthCalledWith(2, 'grupo@g.us', false)
    expect(mockGroupFeatureStore.setLeaveText).toHaveBeenCalledWith('grupo@g.us', 'Tchau {user} do {group}')
  })

  it('salva e remove midia de boas-vindas', async () => {
    const mediaCtx = createCtx({
      args: ['media'],
      getMediaSource: vi.fn().mockResolvedValue({
        buffer: Buffer.from('imagem'),
        type: 'image',
        mimeType: 'image/png',
        fileName: 'foto.png',
      }),
    })
    const removeCtx = createCtx({ args: ['media', 'remove'] })

    await welcomeCommand.execute(mediaCtx as never)
    await welcomeCommand.execute(removeCtx as never)

    expect(mockWriteFile).toHaveBeenCalledWith(expect.stringContaining('.zyra-data/welcome-media/grupo_g.us/'), Buffer.from('imagem'))
    expect(mockGroupFeatureStore.setWelcomeMedia).toHaveBeenNthCalledWith(
      1,
      'grupo@g.us',
      expect.objectContaining({
        type: 'image',
        path: expect.stringContaining('.zyra-data/welcome-media/grupo_g.us/'),
        mimeType: 'image/png',
        fileName: 'foto.png',
      })
    )
    expect(mockGroupFeatureStore.setWelcomeMedia).toHaveBeenNthCalledWith(2, 'grupo@g.us', null)
  })

  it('mostra status quando sem acao valida', async () => {
    mockGroupFeatureStore.getWelcomeConfig.mockResolvedValue({
      enabled: true,
      text: 'Salve {user}',
      media: { type: 'video', path: 'video.mp4' },
    })
    mockGroupFeatureStore.getLeaveConfig.mockResolvedValue({
      enabled: true,
      text: 'Tchau {user}',
    })
    const ctx = createCtx()

    await welcomeCommand.execute(ctx as never)

    expect(ctx.reply).toHaveBeenCalledWith(
      'ℹ️ Status do welcome: *ATIVADO*\n' +
        'ℹ️ Texto: Salve {user}\n' +
        'ℹ️ Mídia: video\n' +
        'ℹ️ Saída: *ATIVADA*\n' +
        'ℹ️ Texto de saída: Tchau {user}\n' +
        'Uso: !welcome on|off | !welcome text mensagem | !welcome media | !welcome media remove | !welcome leave on|off | !welcome leave text mensagem'
    )
  })
})
