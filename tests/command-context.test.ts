import { describe, expect, it, vi } from 'vitest'
import { CommandContext } from '../src/core/command-runtime/context.ts'

describe('CommandContext', () => {
  it('expoe dados normalizados e delega helpers do core', async () => {
    const reply = vi.fn().mockResolvedValue(undefined)
    const react = vi.fn().mockResolvedValue(undefined)
    const admin = {
      isAdmin: vi.fn().mockResolvedValue(true),
      kick: vi.fn().mockResolvedValue([]),
      ban: vi.fn().mockResolvedValue([]),
      promote: vi.fn().mockResolvedValue([]),
      demote: vi.fn().mockResolvedValue([]),
    }

    const ctx = new CommandContext({
      chatId: 'grupo@g.us',
      sender: 'user@s.whatsapp.net',
      text: '!ping agora',
      args: ['agora'],
      isGroup: true,
      commandName: 'ping',
      messageId: 'abc',
      pushName: 'Tester',
      reply,
      react,
      admin,
    })

    expect(ctx.chatId).toBe('grupo@g.us')
    expect(ctx.sender).toBe('user@s.whatsapp.net')
    expect(ctx.text).toBe('!ping agora')
    expect(ctx.args).toEqual(['agora'])
    expect(ctx.isGroup).toBe(true)
    expect(ctx.commandName).toBe('ping')
    expect(ctx.messageId).toBe('abc')
    expect(ctx.pushName).toBe('Tester')

    await ctx.reply('ok')
    await ctx.react('⚡')
    await ctx.isAdmin()
    await ctx.kick('target@s.whatsapp.net')
    await ctx.ban('ban@s.whatsapp.net')
    await ctx.promote(['a@s.whatsapp.net', 'b@s.whatsapp.net'])
    await ctx.demote('admin@s.whatsapp.net')

    expect(reply).toHaveBeenCalledWith('ok')
    expect(react).toHaveBeenCalledWith('⚡')
    expect(admin.isAdmin).toHaveBeenCalledWith(undefined)
    expect(admin.kick).toHaveBeenCalledWith('target@s.whatsapp.net')
    expect(admin.ban).toHaveBeenCalledWith('ban@s.whatsapp.net')
    expect(admin.promote).toHaveBeenCalledWith(['a@s.whatsapp.net', 'b@s.whatsapp.net'])
    expect(admin.demote).toHaveBeenCalledWith('admin@s.whatsapp.net')
  })
})
