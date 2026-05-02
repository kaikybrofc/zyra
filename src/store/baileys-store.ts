import { DEFAULT_CACHE_TTLS, type BaileysEventEmitter, type CacheStore, type Chat, type ChatUpdate, type Contact, type GroupMetadata, type GroupParticipant, type LIDMapping, type PossiblyExtendedCacheStore, type WAMessage, type WAMessageKey } from '@whiskeysockets/baileys'
import { createCacheStore, createExtendedCacheStore } from './cache-store.js'
import { createRedisStore } from './redis-store.js'
import { createSqlStore } from './sql-store.js'

type MessageContent = Exclude<WAMessage['message'], null | undefined>

const MAX_LENGTHS = {
  jid: 128,
  messageId: 128,
  labelId: 64,
  lidPn: 64,
}

const normalizeString = (value: unknown, maxLength?: number): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (maxLength && trimmed.length > maxLength) return null
  return trimmed
}

const normalizeJid = (value: unknown, maxLength = MAX_LENGTHS.jid): string | null => {
  const jid = normalizeString(value, maxLength)
  if (!jid || !jid.includes('@')) return null
  return jid
}

const normalizeMessageId = (value: unknown): string | null => normalizeString(value, MAX_LENGTHS.messageId)

const normalizeLabelId = (value: unknown): string | null => normalizeString(value, MAX_LENGTHS.labelId)

const normalizeLidOrPn = (value: unknown): string | null => normalizeString(value, MAX_LENGTHS.lidPn)

const toMessageKey = (key: WAMessageKey): string | null => {
  const remoteJid = normalizeJid(key.remoteJid)
  const messageId = normalizeMessageId(key.id)
  if (!remoteJid || !messageId) return null
  const participant = normalizeJid(key.participant) ?? ''
  const fromMe = key.fromMe ? '1' : '0'
  return `${remoteJid}:${participant}:${fromMe}:${messageId}`
}

