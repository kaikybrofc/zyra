import type { BaileysEventMap } from 'baileys'

export type SupportedWebhookEvent = keyof Pick<BaileysEventMap, 'connection.update' | 'messages.upsert' | 'messages.update' | 'messages.delete' | 'message-receipt.update' | 'messages.reaction' | 'groups.upsert' | 'groups.update' | 'group-participants.update'>

export const WEBHOOK_SUPPORTED_EVENTS = new Set<string>(['connection.update', 'messages.upsert', 'messages.update', 'messages.delete', 'message-receipt.update', 'messages.reaction', 'groups.upsert', 'groups.update', 'group-participants.update'])

export const WEBHOOK_EVENT_GROUPS: Record<string, string[]> = {
  connection: ['connection.update'],
  messages: ['messages.upsert', 'messages.update', 'messages.delete', 'message-receipt.update', 'messages.reaction'],
  groups: ['groups.upsert', 'groups.update', 'group-participants.update'],
}

export const webhookMatchesEvent = (eventsFilter: string[], event: string): boolean => {
  if (eventsFilter.includes('*')) return true
  if (eventsFilter.includes(event)) return true
  for (const [group, events] of Object.entries(WEBHOOK_EVENT_GROUPS)) {
    if (eventsFilter.includes(group) && events.includes(event)) return true
  }
  return false
}
