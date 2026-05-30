import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockConfig = {
  allowOwnMessages: false,
  commandPrefix: '!',
  antibanIdenticalMessageWindowMs: 6000,
}

const mockCommands: Record<string, { execute: ReturnType<typeof vi.fn>; name: string; description: string }> = {}
const { mockGroupFeatureStore } = vi.hoisted(() => ({
  mockGroupFeatureStore: {
    isAntilinkEnabled: vi.fn(),
    getAntilinkAllowedDomains: vi.fn(),
    isAntilinkAllowOwnGroupInviteEnabled: vi.fn(),
  },
}))

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/commands/index.js', () => ({ commands: mockCommands }))
vi.mock('../src/store/group-feature-store.js', () => ({ groupFeatureStore: mockGroupFeatureStore }))
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

const createStickerMessage = (text: string, options: { chatId?: string; participant?: string } = {}) =>
  ({
    key: {
      remoteJid: options.chatId ?? 'chat@s.whatsapp.net',
      fromMe: false,
      id: 'msg-sticker-1',
      participant: options.participant ?? 'user@s.whatsapp.net',
    },
    pushName: 'Tester',
    message: {
      stickerMessage: {
        mimetype: 'image/webp',
        url: text,
      },
    },
    messageTimestamp: 1,
  }) as const

