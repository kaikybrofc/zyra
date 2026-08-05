import crypto from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Command } from './types.js'
import type { CommandMediaSource } from '../core/command-runtime/context.js'
import { groupFeatureStore } from '../store/group-feature-store.js'

const DEFAULT_WELCOME_TEXT = 'Bem-vindo(a), {user}!'
const DEFAULT_LEAVE_TEXT = '{user} saiu do grupo.'

const parseOnOff = (value: string | undefined): boolean | null => {
  if (!value) return null
  const normalized = value.toLowerCase()
  if (['on', '1', 'true', 'ativar'].includes(normalized)) return true
  if (['off', '0', 'false', 'desativar'].includes(normalized)) return false
  return null
}

const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_')

const extensionFromMime = (mimeType?: string | null): string => {
  const clean = mimeType?.split(';')[0]?.trim().toLowerCase()
  if (!clean?.includes('/')) return 'bin'
  return safeName(clean.split('/')[1] ?? 'bin') || 'bin'
}

const saveWelcomeMedia = async (groupJid: string, media: CommandMediaSource | null) => {
  if (!media) return null
  const baseDir = path.resolve(process.cwd(), '.zyra-data', 'welcome-media', safeName(groupJid))
  await mkdir(baseDir, { recursive: true })
  const hash = crypto.createHash('sha256').update(media.buffer).digest('hex').slice(0, 16)
  const fileName = `${Date.now()}-${hash}.${extensionFromMime(media.mimeType)}`
  const absolutePath = path.join(baseDir, fileName)
  await writeFile(absolutePath, media.buffer)
  const relative = path.relative(process.cwd(), absolutePath)
  return {
    type: media.type,
    path: relative && !relative.startsWith('..') ? relative : absolutePath,
    mimeType: media.mimeType ?? null,
    fileName: media.fileName ?? null,
  }
}

export const welcomeCommand: Command = {
  name: 'welcome',
  description: 'Boas-vindas do grupo: on/off, text, media, status',
  async execute(ctx) {
    if (!ctx.isGroup) {
      await ctx.reply('❌ Este comando só funciona em grupos.')
      return
    }

    const senderIsAdmin = await ctx.isAdmin()
    if (!senderIsAdmin) {
      await ctx.reply('❌ Apenas administradores podem usar este comando.')
      return
    }

    const action = ctx.args[0]?.toLowerCase()
    if (['leave', 'saida', 'saída', 'saiu'].includes(action ?? '')) {
      const subaction = ctx.args[1]?.toLowerCase()
      const mode = parseOnOff(subaction)
      if (mode !== null) {
        await groupFeatureStore.setLeaveEnabled(ctx.chatId, mode)
        await ctx.reply(`✅ Mensagem de saída ${mode ? 'ativada' : 'desativada'} neste grupo.`)
        return
      }

      if (subaction === 'text') {
        const text = ctx.args.slice(2).join(' ').trim()
        if (!text) {
          await ctx.reply('Uso: !welcome leave text {user} saiu do {group}.')
          return
        }
        await groupFeatureStore.setLeaveText(ctx.chatId, text)
        await ctx.reply('✅ Texto de saída atualizado.')
        return
      }

      const config = await groupFeatureStore.getLeaveConfig(ctx.chatId)
      const text = config.text || DEFAULT_LEAVE_TEXT
      await ctx.reply(`ℹ️ Status da saída: *${config.enabled ? 'ATIVADA' : 'DESATIVADA'}*\n` + `ℹ️ Texto: ${text}\n` + 'Uso: !welcome leave on|off | !welcome leave text mensagem')
      return
    }

    const mode = parseOnOff(action)
    if (mode !== null) {
      await groupFeatureStore.setWelcomeEnabled(ctx.chatId, mode)
      await ctx.reply(`✅ Welcome ${mode ? 'ativado' : 'desativado'} neste grupo.`)
      return
    }

    if (action === 'text') {
      const text = ctx.args.slice(1).join(' ').trim()
      if (!text) {
        await ctx.reply('Uso: !welcome text Bem-vindo(a), {user}!')
        return
      }
      await groupFeatureStore.setWelcomeText(ctx.chatId, text)
      await ctx.reply('✅ Texto de boas-vindas atualizado.')
      return
    }

    if (action === 'media') {
      const subaction = ctx.args[1]?.toLowerCase()
      if (subaction === 'remove') {
        await groupFeatureStore.setWelcomeMedia(ctx.chatId, null)
        await ctx.reply('✅ Mídia de boas-vindas removida.')
        return
      }

      const media = await ctx.getMediaSource()
      if (!media) {
        await ctx.reply('Envie uma imagem, vídeo, áudio ou documento com a legenda !welcome media, ou responda uma mídia com !welcome media.')
        return
      }

      const stored = await saveWelcomeMedia(ctx.chatId, media)
      if (!stored) {
        await ctx.reply('❌ Não consegui salvar essa mídia.')
        return
      }

      await groupFeatureStore.setWelcomeMedia(ctx.chatId, stored)
      await ctx.reply('✅ Mídia de boas-vindas atualizada.')
      return
    }

    const config = await groupFeatureStore.getWelcomeConfig(ctx.chatId)
    const leaveConfig = await groupFeatureStore.getLeaveConfig(ctx.chatId)
    const text = config.text || DEFAULT_WELCOME_TEXT
    const leaveText = leaveConfig.text || DEFAULT_LEAVE_TEXT
    await ctx.reply(
      `ℹ️ Status do welcome: *${config.enabled ? 'ATIVADO' : 'DESATIVADO'}*\n` +
        `ℹ️ Texto: ${text}\n` +
        `ℹ️ Mídia: ${config.media ? config.media.type : 'nenhuma'}\n` +
        `ℹ️ Saída: *${leaveConfig.enabled ? 'ATIVADA' : 'DESATIVADA'}*\n` +
        `ℹ️ Texto de saída: ${leaveText}\n` +
        'Uso: !welcome on|off | !welcome text mensagem | !welcome media | !welcome media remove | !welcome leave on|off | !welcome leave text mensagem'
    )
  },
}
