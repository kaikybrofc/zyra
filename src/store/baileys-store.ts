import type {
  BaileysEventEmitter,
  Chat,
  ChatUpdate,
  Contact,
  GroupMetadata,
  GroupParticipant,
  WAMessage,
  WAMessageKey,
} from '@whiskeysockets/baileys'

type MessageContent = Exclude<WAMessage['message'], null | undefined>

const toMessageKey = (key: WAMessageKey): string => {
  const remoteJid = key.remoteJid ?? ''
  const participant = key.participant ?? ''
  const fromMe = key.fromMe ? '1' : '0'
  const id = key.id ?? ''
  return `${remoteJid}:${participant}:${fromMe}:${id}`
}

const mergeById = <T extends { id?: string | null }>(store: Map<string, T>, entry: T) => {
  const id = entry.id
  if (!id) return
  const existing = store.get(id)
  store.set(id, { ...existing, ...entry })
}

const mergeDefined = <T extends object>(base: T, patch: Partial<T>): T => {
  const next = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      ;(next as Record<string, unknown>)[key] = value
    }
  }
  return next
}

const upsertParticipants = (
  existing: GroupParticipant[] | undefined,
  updates: GroupParticipant[]
): GroupParticipant[] => {
  const byId = new Map<string, GroupParticipant>()
  for (const participant of existing ?? []) {
    byId.set(participant.id, participant)
  }
  for (const participant of updates) {
    const current = byId.get(participant.id)
    byId.set(participant.id, { ...current, ...participant })
  }
  return Array.from(byId.values())
}

export type BaileysStore = {
  bind: (ev: BaileysEventEmitter) => void
  getMessage: (key: WAMessageKey) => Promise<MessageContent | undefined>
  getGroupMetadata: (jid: string) => Promise<GroupMetadata | undefined>
}

export function createBaileysStore(): BaileysStore {
  const chats = new Map<string, Chat>()
  const contacts = new Map<string, Contact>()
  const groups = new Map<string, GroupMetadata>()
  const messages = new Map<string, WAMessage>()

  const upsertMessage = (message: WAMessage) => {
    if (!message.key?.remoteJid || !message.key?.id) return
    messages.set(toMessageKey(message.key), message)
  }

  const bind = (ev: BaileysEventEmitter) => {
    ev.on('messaging-history.set', ({ chats: chatList, contacts: contactList, messages: messageList }) => {
      for (const chat of chatList) {
        mergeById(chats, chat)
      }
      for (const contact of contactList) {
        mergeById(contacts, contact)
      }
      for (const message of messageList) {
        upsertMessage(message)
      }
    })

    ev.on('chats.upsert', (chatList) => {
      for (const chat of chatList) {
        mergeById(chats, chat)
      }
    })

    ev.on('chats.update', (updates) => {
      for (const update of updates) {
        const { id, conditional, timestamp, ...rest } = update as ChatUpdate & {
          conditional?: unknown
          timestamp?: number
        }
        if (!id) continue
        const existing = chats.get(id)
        chats.set(id, { ...existing, ...rest })
      }
    })

    ev.on('chats.delete', (ids) => {
      for (const id of ids) {
        chats.delete(id)
      }
    })

    ev.on('contacts.upsert', (contactList) => {
      for (const contact of contactList) {
        mergeById(contacts, contact)
      }
    })

    ev.on('contacts.update', (updates) => {
      for (const update of updates) {
        const id = update.id
        if (!id) continue
        const existing = contacts.get(id)
        contacts.set(id, { ...existing, ...update, id })
      }
    })

    ev.on('groups.upsert', (groupList) => {
      for (const group of groupList) {
        mergeById(groups, group)
      }
    })

    ev.on('groups.update', (updates) => {
      for (const update of updates) {
        const id = update.id
        if (!id) continue
        const existing = groups.get(id)
        if (!existing) continue
        groups.set(id, mergeDefined(existing, update))
      }
    })

    ev.on('group-participants.update', ({ id, participants, action }) => {
      const group = groups.get(id)
      if (!group) return
      let nextParticipants = group.participants ?? []

      if (action === 'add') {
        nextParticipants = upsertParticipants(nextParticipants, participants)
      } else if (action === 'remove') {
        const removeIds = new Set(participants.map((p) => p.id))
        nextParticipants = nextParticipants.filter((p) => !removeIds.has(p.id))
      } else if (action === 'promote' || action === 'demote' || action === 'modify') {
        nextParticipants = upsertParticipants(nextParticipants, participants)
      }

      groups.set(id, { ...group, participants: nextParticipants })
    })

    ev.on('messages.upsert', ({ messages: messageList }) => {
      for (const message of messageList) {
        upsertMessage(message)
      }
    })

    ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        const messageKey = toMessageKey(key)
        const existing = messages.get(messageKey)
        const merged = existing ? { ...existing, ...update, key } : ({ ...update, key } as WAMessage)
        messages.set(messageKey, merged)
      }
    })

    ev.on('messages.delete', (item) => {
      if ('all' in item && item.all) {
        for (const [key, message] of messages.entries()) {
          if (message.key?.remoteJid === item.jid) {
            messages.delete(key)
          }
        }
        return
      }
      if ('keys' in item) {
        for (const key of item.keys) {
          messages.delete(toMessageKey(key))
        }
      }
    })
  }

  const getMessage = async (key: WAMessageKey): Promise<MessageContent | undefined> => {
    const message = messages.get(toMessageKey(key))
    const content = message?.message
    return content === null ? undefined : content
  }

  const getGroupMetadata = async (jid: string): Promise<GroupMetadata | undefined> => {
    return groups.get(jid)
  }

  return {
    bind,
    getMessage,
    getGroupMetadata,
  }
}