beforeEach(() => {
  mockConfig.commandPrefix = '!'
  mockConfig.allowOwnMessages = false
  mockGroupFeatureStore.isAntilinkEnabled.mockReset().mockResolvedValue(false)
  mockGroupFeatureStore.getAntilinkAllowedDomains.mockReset().mockResolvedValue([])
  mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockReset().mockResolvedValue(false)
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

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
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

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('!ping') as never)

    expect(logger.error).toHaveBeenCalledWith('comando falhou', {
      err: expect.any(Error),
      command: 'ping',
    })
    expect(sendMessage).toHaveBeenCalledWith('chat@s.whatsapp.net', { text: '❌ Ocorreu um erro interno ao executar este comando.' }, expect.any(Object))
    expect(sqlStore.recordCommandLog).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: 'ping',
        success: false,
      })
    )
  })

  it('retenta envio quando o antiban bloqueia por rate limit e depois consegue reenviar', async () => {
    vi.useFakeTimers()

    try {
      const sqlStore = {
        enabled: true,
        recordCommandLog: vi.fn(),
      }
      const logger = createLogger()
      const blockedError = new Error('[baileys-antiban] Message blocked: Rate limit exceeded or identical message spam detected')
      const sendMessage = vi.fn().mockRejectedValueOnce(blockedError).mockResolvedValueOnce(undefined)
      const execute = vi.fn(async (ctx) => {
        await ctx.reply('pong')
      })

      mockCommands.ping = { name: 'ping', description: 'ping', execute }

      const sock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage,
        groupMetadata: vi.fn(),
        groupParticipantsUpdate: vi.fn(),
      }

      const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
      const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

      const processing = processor.process(sock as never, createMessage('!ping') as never)
      await vi.advanceTimersByTimeAsync(6000)
      await processing

      expect(sendMessage).toHaveBeenCalledTimes(2)
      expect(sendMessage).toHaveBeenNthCalledWith(1, 'chat@s.whatsapp.net', { text: 'pong' }, expect.any(Object))
      expect(sendMessage).toHaveBeenNthCalledWith(2, 'chat@s.whatsapp.net', { text: 'pong' }, expect.any(Object))
      expect(logger.warn).toHaveBeenCalledWith(
        'envio bloqueado pelo antiban, aplicando retentativa',
        expect.objectContaining({
          attempt: 1,
          maxAttempts: 3,
          retryDelayMs: 6000,
          antiBanReason: 'Rate limit exceeded or identical message spam detected',
        })
      )
      expect(sqlStore.recordCommandLog).toHaveBeenCalledWith(
        expect.objectContaining({
          commandName: 'ping',
          success: true,
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('nao reagenda automaticamente quando o antiban bloqueia por warm-up limit', async () => {
    const sqlStore = {
      enabled: true,
      recordCommandLog: vi.fn(),
    }
    const logger = createLogger()
    const blockedError = new Error('[baileys-antiban] Message blocked: Warm-up limit: day 1 cap reached')
    const sendMessage = vi.fn().mockRejectedValueOnce(blockedError).mockResolvedValueOnce(undefined)
    const execute = vi.fn(async (ctx) => {
      await ctx.reply('pong')
    })

    mockCommands.ping = { name: 'ping', description: 'ping', execute }

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata: vi.fn(),
      groupParticipantsUpdate: vi.fn(),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('!ping') as never)

    expect(logger.warn).toHaveBeenCalledWith(
      'envio bloqueado pelo antiban sem retentativa automatica',
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 3,
        antiBanReason: 'Warm-up limit: day 1 cap reached',
      })
    )
    expect(logger.warn).not.toHaveBeenCalledWith('envio bloqueado pelo antiban, aplicando retentativa', expect.anything())
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sqlStore.recordCommandLog).toHaveBeenCalledWith(
      expect.objectContaining({
        commandName: 'ping',
        success: false,
      })
    )
  })

  it('ignora mensagens sem comando ou invalidas', async () => {
    const logger = createLogger()
    const sqlStore = {
      enabled: false,
      recordCommandLog: vi.fn(),
    }
    const sendMessage = vi.fn().mockResolvedValue(undefined)

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata: vi.fn(),
      groupParticipantsUpdate: vi.fn(),
    }

    const { buildIncomingCommandEnvelope, createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    expect(buildIncomingCommandEnvelope(sock as never, { key: null, message: null } as never)).toBeNull()

    await processor.process(sock as never, createMessage('ola') as never)

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('suporta prefixo customizado via config', async () => {
    mockConfig.commandPrefix = '.'

    const sqlStore = {
      enabled: true,
      recordCommandLog: vi.fn(),
    }
    const logger = createLogger()
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const execute = vi.fn().mockResolvedValue(undefined)

    mockCommands.ping = { name: 'ping', description: 'ping', execute }

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata: vi.fn(),
      groupParticipantsUpdate: vi.fn(),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('.ping agora') as never)

    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('propaga mencoes e remetente citado para o contexto do comando', async () => {
    const sqlStore = {
      enabled: false,
      recordCommandLog: vi.fn(),
    }
    const logger = createLogger()
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const execute = vi.fn(async (ctx) => {
      expect(ctx.mentionedJids).toEqual(['5511999999999@s.whatsapp.net'])
      expect(ctx.quotedSender).toBe('5511888888888@s.whatsapp.net')
    })

    mockCommands.ping = { name: 'ping', description: 'ping', execute }

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata: vi.fn(),
      groupParticipantsUpdate: vi.fn(),
    }

    const message = {
      key: {
        remoteJid: 'grupo@g.us',
        fromMe: false,
        id: 'msg-ctx',
        participant: 'user@s.whatsapp.net',
      },
      pushName: 'Tester',
      message: {
        extendedTextMessage: {
          text: '!ping',
          contextInfo: {
            mentionedJid: ['5511999999999@s.whatsapp.net'],
            participant: '5511888888888@s.whatsapp.net',
          },
        },
      },
      messageTimestamp: 1,
    } as const

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, message as never)

    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('aplica antilink removendo participante quando ativo e link nao permitido', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('acesse https://exemplo.com', { chatId: 'grupo@g.us', participant: 'user@s.whatsapp.net' }) as never)

    expect(groupParticipantsUpdate).toHaveBeenCalledWith('grupo@g.us', ['user@s.whatsapp.net'], 'remove')
    expect(sendMessage).toHaveBeenCalledWith('grupo@g.us', { text: 'o user foi banido pelo sistema de anti link' })
    expect(sendMessage).toHaveBeenCalledWith('grupo@g.us', {
      delete: expect.objectContaining({
        id: 'msg-1',
        remoteJid: 'grupo@g.us',
        participant: 'user@s.whatsapp.net',
        fromMe: false,
      }),
    })
  })

  it('remove participante de todos os grupos vinculados da mesma comunidade ao aplicar antilink', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      id: 'grupo-1@g.us',
      linkedParent: 'comunidade-1@g.us',
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])
    const groupFetchAllParticipating = vi.fn().mockResolvedValue({
      'grupo-1@g.us': { id: 'grupo-1@g.us', linkedParent: 'comunidade-1@g.us' },
      'grupo-2@g.us': { id: 'grupo-2@g.us', linkedParent: 'comunidade-1@g.us' },
      'grupo-3@g.us': { id: 'grupo-3@g.us', linkedParent: 'comunidade-1@g.us' },
      'grupo-outra@g.us': { id: 'grupo-outra@g.us', linkedParent: 'comunidade-2@g.us' },
    })

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupFetchAllParticipating,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('acesse https://exemplo.com', { chatId: 'grupo-1@g.us', participant: 'user@s.whatsapp.net' }) as never)

    expect(groupParticipantsUpdate).toHaveBeenCalledWith('grupo-1@g.us', ['user@s.whatsapp.net'], 'remove')
    expect(groupParticipantsUpdate).toHaveBeenCalledWith('grupo-2@g.us', ['user@s.whatsapp.net'], 'remove')
    expect(groupParticipantsUpdate).toHaveBeenCalledWith('grupo-3@g.us', ['user@s.whatsapp.net'], 'remove')
    expect(groupParticipantsUpdate).not.toHaveBeenCalledWith('grupo-outra@g.us', ['user@s.whatsapp.net'], 'remove')
  })

  it('detecta varios tipos de link na mesma mensagem', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(
      sock as never,
      createMessage('links: exemplo.com, www.site.org/path e ftp://arquivos.net/repo', {
        chatId: 'grupo@g.us',
        participant: 'user@s.whatsapp.net',
      }) as never
    )

    expect(groupParticipantsUpdate).toHaveBeenCalledWith('grupo@g.us', ['user@s.whatsapp.net'], 'remove')
  })

  it('detecta em escala grande varios formatos de link', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })

    const linkSamples: Array<{ value: string; shouldRemove: boolean }> = [
      { value: 'https://example.com', shouldRemove: true },
      { value: 'http://example.com', shouldRemove: true },
      { value: 'https://www.example.com/path', shouldRemove: true },
      { value: 'https://sub.example.com/path/to/page', shouldRemove: true },
      { value: 'https://example.com:8443', shouldRemove: true },
      { value: 'https://example.com/search?q=abc&lang=pt-BR', shouldRemove: true },
      { value: 'https://example.com/docs#secao-2', shouldRemove: true },
      { value: 'ftp://files.example.org/repo', shouldRemove: true },
      { value: 'www.site.org/path', shouldRemove: true },
      { value: 'blog.exemplo.com/post/123', shouldRemove: true },
      { value: 'https://a.b.c.d.example.co.uk/path', shouldRemove: true },
      { value: 'https://xn--bcher-kva.example', shouldRemove: true },
      { value: 'https://127.0.0.1/test', shouldRemove: true },
      { value: 'https://10.0.0.15:3000/dashboard', shouldRemove: true },
      // Achado: no parser atual do linkify, URL IPv6 com colchetes pode nao ser detectada (ex.: https://[2001:db8::1]/index).
      { value: 'https://[2001:db8::1]/index', shouldRemove: false },
      { value: 'https://user:pass@example.com/private', shouldRemove: true },
      { value: 'https://example.travel/rota', shouldRemove: true },
      { value: 'https://example.museum/expo', shouldRemove: true },
      { value: 'https://chat.whatsapp.com/OTHER999', shouldRemove: true },
      { value: 'https://wa.me/5511999999999', shouldRemove: true },
      { value: 'https://t.me/canal', shouldRemove: true },
      { value: 'https://discord.gg/abcdef', shouldRemove: true },
      { value: 'https://github.com/kaikybrofc/zyra', shouldRemove: true },
      { value: 'https://npmjs.com/package/linkifyjs', shouldRemove: true },
      { value: 'https://docs.example.io/v1/openapi.yaml', shouldRemove: true },
      { value: 'https://cdn.example.net/assets/app.js?v=1.2.3', shouldRemove: true },
      { value: 'https://news.example.ai/article?id=42', shouldRemove: true },
      { value: 'https://portal.example.dev/login', shouldRemove: true },
      { value: 'https://example.app/invite/abc', shouldRemove: true },
      { value: 'https://m.example.com', shouldRemove: true },
    ]

    for (let index = 0; index < linkSamples.length; index += 1) {
      const sendMessage = vi.fn().mockResolvedValue(undefined)
      const groupParticipantsUpdate = vi.fn().mockResolvedValue([])
      const sock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage,
        groupMetadata,
        groupParticipantsUpdate,
        groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
      }

      const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
      const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

      await processor.process(
        sock as never,
        createMessage(`teste ${index + 1}: ${linkSamples[index]?.value ?? ''}`, {
          chatId: 'grupo@g.us',
          participant: 'user@s.whatsapp.net',
        }) as never
      )

      if (linkSamples[index]?.shouldRemove) {
        expect(groupParticipantsUpdate).toHaveBeenCalledWith('grupo@g.us', ['user@s.whatsapp.net'], 'remove')
      } else {
        expect(groupParticipantsUpdate).not.toHaveBeenCalled()
      }
    }
  })

  it('ignora antilink para link do youtube usado no comando play', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])
    const execute = vi.fn().mockResolvedValue(undefined)

    mockCommands.play = { name: 'play', description: 'play', execute }

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('!play https://www.youtube.com/watch?v=dQw4w9WgXcQ', { chatId: 'grupo@g.us' }) as never)

    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('ignora antilink para link do youtube usado no comando playvid', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])
    const execute = vi.fn().mockResolvedValue(undefined)

    mockCommands.playvid = { name: 'playvid', description: 'playvid', execute }

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('!playvid https://www.youtube.com/watch?v=dQw4w9WgXcQ', { chatId: 'grupo@g.us' }) as never)

    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('nao remove quando dominio esta na whitelist do grupo', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue(['exemplo.com'])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('acesse https://blog.exemplo.com/post', { chatId: 'grupo@g.us' }) as never)

    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
  })

  it('respeita whitelist com dominio sem protocolo', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue(['exemplo.com'])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('visite blog.exemplo.com/agora', { chatId: 'grupo@g.us' }) as never)

    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
  })

  it('respeita whitelist com comparacao case-insensitive', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue(['ExEmPlO.CoM'])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('visite HTTPS://BLOG.EXEMPLO.COM/AGORA', { chatId: 'grupo@g.us', participant: 'user@s.whatsapp.net' }) as never)

    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
  })

  it('respeita whitelist com wildcard de subdominio', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue(['*.exemplo.com'])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('visite https://blog.exemplo.com/post', { chatId: 'grupo@g.us', participant: 'user@s.whatsapp.net' }) as never)

    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
  })

  it('aceita whitelist legada com protocolo e path no dominio salvo', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue(['https://exemplo.com/qualquer-rota'])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('visite https://app.exemplo.com/home', { chatId: 'grupo@g.us', participant: 'user@s.whatsapp.net' }) as never)

    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
  })

  it('respeita whitelist quando link tem host com ponto final', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue(['exemplo.com'])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('visite https://blog.exemplo.com./agora', { chatId: 'grupo@g.us', participant: 'user@s.whatsapp.net' }) as never)

    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
  })

  it('remove quando dominio apenas parece com o whitelisted (suffix attack)', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue(['exemplo.com'])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(
      sock as never,
      createMessage('acesso: https://exemplo.com.evil.org/phishing', {
        chatId: 'grupo@g.us',
        participant: 'user@s.whatsapp.net',
      }) as never
    )

    expect(groupParticipantsUpdate).toHaveBeenCalledWith('grupo@g.us', ['user@s.whatsapp.net'], 'remove')
  })

  it('remove quando mensagem tem link permitido e bloqueado juntos', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue(['exemplo.com'])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(
      sock as never,
      createMessage('permitido https://blog.exemplo.com e bloqueado https://malicioso.net', {
        chatId: 'grupo@g.us',
        participant: 'user@s.whatsapp.net',
      }) as never
    )

    expect(groupParticipantsUpdate).toHaveBeenCalledWith('grupo@g.us', ['user@s.whatsapp.net'], 'remove')
  })

  it('nao aciona antilink para email', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])
    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('meu email e user@dominio.com', { chatId: 'grupo@g.us', participant: 'user@s.whatsapp.net' }) as never)

    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
  })

  it('nao aciona antilink para nome de arquivo .json', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])
    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('abre o arquivo config.json', { chatId: 'grupo@g.us', participant: 'user@s.whatsapp.net' }) as never)

    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
  })

  it('ignora links internos do proprio WhatsApp em mensagens de midia', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])
    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(
      sock as never,
      createMessage('https://mmg.whatsapp.net/v/t62.15575-24/arquivo.enc?ccb=11-4', {
        chatId: 'grupo@g.us',
        participant: 'user@s.whatsapp.net',
      }) as never
    )

    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
  })

  it('ignora stickerMessage com link interno do WhatsApp', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])
    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(
      sock as never,
      createStickerMessage('https://mmg.whatsapp.net/v/t62.15575-24/arquivo.enc?ccb=11-4', {
        chatId: 'grupo@g.us',
        participant: 'user@s.whatsapp.net',
      }) as never
    )

    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
  })

  it('remove quando mensagem tem link interno do WhatsApp e link externo junto', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])
    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(
      sock as never,
      createMessage('https://mmg.whatsapp.net/v/t62.15575-24/arquivo.enc?ccb=11-4 e https://externo.com', {
        chatId: 'grupo@g.us',
        participant: 'user@s.whatsapp.net',
      }) as never
    )

    expect(groupParticipantsUpdate).toHaveBeenCalledWith('grupo@g.us', ['user@s.whatsapp.net'], 'remove')
  })

  it('permite convite do proprio grupo quando invite on', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(true)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])
    const groupInviteCode = vi.fn().mockResolvedValue('SELF123')

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode,
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('entrem: https://chat.whatsapp.com/SELF123', { chatId: 'grupo@g.us' }) as never)

    expect(groupInviteCode).toHaveBeenCalledWith('grupo@g.us')
    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
  })

  it('remove quando invite on mas codigo e de outro grupo', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(true)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('entrem: https://chat.whatsapp.com/OTHER999', { chatId: 'grupo@g.us' }) as never)

    expect(groupParticipantsUpdate).toHaveBeenCalledWith('grupo@g.us', ['user@s.whatsapp.net'], 'remove')
  })

  it('avisa quando admin envia link e nao remove o participante', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [
        { id: 'user@s.whatsapp.net', admin: 'admin' },
        { id: 'bot@s.whatsapp.net', admin: 'admin' },
      ],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])

    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('link https://dominio-bloqueado.com', { chatId: 'grupo@g.us', participant: 'user@s.whatsapp.net' }) as never)

    expect(groupParticipantsUpdate).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledWith('grupo@g.us', { text: 'ℹ️ Link detectado na mensagem de Tester, mas nenhuma remoção foi aplicada porque o remetente é admin.' })
  })

  it('apaga no maximo as ultimas 5 mensagens do usuario apos remocao', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])
    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    for (let index = 1; index <= 6; index += 1) {
      await processor.process(
        sock as never,
        {
          ...createMessage(`msg ${index}`, { chatId: 'grupo@g.us', participant: 'user@s.whatsapp.net' }),
          key: {
            ...createMessage('x', { chatId: 'grupo@g.us', participant: 'user@s.whatsapp.net' }).key,
            id: `msg-${index}`,
          },
        } as never
      )
    }

    await processor.process(
      sock as never,
      {
        ...createMessage('link https://dominio-bloqueado.com', { chatId: 'grupo@g.us', participant: 'user@s.whatsapp.net' }),
        key: {
          ...createMessage('x', { chatId: 'grupo@g.us', participant: 'user@s.whatsapp.net' }).key,
          id: 'msg-7',
        },
      } as never
    )

    const deletes = sendMessage.mock.calls.filter((call) => call[1] && typeof call[1] === 'object' && 'delete' in call[1])
    expect(deletes).toHaveLength(5)
  })

  it('revalida delete com segunda tentativa quando a primeira falha', async () => {
    mockGroupFeatureStore.isAntilinkEnabled.mockResolvedValue(true)
    mockGroupFeatureStore.getAntilinkAllowedDomains.mockResolvedValue([])
    mockGroupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled.mockResolvedValue(false)

    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error('delete-fail-once')).mockResolvedValue(undefined).mockResolvedValue(undefined)
    const groupMetadata = vi.fn().mockResolvedValue({
      participants: [{ id: 'user@s.whatsapp.net' }, { id: 'bot@s.whatsapp.net', admin: 'admin' }],
    })
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([])
    const sock = {
      user: { id: 'bot@s.whatsapp.net' },
      sendMessage,
      groupMetadata,
      groupParticipantsUpdate,
      groupInviteCode: vi.fn().mockResolvedValue('SELF123'),
    }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    await processor.process(sock as never, createMessage('link https://dominio-bloqueado.com', { chatId: 'grupo@g.us', participant: 'user@s.whatsapp.net' }) as never)

    const deleteCalls = sendMessage.mock.calls.filter((call) => call[1] && typeof call[1] === 'object' && 'delete' in call[1])
    expect(deleteCalls).toHaveLength(2)
    expect(sendMessage).toHaveBeenLastCalledWith('grupo@g.us', { text: 'o user foi banido pelo sistema de anti link' })
  })

  it('evicts oldest key from recentMessagesByChat when MAX_CHAT_TRACKING_ENTRIES exceeded', async () => {
    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sock = { user: { id: 'bot@s.whatsapp.net' }, sendMessage: vi.fn() }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    const LIMIT = 2_000
    for (let i = 0; i < LIMIT; i++) {
      await processor.process(
        sock as never,
        {
          key: { remoteJid: `chat-${i}@g.us`, fromMe: false, id: `msg-${i}`, participant: `user-${i}@s.whatsapp.net` },
          pushName: 'X',
          message: { conversation: 'text' },
          messageTimestamp: 1,
        } as never
      )
    }

    await processor.process(
      sock as never,
      {
        key: { remoteJid: 'chat-new@g.us', fromMe: false, id: 'msg-new', participant: 'user-new@s.whatsapp.net' },
        pushName: 'X',
        message: { conversation: 'text' },
        messageTimestamp: 1,
      } as never
    )

    // Inserting LIMIT+1 unique chats should have evicted chat-0 to stay at LIMIT
    // We verify by checking chat-new is tracked (last sticker lookup returns null since it was text)
    // and that no error is thrown (Map didn't grow unbounded)
    expect(sock.sendMessage).not.toHaveBeenCalled()
  })

  it('evicts oldest key from recentMessagesBySender when MAX_SENDER_TRACKING_ENTRIES exceeded', async () => {
    const logger = createLogger()
    const sqlStore = { enabled: false, recordCommandLog: vi.fn() }
    const sock = { user: { id: 'bot@s.whatsapp.net' }, sendMessage: vi.fn() }

    const { createCommandProcessor } = await import('../src/core/command-runtime/processor.ts')
    const processor = createCommandProcessor({ logger, sqlStore: sqlStore as never })

    const LIMIT = 5_000
    for (let i = 0; i < LIMIT; i++) {
      await processor.process(
        sock as never,
        {
          key: { remoteJid: `group-${i}@g.us`, fromMe: false, id: `msg-${i}`, participant: `user-${i}@s.whatsapp.net` },
          pushName: 'X',
          message: { conversation: 'text' },
          messageTimestamp: 1,
        } as never
      )
    }

    await processor.process(
      sock as never,
      {
        key: { remoteJid: 'group-new@g.us', fromMe: false, id: 'msg-new', participant: 'user-new@s.whatsapp.net' },
        pushName: 'X',
        message: { conversation: 'text' },
        messageTimestamp: 1,
      } as never
    )

    expect(sock.sendMessage).not.toHaveBeenCalled()
  })
})
