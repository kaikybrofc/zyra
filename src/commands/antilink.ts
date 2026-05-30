import type { Command } from './types.js'
import { groupFeatureStore } from '../store/group-feature-store.js'

const parseOnOff = (value: string | undefined): boolean | null => {
  if (!value) return null
  const normalized = value.toLowerCase()
  if (['on', '1', 'true', 'ativar'].includes(normalized)) return true
  if (['off', '0', 'false', 'desativar'].includes(normalized)) return false
  return null
}

const normalizeDomain = (value: string | undefined): string | null => {
  if (!value) return null
  const raw = value.trim().toLowerCase()
  if (!raw) return null
  return (
    raw
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0] ?? null
  )
}

/**
 * Gerencia a moderação anti-link de um grupo, incluindo estado,
 * whitelist de domínios e permissão para convites do próprio grupo.
 */
export const antilinkCommand: Command = {
  name: 'antilink',
  description: 'Anti-link do grupo: on/off, allow add|remove|list e invite on|off',
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

    if (action === 'allow') {
      const subaction = ctx.args[1]?.toLowerCase()
      if (subaction === 'list') {
        const domains = await groupFeatureStore.getAntilinkAllowedDomains(ctx.chatId)
        await ctx.reply(domains.length ? `✅ Domínios permitidos:\n- ${domains.join('\n- ')}` : 'ℹ️ Nenhum domínio liberado.')
        return
      }

      const domain = normalizeDomain(ctx.args[2])
      if (!domain || !subaction || !['add', 'remove'].includes(subaction)) {
        await ctx.reply('Uso: !antilink allow add|remove|list dominio.com')
        return
      }

      if (subaction === 'add') {
        await groupFeatureStore.addAntilinkAllowedDomain(ctx.chatId, domain)
        await ctx.reply(`✅ Domínio liberado no antilink: ${domain}`)
        return
      }

      await groupFeatureStore.removeAntilinkAllowedDomain(ctx.chatId, domain)
      await ctx.reply(`✅ Domínio removido da whitelist: ${domain}`)
      return
    }

    if (action === 'invite') {
      const mode = parseOnOff(ctx.args[1])
      if (mode === null) {
        await ctx.reply('Uso: !antilink invite on|off')
        return
      }
      await groupFeatureStore.setAntilinkAllowOwnGroupInviteEnabled(ctx.chatId, mode)
      await ctx.reply(`✅ Convite do próprio grupo agora está ${mode ? 'permitido' : 'bloqueado'} no antilink.`)
      return
    }

    const mode = parseOnOff(action)
    if (mode === null) {
      const enabled = await groupFeatureStore.isAntilinkEnabled(ctx.chatId)
      const domains = await groupFeatureStore.getAntilinkAllowedDomains(ctx.chatId)
      const allowOwnInvite = await groupFeatureStore.isAntilinkAllowOwnGroupInviteEnabled(ctx.chatId)
      await ctx.reply(`ℹ️ Status do antilink: *${enabled ? 'ATIVADO' : 'DESATIVADO'}*\n` + `ℹ️ Convite do próprio grupo: *${allowOwnInvite ? 'PERMITIDO' : 'BLOQUEADO'}*\n` + `ℹ️ Whitelist: ${domains.length ? domains.join(', ') : 'vazia'}\n` + 'Uso: !antilink on|off | !antilink allow add|remove|list dominio.com | !antilink invite on|off')
      return
    }

    await groupFeatureStore.setAntilinkEnabled(ctx.chatId, mode)
    await ctx.reply(`✅ Antilink ${mode ? 'ativado' : 'desativado'} neste grupo.`)
  },
}