const mergeById = <T extends { id?: string | null }>(store: Map<string, T>, entry: T) => {
  const id = normalizeJid(entry.id)
  if (!id) return
  const existing = store.get(id)
  store.set(id, { ...existing, ...entry, id })
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

const upsertParticipants = (existing: GroupParticipant[] | undefined, updates: GroupParticipant[]): GroupParticipant[] => {
  const byId = new Map<string, GroupParticipant>()
  for (const participant of existing ?? []) {
    const id = normalizeJid(participant.id)
    if (!id) continue
    byId.set(id, { ...participant, id })
  }
  for (const participant of updates) {
    const id = normalizeJid(participant.id)
    if (!id) continue
    const current = byId.get(id)
    byId.set(id, { ...current, ...participant, id })
  }
  return Array.from(byId.values())
}

export type BaileysStore = {
  bind: (ev: BaileysEventEmitter) => void
  setSelfJid: (jid: string | null) => void
  getMessage: (key: WAMessageKey) => Promise<MessageContent | undefined>
  getGroupMetadata: (jid: string) => Promise<GroupMetadata | undefined>
  bindLidMappingStore: (store: LidMappingStore | undefined) => void
  lidMapping: LidMappingFacade
  caches: {
    msgRetryCounterCache: CacheStore
    callOfferCache: CacheStore
    placeholderResendCache: CacheStore
    userDevicesCache: PossiblyExtendedCacheStore
    mediaCache: CacheStore
  }
}

type LidMappingStore = {
  storeLIDPNMappings: (pairs: LIDMapping[]) => Promise<void>
  getLIDForPN: (pn: string) => Promise<string | null>
  getLIDsForPNs: (pns: string[]) => Promise<LIDMapping[] | null>
  getPNForLID: (lid: string) => Promise<string | null>
  getPNsForLIDs: (lids: string[]) => Promise<LIDMapping[] | null>
}

type LidMappingFacade = {
  storeMappings: (pairs: LIDMapping[]) => Promise<void>
  getLidForPn: (pn: string) => Promise<string | null>
  getLidsForPns: (pns: string[]) => Promise<LIDMapping[] | null>
  getPnForLid: (lid: string) => Promise<string | null>
  getPnsForLids: (lids: string[]) => Promise<LIDMapping[] | null>
}

/**
 * Cria a store do Baileys com caches e persistencia opcional.
 */
export function createBaileysStore(connectionId?: string): BaileysStore {
  const redisStore = createRedisStore(connectionId)
  const sqlStore = createSqlStore(connectionId)
  const chats = new Map<string, Chat>()
  const contacts = new Map<string, Contact>()
  const groups = new Map<string, GroupMetadata>()
  const messages = new Map<string, WAMessage>()
  const pnToLid = new Map<string, string>()
  const lidToPn = new Map<string, string>()
  let externalLidMapping: LidMappingStore | undefined
  let selfJid: string | null = null
  const msgRetryCounterCache = createCacheStore('msg-retry', DEFAULT_CACHE_TTLS.MSG_RETRY, connectionId)
  const callOfferCache = createCacheStore('call-offer', DEFAULT_CACHE_TTLS.CALL_OFFER, connectionId)
  const placeholderResendCache = createCacheStore('placeholder-resend', DEFAULT_CACHE_TTLS.MSG_RETRY, connectionId)
  const userDevicesCache = createExtendedCacheStore('user-devices', DEFAULT_CACHE_TTLS.USER_DEVICES, connectionId)
  const mediaCache = createCacheStore('media', DEFAULT_CACHE_TTLS.MSG_RETRY, connectionId)

  const upsertMessage = (message: WAMessage) => {
    if (!message.key) return
    const key = toMessageKey(message.key)
    if (!key) return
    messages.set(key, message)
    if (redisStore.enabled) {
      void redisStore.setMessage(key, message)
    }
    if (sqlStore.enabled) {
      void sqlStore.setMessage(message)
    }
  }

  const upsertLidMapping = ({ lid, pn }: LIDMapping) => {
    const normalizedLid = normalizeLidOrPn(lid)
    const normalizedPn = normalizeLidOrPn(pn)
    if (!normalizedLid || !normalizedPn) return
    if (normalizedLid === normalizedPn) return
    pnToLid.set(normalizedPn, normalizedLid)
    lidToPn.set(normalizedLid, normalizedPn)
    if (redisStore.enabled) {
      void redisStore.setLidMapping({ lid: normalizedLid, pn: normalizedPn })
    }
    if (sqlStore.enabled) {
      void sqlStore.setLidMapping({ lid: normalizedLid, pn: normalizedPn })
    }
  }

  const toLidMappingPair = (lid?: string | null, pn?: string | null): LIDMapping | null => {
    const normalizedLid = normalizeLidOrPn(lid)
    const normalizedPn = normalizeLidOrPn(pn)
    if (!normalizedLid || !normalizedPn) return null
    if (normalizedLid === normalizedPn) return null
    return { lid: normalizedLid, pn: normalizedPn }
  }

  const upsertGroupLidMappings = (group: Partial<GroupMetadata>) => {
    const pairs = [toLidMappingPair(group.owner, group.ownerPn), toLidMappingPair(group.subjectOwner, group.subjectOwnerPn), toLidMappingPair(group.descOwner, group.descOwnerPn), toLidMappingPair(group.author, group.authorPn)].filter((pair): pair is LIDMapping => Boolean(pair))

    if (!pairs.length) return
    for (const pair of pairs) {
      upsertLidMapping(pair)
    }
  }

  const bind = (ev: BaileysEventEmitter) => {
    ev.on('messaging-history.set', ({ chats: chatList, contacts: contactList, messages: messageList, lidPnMappings }) => {
      for (const chat of chatList) {
        const chatId = normalizeJid(chat.id)
        if (!chatId) continue
        const normalizedChat = chat.id === chatId ? chat : { ...chat, id: chatId }
        mergeById(chats, normalizedChat)
        if (redisStore.enabled) {
          void redisStore.setChat(chatId, normalizedChat)
        }
        if (sqlStore.enabled) {
          void sqlStore.setChat(chatId, normalizedChat)
        }
      }
      for (const contact of contactList) {
        const contactId = normalizeJid(contact.id)
        if (!contactId) continue
        const normalizedContact = contact.id === contactId ? contact : { ...contact, id: contactId }
        mergeById(contacts, normalizedContact)
        if (redisStore.enabled) {
          void redisStore.setContact(contactId, normalizedContact)
        }
        if (sqlStore.enabled) {
          void sqlStore.setContact(contactId, normalizedContact)
        }
      }
      for (const message of messageList) {
        upsertMessage(message)
      }
      if (lidPnMappings?.length) {
        for (const mapping of lidPnMappings) {
          upsertLidMapping(mapping)
        }
      }
    })

    ev.on('chats.upsert', (chatList) => {
      for (const chat of chatList) {
        const chatId = normalizeJid(chat.id)
        if (!chatId) continue
        const normalizedChat = chat.id === chatId ? chat : { ...chat, id: chatId }
        mergeById(chats, normalizedChat)
        if (redisStore.enabled) {
          void redisStore.setChat(chatId, normalizedChat)
        }
        if (sqlStore.enabled) {
          void sqlStore.setChat(chatId, normalizedChat)
          if (!chatId.endsWith('@g.us')) {
            void sqlStore.setChatUser(chatId, chatId, null)
          }
        }
      }
    })

    ev.on('chats.update', (updates) => {
      for (const update of updates) {
        const { id, ...rest } = update as ChatUpdate & { id?: string | null }
        const chatId = normalizeJid(id)
        if (!chatId) continue
        const existing = chats.get(chatId)
        const next = { ...existing, ...rest }
        chats.set(chatId, { ...next, id: chatId })
        if (redisStore.enabled) {
          void redisStore.setChat(chatId, { ...next, id: chatId })
        }
        if (sqlStore.enabled) {
          void sqlStore.setChat(chatId, { ...next, id: chatId })
          if (!chatId.endsWith('@g.us')) {
            void sqlStore.setChatUser(chatId, chatId, null)
          }
        }
      }
    })

    ev.on('chats.delete', (ids) => {
      for (const id of ids) {
        const chatId = normalizeJid(id)
        if (!chatId) continue
        chats.delete(chatId)
        if (redisStore.enabled) {
          void redisStore.deleteChat(chatId)
        }
        if (sqlStore.enabled) {
          void sqlStore.deleteChat(chatId)
        }
      }
    })

    ev.on('contacts.upsert', (contactList) => {
      for (const contact of contactList) {
        const contactId = normalizeJid(contact.id)
        if (!contactId) continue
        const normalizedContact = contact.id === contactId ? contact : { ...contact, id: contactId }
        mergeById(contacts, normalizedContact)
        if (redisStore.enabled) {
          void redisStore.setContact(contactId, normalizedContact)
        }
        if (sqlStore.enabled) {
          void sqlStore.setContact(contactId, normalizedContact)
        }
      }
    })

    ev.on('contacts.update', (updates) => {
      for (const update of updates) {
        const contactId = normalizeJid(update.id)
        if (!contactId) continue
        const existing = contacts.get(contactId)
        const next = { ...existing, ...update, id: contactId }
        contacts.set(contactId, next)
        if (redisStore.enabled) {
          void redisStore.setContact(contactId, next)
        }
        if (sqlStore.enabled) {
          void sqlStore.setContact(contactId, next)
        }
      }
    })

    ev.on('groups.upsert', (groupList) => {
      const idsPreview = groupList
        .slice(0, 3)
        .map((group) => group.id ?? '')
        .filter(Boolean)
      console.log('[groups.upsert]', { count: groupList.length, idsPreview, hasId: groupList.some((g) => Boolean(g.id)) })
      for (const group of groupList) {
        const groupId = normalizeJid(group.id)
        if (!groupId) continue
        const normalizedGroup = group.id === groupId ? group : { ...group, id: groupId }
        mergeById(groups, normalizedGroup)
        if (redisStore.enabled) {
          void redisStore.setGroup(groupId, normalizedGroup)
        }
        if (sqlStore.enabled) {
          void sqlStore.setGroup(groupId, normalizedGroup).catch((error) => {
            console.error('[groups.upsert] falha ao salvar grupo no SQL', error)
          })
          if (normalizedGroup.participants?.length) {
            const normalizedParticipants = normalizedGroup.participants
              .map((participant) => {
                const participantId = normalizeJid(participant.id)
                if (!participantId) return null
                return participant.id === participantId ? participant : { ...participant, id: participantId }
              })
              .filter((participant): participant is GroupParticipant => Boolean(participant))
            if (normalizedParticipants.length) {
              void sqlStore.setGroupParticipants(groupId, normalizedParticipants, { replace: true })
              for (const participant of normalizedParticipants) {
                const role = participant.admin ?? null
                void sqlStore.setChatUser(groupId, participant.id, role)
              }
            }
          }
        }
        upsertGroupLidMappings(normalizedGroup)
      }
    })

    ev.on('groups.update', (updates) => {
      for (const update of updates) {
        const groupId = normalizeJid(update.id)
        if (!groupId) continue
        const existing = groups.get(groupId)
        if (!existing) continue
        const next = mergeDefined(existing, update)
        const normalizedNext = { ...next, id: groupId }
        groups.set(groupId, normalizedNext)
        if (redisStore.enabled) {
          void redisStore.setGroup(groupId, normalizedNext)
        }
        if (sqlStore.enabled) {
          void sqlStore.setGroup(groupId, normalizedNext)
          if (normalizedNext.participants?.length) {
            const normalizedParticipants = normalizedNext.participants
              .map((participant) => {
                const participantId = normalizeJid(participant.id)
                if (!participantId) return null
                return participant.id === participantId ? participant : { ...participant, id: participantId }
              })
              .filter((participant): participant is GroupParticipant => Boolean(participant))
            if (normalizedParticipants.length) {
              void sqlStore.setGroupParticipants(groupId, normalizedParticipants, { replace: true })
              for (const participant of normalizedParticipants) {
                const role = participant.admin ?? null
                void sqlStore.setChatUser(groupId, participant.id, role)
              }
            }
          }
        }
        upsertGroupLidMappings(update)
      }
    })

    ev.on('group-participants.update', ({ id, participants, action }) => {
      const groupId = normalizeJid(id)
      if (!groupId) return
      const group = groups.get(groupId)
      if (!group) return
      if (!participants?.length) return
      if (!['add', 'remove', 'promote', 'demote', 'modify'].includes(action)) return
      const baseSize = typeof group.size === 'number' ? group.size : Array.isArray(group.participants) ? group.participants.length : undefined
      let nextParticipants = group.participants ?? []
      const normalizedParticipants = participants
        .map((participant) => {
          const participantId = normalizeJid(participant.id)
          if (!participantId) return null
          return participant.id === participantId ? participant : { ...participant, id: participantId }
        })
        .filter((participant): participant is GroupParticipant => Boolean(participant))
      if (!normalizedParticipants.length) return

      if (action === 'add') {
        nextParticipants = upsertParticipants(nextParticipants, normalizedParticipants)
      } else if (action === 'remove') {
        const removeIds = new Set(normalizedParticipants.map((p) => p.id))
        nextParticipants = nextParticipants.filter((p) => !removeIds.has(p.id))
      } else if (action === 'promote' || action === 'demote' || action === 'modify') {
        nextParticipants = upsertParticipants(nextParticipants, normalizedParticipants)
      }

      let nextSize = baseSize
      if (typeof baseSize === 'number') {
        if (action === 'add') {
          nextSize = baseSize + normalizedParticipants.length
        } else if (action === 'remove') {
          nextSize = Math.max(0, baseSize - normalizedParticipants.length)
        }
      }

      const nextGroup = {
        ...group,
        participants: nextParticipants,
        size: typeof nextSize === 'number' ? nextSize : group.size,
      }
      groups.set(groupId, nextGroup)
      if (redisStore.enabled) {
        void redisStore.setGroup(groupId, nextGroup)
      }
      if (sqlStore.enabled) {
        void sqlStore.setGroup(groupId, nextGroup)
        const participantIds = normalizedParticipants.map((participant) => participant.id)
        if (action === 'remove') {
          void sqlStore.removeGroupParticipants(groupId, participantIds)
        } else {
          void sqlStore.setGroupParticipants(groupId, normalizedParticipants)
        }
        if (action === 'add' || action === 'promote' || action === 'demote' || action === 'modify') {
          for (const participant of normalizedParticipants) {
            const role = participant.admin ?? null
            void sqlStore.setChatUser(groupId, participant.id, role)
          }
        } else if (action === 'remove') {
          for (const participant of normalizedParticipants) {
            void sqlStore.deleteChatUser(groupId, participant.id)
          }
        }
      }
    })

    ev.on('messages.upsert', ({ messages: messageList }) => {
      for (const message of messageList) {
        upsertMessage(message)
        if (sqlStore.enabled) {
          const key = message.key
          const chatJid = normalizeJid(key?.remoteJid)
          if (chatJid) {
            const senderJid = key?.fromMe ? null : (key?.participant ?? key?.remoteJid ?? null)
            const normalizedSender = normalizeJid(senderJid)
            const role = null
            if (normalizedSender) {
              void sqlStore.setChatUser(chatJid, normalizedSender, role)
            }
          }
        }
      }
    })

    ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        const messageKey = toMessageKey(key)
        if (!messageKey) continue
        const existing = messages.get(messageKey)
        const merged = existing ? { ...existing, ...update, key } : ({ ...update, key } as WAMessage)
        messages.set(messageKey, merged)
        if (redisStore.enabled) {
          void redisStore.setMessage(messageKey, merged)
        }
        if (sqlStore.enabled) {
          void sqlStore.setMessage(merged)
          const chatJid = normalizeJid(key.remoteJid)
          const messageId = normalizeMessageId(key.id)
          if (chatJid && messageId) {
            const actorJid = key.fromMe ? selfJid : (key.participant ?? key.remoteJid ?? null)
            void sqlStore.recordMessageEvent({
              key: { chatJid, messageId, fromMe: Boolean(key.fromMe) },
              type: 'update',
              actorJid: normalizeJid(actorJid),
              data: update,
            })
          }
        }
      }
    })

    ev.on('messages.media-update', (updates) => {
      for (const item of updates) {
        const key = (item as { key?: WAMessage['key'] }).key
        const update = (item as { update?: Partial<WAMessage> }).update
        if (!key || !update) continue
        const messageKey = toMessageKey(key)
        if (!messageKey) continue

        void (async () => {
          const existingInMemory = messages.get(messageKey)
          const existingFromRedis = !existingInMemory && redisStore.enabled ? await redisStore.getMessage(messageKey) : undefined
          const base = existingInMemory ?? existingFromRedis
          const merged = base ? { ...base, ...update, key } : ({ ...update, key } as WAMessage)

          messages.set(messageKey, merged)
          if (redisStore.enabled) {
            void redisStore.setMessage(messageKey, merged)
          }
          if (sqlStore.enabled) {
            void sqlStore.setMessage(merged)
            const chatJid = normalizeJid(key.remoteJid)
            const messageId = normalizeMessageId(key.id)
            if (chatJid && messageId) {
              const actorJid = key.fromMe ? selfJid : (key.participant ?? key.remoteJid ?? null)
              void sqlStore.recordMessageEvent({
                key: { chatJid, messageId, fromMe: Boolean(key.fromMe) },
                type: 'media_update',
                actorJid: normalizeJid(actorJid),
                data: update,
              })
            }
          }
        })()
      }
    })

    ev.on('messages.delete', (item) => {
      if ('all' in item && item.all) {
        const chatJid = normalizeJid(item.jid)
        if (!chatJid) return
        for (const [key, message] of messages.entries()) {
          const messageJid = normalizeJid(message.key?.remoteJid)
          if (messageJid === chatJid) {
            messages.delete(key)
          }
        }
        if (redisStore.enabled) {
          void redisStore.deleteMessagesByJid(chatJid)
        }
        if (sqlStore.enabled) {
          void sqlStore.deleteMessagesByJid(chatJid)
          void sqlStore.recordMessageEvent({
            key: { chatJid, messageId: '*', fromMe: false },
            type: 'delete_all',
            data: item,
          })
        }
        return
      }
      if ('keys' in item) {
        for (const key of item.keys) {
          const messageKey = toMessageKey(key)
          if (!messageKey) continue
          messages.delete(messageKey)
          if (redisStore.enabled) {
            void redisStore.deleteMessage(messageKey)
          }
          if (sqlStore.enabled) {
            const chatJid = normalizeJid(key.remoteJid)
            const messageId = normalizeMessageId(key.id)
            if (chatJid && messageId) {
              const actorJid = key.fromMe ? selfJid : (key.participant ?? key.remoteJid ?? null)
              void sqlStore.deleteMessage(chatJid, messageId, Boolean(key.fromMe))
              void sqlStore.recordMessageEvent({
                key: { chatJid, messageId, fromMe: Boolean(key.fromMe) },
                type: 'delete',
                actorJid: normalizeJid(actorJid),
                data: key,
              })
            }
          }
        }
      }
    })

    ev.on('messages.reaction', (reactions) => {
      if (!sqlStore.enabled) return
      for (const reaction of reactions) {
        const reactionAny = reaction as {
          key?: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null; participant?: string | null }
          sender?: string | null
          reaction?: { participant?: string | null }
        }
        const key = reactionAny.key
        const chatJid = normalizeJid(key?.remoteJid)
        const messageId = normalizeMessageId(key?.id)
        if (!chatJid || !messageId) continue
        const actorJid = reactionAny.key?.participant ?? reactionAny.sender ?? reactionAny.reaction?.participant ?? null
        const targetJid = reactionAny.key?.participant ?? null
        void sqlStore.recordMessageEvent({
          key: { chatJid, messageId, fromMe: Boolean(key?.fromMe) },
          type: 'reaction',
          actorJid: normalizeJid(actorJid),
          targetJid: normalizeJid(targetJid),
          data: reaction,
        })
      }
    })

    ev.on('message-receipt.update', (updates) => {
      if (!sqlStore.enabled) return
      for (const update of updates) {
        const updateAny = update as {
          key?: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null; participant?: string | null }
          participant?: string | null
        }
        const key = updateAny.key
        const chatJid = normalizeJid(key?.remoteJid)
        const messageId = normalizeMessageId(key?.id)
        if (!chatJid || !messageId) continue
        const actorJid = updateAny.participant ?? updateAny.key?.participant ?? null
        void sqlStore.recordMessageEvent({
          key: { chatJid, messageId, fromMe: Boolean(key?.fromMe) },
          type: 'receipt',
          actorJid: normalizeJid(actorJid),
          data: update,
        })
      }
    })

    ev.on('labels.edit', (label) => {
      if (!sqlStore.enabled) return
      const labelId = normalizeLabelId(label.id)
      if (!labelId) return
      const labelActor = (label as { author?: string | null }).author ?? (label as { actor?: string | null }).actor ?? (label as { creator?: string | null }).creator ?? null
      const color = label.color == null ? null : String(label.color)
      void sqlStore.setLabel({
        id: labelId,
        name: label.name ?? null,
        color,
        data: label,
        actorJid: normalizeJid(labelActor),
      })
    })

    ev.on('labels.association', ({ association }) => {
      if (!sqlStore.enabled) return
      const assoc = association as {
        labelId?: string
        messageId?: string
        chatId?: string
        contactJid?: string
        groupJid?: string
        actor?: string
        author?: string
        label_id?: string
        message_id?: string
        chat_id?: string
        contact_jid?: string
        group_jid?: string
      }
      const rawLabelId = assoc.labelId ?? assoc.label_id
      const labelId = normalizeLabelId(rawLabelId)
      if (!labelId) return
      const rawMessageId = assoc.messageId ?? assoc.message_id
      const messageId = normalizeMessageId(rawMessageId)
      if (rawMessageId && !messageId) return
      const rawChatJid = assoc.chatId ?? assoc.chat_id ?? null
      const chatJid = normalizeJid(rawChatJid)
      if (rawChatJid && !chatJid) return
      const rawContactJid = assoc.contactJid ?? assoc.contact_jid ?? null
      const contactJid = normalizeJid(rawContactJid)
      if (rawContactJid && !contactJid) return
      const rawGroupJid = assoc.groupJid ?? assoc.group_jid ?? null
      const groupJid = normalizeJid(rawGroupJid)
      if (rawGroupJid && !groupJid) return
      const associationType = messageId && chatJid ? 'message' : groupJid ? 'group' : contactJid ? 'contact' : 'chat'
      const actorJid = normalizeJid(assoc.actor ?? assoc.author ?? null)
      void sqlStore.setLabelAssociation({
        labelId,
        associationType,
        chatJid: associationType === 'chat' ? chatJid : null,
        targetJid: associationType === 'contact' ? contactJid : associationType === 'group' ? groupJid : null,
        messageKey: associationType === 'message' && messageId && chatJid ? { chatJid, messageId, fromMe: false } : null,
        actorJid,
        data: association,
      })
    })

    ev.on('lid-mapping.update', (mapping) => {
      upsertLidMapping(mapping)
    })
  }

  const getMessage = async (key: WAMessageKey): Promise<MessageContent | undefined> => {
    const messageKey = toMessageKey(key)
    if (!messageKey) return undefined
    let message = messages.get(messageKey)
    if (!message && redisStore.enabled) {
      const stored = await redisStore.getMessage(messageKey)
      if (stored) {
        message = stored
        messages.set(messageKey, stored)
      }
    }
    if (!message && sqlStore.enabled) {
      const stored = await sqlStore.getMessage(messageKey)
      if (stored) {
        message = stored
        messages.set(messageKey, stored)
      }
    }
    const content = message?.message
    return content === null ? undefined : content
  }

  const getGroupMetadata = async (jid: string): Promise<GroupMetadata | undefined> => {
    const normalizedJid = normalizeJid(jid)
    if (!normalizedJid) return undefined
    let group = groups.get(normalizedJid)
    if (!group && redisStore.enabled) {
      const stored = await redisStore.getGroup(normalizedJid)
      if (stored) {
        group = stored
        groups.set(normalizedJid, stored)
      }
    }
    if (!group && sqlStore.enabled) {
      const stored = await sqlStore.getGroup(normalizedJid)
      if (stored) {
        group = stored
        groups.set(normalizedJid, stored)
      }
    }
    return group
  }

  const bindLidMappingStore = (store: LidMappingStore | undefined) => {
    externalLidMapping = store
  }

  const setSelfJid = (jid: string | null) => {
    selfJid = normalizeJid(jid)
    if (sqlStore.enabled) {
      sqlStore.setSelfJid(selfJid)
    }
  }

  const lidMapping: LidMappingFacade = {
    storeMappings: async (pairs) => {
      const normalizedPairs = pairs
        .map((pair) => {
          const lid = normalizeLidOrPn(pair.lid)
          const pn = normalizeLidOrPn(pair.pn)
          if (!lid || !pn || lid === pn) return null
          return { lid, pn }
        })
        .filter((pair): pair is LIDMapping => Boolean(pair))
      if (!normalizedPairs.length) return
      if (externalLidMapping) {
        await externalLidMapping.storeLIDPNMappings(normalizedPairs)
      }
      for (const pair of normalizedPairs) {
        upsertLidMapping(pair)
      }
    },
    getLidForPn: async (pn) => {
      const normalizedPn = normalizeLidOrPn(pn)
      if (!normalizedPn) return null
      if (externalLidMapping) {
        return externalLidMapping.getLIDForPN(normalizedPn)
      }
      const cached = pnToLid.get(normalizedPn)
      if (cached) return cached
      if (redisStore.enabled) {
        const stored = await redisStore.getLidForPn(normalizedPn)
        if (stored) {
          pnToLid.set(normalizedPn, stored)
          lidToPn.set(stored, normalizedPn)
          return stored
        }
      }
      if (sqlStore.enabled) {
        const stored = await sqlStore.getLidForPn(normalizedPn)
        if (stored) {
          pnToLid.set(normalizedPn, stored)
          lidToPn.set(stored, normalizedPn)
          return stored
        }
      }
      return null
    },
    getLidsForPns: async (pns) => {
      if (externalLidMapping) {
        const normalizedPns = pns.map((pn) => normalizeLidOrPn(pn)).filter((pn): pn is string => Boolean(pn))
        if (!normalizedPns.length) return null
        return externalLidMapping.getLIDsForPNs(normalizedPns)
      }
      const results: LIDMapping[] = []
      for (const pn of pns) {
        const normalizedPn = normalizeLidOrPn(pn)
        if (!normalizedPn) continue
        let lid = pnToLid.get(normalizedPn)
        if (!lid && redisStore.enabled) {
          const stored = await redisStore.getLidForPn(normalizedPn)
          if (stored) {
            lid = stored
            pnToLid.set(normalizedPn, stored)
            lidToPn.set(stored, normalizedPn)
          }
        }
        if (!lid && sqlStore.enabled) {
          const stored = await sqlStore.getLidForPn(normalizedPn)
          if (stored) {
            lid = stored
            pnToLid.set(normalizedPn, stored)
            lidToPn.set(stored, normalizedPn)
          }
        }
        if (lid) {
          results.push({ pn: normalizedPn, lid })
        }
      }
      return results.length ? results : null
    },
    getPnForLid: async (lid) => {
      const normalizedLid = normalizeLidOrPn(lid)
      if (!normalizedLid) return null
      if (externalLidMapping) {
        return externalLidMapping.getPNForLID(normalizedLid)
      }
      const cached = lidToPn.get(normalizedLid)
      if (cached) return cached
      if (redisStore.enabled) {
        const stored = await redisStore.getPnForLid(normalizedLid)
        if (stored) {
          lidToPn.set(normalizedLid, stored)
          pnToLid.set(stored, normalizedLid)
          return stored
        }
      }
      if (sqlStore.enabled) {
        const stored = await sqlStore.getPnForLid(normalizedLid)
        if (stored) {
          lidToPn.set(normalizedLid, stored)
          pnToLid.set(stored, normalizedLid)
          return stored
        }
      }
      return null
    },
    getPnsForLids: async (lids) => {
      if (externalLidMapping) {
        const normalizedLids = lids.map((lid) => normalizeLidOrPn(lid)).filter((lid): lid is string => Boolean(lid))
        if (!normalizedLids.length) return null
        return externalLidMapping.getPNsForLIDs(normalizedLids)
      }
      const results: LIDMapping[] = []
      for (const lid of lids) {
        const normalizedLid = normalizeLidOrPn(lid)
        if (!normalizedLid) continue
        let pn = lidToPn.get(normalizedLid)
        if (!pn && redisStore.enabled) {
          const stored = await redisStore.getPnForLid(normalizedLid)
          if (stored) {
            pn = stored
            lidToPn.set(normalizedLid, stored)
            pnToLid.set(stored, normalizedLid)
          }
        }
        if (!pn && sqlStore.enabled) {
          const stored = await sqlStore.getPnForLid(normalizedLid)
          if (stored) {
            pn = stored
            lidToPn.set(normalizedLid, stored)
            pnToLid.set(stored, normalizedLid)
          }
        }
        if (pn) {
          results.push({ pn, lid: normalizedLid })
        }
      }
      return results.length ? results : null
    },
  }

  return {
    bind,
    setSelfJid,
    getMessage,
    getGroupMetadata,
    bindLidMappingStore,
    lidMapping,
    caches: {
      msgRetryCounterCache,
      callOfferCache,
      placeholderResendCache,
      userDevicesCache,
      mediaCache,
    },
  }
}
