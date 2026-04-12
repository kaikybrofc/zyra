import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockConfig = {
  allowOwnMessages: false,
}

const mockCommands: Record<string, { execute: ReturnType<typeof vi.fn>; name: string; description: string }> = {}

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/commands/index.js', () => ({ commands: mockCommands }))
vi.mock('../src/store/sql-store.js', () => ({
  createSqlStore: vi.fn(() => ({
    enabled: false,
    recordCommandLog: vi.fn(),
  })),
}))

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
})

const createMessage = (text: string, options: { chatId?: string; participant?: string } = {}) =>
  ({
    key: {
      remoteJid: options.chatId ?? 'chat@s.whatsapp.net',
      fromMe: false,
      id: 'msg-1',
      participant: options.participant ?? 'user@s.whatsapp.net',
    },
    pushName: 'Tester',
    message: {
      conversation: text,
    },
    messageTimestamp: 1,
  }) as const

beforeEach(() => {
  for (const key of Object.keys(mockCommands)) {
    delete mockCommands[key]
  }
})

describe('CommandProcessor', () => {
  it('executa comando com ctx fechado e registra log', async () => {
    const sqlStore = {
      enabled: true,
      recordCommandLog: vi.fn(),
    }
    const logger = createLogger()
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])
    const execute = vi.fn(async (ctx) => {
      expect('socket' in ctx).toBe(false)
      expect('message' in ctx).toBe(false)
      expect(ctx.commandName).toBe('ping')
      expect(ctx.args).toEqual(['agora'])
      expect(await ctx.isAdmin()).toBe(true)
      await ctx.reply('pong')
      await ctx.promote('novo-admin@s.whatsapp.net')
    })

    mockCommands.ping = { name: 'ping', description: 'ping', execute }

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
    }

    const { createCommandProcessor } = await import('../src/core/commands/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('!ping agora', { chatId: 'grupo@g.us' }) as never)

    expect(execute).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      'grupo@g.us',
      { text: 'pong' },
      expect.objectContaining({
        quoted: expect.objectContaining({
          key: expect.objectContaining({ id: 'msg-1' }),
        }),
      })
    )
    expect(groupMetadata).toHaveBeenCalledWith('grupo@g.us')
    expect(groupParticipantsUpdate).toHaveBeenCalledWith('grupo@g.us', ['novo-admin@s.whatsapp.net'], 'promote')
    expect(sqlStore.recordCommandLog).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: 'grupo@g.us',
        commandName: 'ping',
        argsText: 'agora',
        success: true,
      })
    )
  })

  it('responde erro interno e registra falha quando comando quebra', async () => {
    const sqlStore = {
      enabled: true,
      recordCommandLog: vi.fn(),
    }
    const logger = createLogger()
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const execute = vi.fn().mockRejectedValue(new Error('boom'))

    mockCommands.ping = { name: 'ping', description: 'ping', execute }

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata: vi.fn(),
      groupParticipantsUpdate: vi.fn(),
    }

    const { createCommandProcessor } = await import('../src/core/commands/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('!ping') as never)

    expect(logger.error).toHaveBeenCalledWith('comando falhou', {
      err: expect.any(Error),
      command: 'ping',
    })
    expect(sendMessage).toHaveBeenCalledWith(
      'chat@s.whatsapp.net',
      { text: '❌ Ocorreu um erro interno ao executar este comando.' },
      expect.any(Object)
    )
    expect(sqlStore.recordCommandLog).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: 'ping',
        success: false,
      })
    )
  })

  it('ignora mensagens sem comando ou invalidas', async () => {
    const logger = createLogger()
    const sendMessage = vi.fn().mockResolvedValue(undefined)

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata: vi.fn(),
      groupParticipantsUpdate: vi.fn(),
    }

    const { buildIncomingCommandEnvelope, createCommandProcessor } = await import('../src/core/commands/processor.ts')
    const processor = createCommandProcessor({ logger })

    expect(buildIncomingCommandEnvelope(sock as never, { key: null, message: null } as never)).toBeNull()

    await processor.process(sock as never, createMessage('ola') as never)

    expect(sendMessage).not.toHaveBeenCalled()
  })
})
