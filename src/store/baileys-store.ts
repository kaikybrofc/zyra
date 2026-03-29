import {
  DEFAULT_CACHE_TTLS,
  type BaileysEventEmitter,
  type CacheStore,
  type Chat,
  type ChatUpdate,
  type Contact,
  type GroupMetadata,
  type GroupParticipant,
  type LIDMapping,
  type PossiblyExtendedCacheStore,
  type WAMessage,
  type WAMessageKey,
} from '@whiskeysockets/baileys'
import { createCacheStore, createExtendedCacheStore } from './cache-store.js'
import { createRedisStore } from './redis-store.js'

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

export function createBaileysStore(): BaileysStore {
  const redisStore = createRedisStore()
  const chats = new Map<string, Chat>()
  const contacts = new Map<string, Contact>()
  const groups = new Map<string, GroupMetadata>()
  const messages = new Map<string, WAMessage>()
  const pnToLid = new Map<string, string>()
  const lidToPn = new Map<string, string>()
  let externalLidMapping: LidMappingStore | undefined
  const msgRetryCounterCache = createCacheStore('msg-retry', DEFAULT_CACHE_TTLS.MSG_RETRY)
  const callOfferCache = createCacheStore('call-offer', DEFAULT_CACHE_TTLS.CALL_OFFER)
  const placeholderResendCache = createCacheStore(
    'placeholder-resend',
    DEFAULT_CACHE_TTLS.MSG_RETRY
  )
  const userDevicesCache = createExtendedCacheStore(
    'user-devices',
    DEFAULT_CACHE_TTLS.USER_DEVICES
  )
  const mediaCache = createCacheStore('media', DEFAULT_CACHE_TTLS.MSG_RETRY)

  const upsertMessage = (message: WAMessage) => {
    if (!message.key?.remoteJid || !message.key?.id) return
    const key = toMessageKey(message.key)
    messages.set(key, message)
    if (redisStore.enabled) {
      void redisStore.setMessage(key, message)
    }
  }

  const upsertLidMapping = ({ lid, pn }: LIDMapping) => {
    if (!lid || !pn) return
    pnToLid.set(pn, lid)
    lidToPn.set(lid, pn)
    if (redisStore.enabled) {
      void redisStore.setLidMapping({ lid, pn })
    }
  }

  const toLidMappingPair = (lid?: string | null, pn?: string | null): LIDMapping | null => {
    if (!lid || !pn) return null
    if (lid === pn) return null
    return { lid, pn }
  }

  const upsertGroupLidMappings = (group: Partial<GroupMetadata>) => {
    const pairs = [
      toLidMappingPair(group.owner, group.ownerPn),
      toLidMappingPair(group.subjectOwner, group.subjectOwnerPn),
      toLidMappingPair(group.descOwner, group.descOwnerPn),
      toLidMappingPair(group.author, group.authorPn),
    ].filter((pair): pair is LIDMapping => Boolean(pair))

    if (!pairs.length) return
    for (const pair of pairs) {
      upsertLidMapping(pair)
    }
  }

  const bind = (ev: BaileysEventEmitter) => {
    ev.on('messaging-history.set', ({ chats: chatList, contacts: contactList, messages: messageList, lidPnMappings }) => {
      for (const chat of chatList) {
        mergeById(chats, chat)
        if (chat.id && redisStore.enabled) {
          void redisStore.setChat(chat.id, chat)
        }
      }
      for (const contact of contactList) {
        mergeById(contacts, contact)
        if (contact.id && redisStore.enabled) {
          void redisStore.setContact(contact.id, contact)
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
        mergeById(chats, chat)
        if (chat.id && redisStore.enabled) {
          void redisStore.setChat(chat.id, chat)
        }
      }
    })

    ev.on('chats.update', (updates) => {
      for (const update of updates) {
        const { id, ...rest } = update as ChatUpdate & { id?: string | null }
        if (!id) continue
        const existing = chats.get(id)
        const next = { ...existing, ...rest }
        chats.set(id, next)
        if (redisStore.enabled) {
          void redisStore.setChat(id, next)
        }
      }
    })

    ev.on('chats.delete', (ids) => {
      for (const id of ids) {
        chats.delete(id)
        if (redisStore.enabled) {
          void redisStore.deleteChat(id)
        }
      }
    })

    ev.on('contacts.upsert', (contactList) => {
      for (const contact of contactList) {
        mergeById(contacts, contact)
        if (contact.id && redisStore.enabled) {
          void redisStore.setContact(contact.id, contact)
        }
      }
    })

    ev.on('contacts.update', (updates) => {
      for (const update of updates) {
        const id = update.id
        if (!id) continue
        const existing = contacts.get(id)
        const next = { ...existing, ...update, id }
        contacts.set(id, next)
        if (redisStore.enabled) {
          void redisStore.setContact(id, next)
        }
      }
    })

    ev.on('groups.upsert', (groupList) => {
      for (const group of groupList) {
        mergeById(groups, group)
        if (group.id && redisStore.enabled) {
          void redisStore.setGroup(group.id, group)
        }
        upsertGroupLidMappings(group)
      }
    })

    ev.on('groups.update', (updates) => {
      for (const update of updates) {
        const id = update.id
        if (!id) continue
        const existing = groups.get(id)
        if (!existing) continue
        const next = mergeDefined(existing, update)
        groups.set(id, next)
        if (redisStore.enabled) {
          void redisStore.setGroup(id, next)
        }
        upsertGroupLidMappings(update)
      }
    })

    ev.on('group-participants.update', ({ id, participants, action }) => {
      const group = groups.get(id)
      if (!group) return
      const baseSize =
        typeof group.size === 'number'
          ? group.size
          : Array.isArray(group.participants)
            ? group.participants.length
            : undefined
      let nextParticipants = group.participants ?? []

      if (action === 'add') {
        nextParticipants = upsertParticipants(nextParticipants, participants)
      } else if (action === 'remove') {
        const removeIds = new Set(participants.map((p) => p.id))
        nextParticipants = nextParticipants.filter((p) => !removeIds.has(p.id))
      } else if (action === 'promote' || action === 'demote' || action === 'modify') {
        nextParticipants = upsertParticipants(nextParticipants, participants)
      }

      let nextSize = baseSize
      if (typeof baseSize === 'number') {
        if (action === 'add') {
          nextSize = baseSize + participants.length
        } else if (action === 'remove') {
          nextSize = Math.max(0, baseSize - participants.length)
        }
      }

      const nextGroup = {
        ...group,
        participants: nextParticipants,
        size: typeof nextSize === 'number' ? nextSize : group.size,
      }
      groups.set(id, nextGroup)
      if (redisStore.enabled) {
        void redisStore.setGroup(id, nextGroup)
      }
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
        if (redisStore.enabled) {
          void redisStore.setMessage(messageKey, merged)
        }
      }
    })

    ev.on('messages.delete', (item) => {
      if ('all' in item && item.all) {
        for (const [key, message] of messages.entries()) {
          if (message.key?.remoteJid === item.jid) {
            messages.delete(key)
          }
        }
        if (redisStore.enabled) {
          void redisStore.deleteMessagesByJid(item.jid)
        }
        return
      }
      if ('keys' in item) {
        for (const key of item.keys) {
          const messageKey = toMessageKey(key)
          messages.delete(messageKey)
          if (redisStore.enabled) {
            void redisStore.deleteMessage(messageKey)
          }
        }
      }
    })

    ev.on('lid-mapping.update', (mapping) => {
      upsertLidMapping(mapping)
    })
  }

  const getMessage = async (key: WAMessageKey): Promise<MessageContent | undefined> => {
    const messageKey = toMessageKey(key)
    let message = messages.get(messageKey)
    if (!message && redisStore.enabled) {
      const stored = await redisStore.getMessage(messageKey)
      if (stored) {
        message = stored
        messages.set(messageKey, stored)
      }
    }
    const content = message?.message
    return content === null ? undefined : content
  }

  const getGroupMetadata = async (jid: string): Promise<GroupMetadata | undefined> => {
    let group = groups.get(jid)
    if (!group && redisStore.enabled) {
      const stored = await redisStore.getGroup(jid)
      if (stored) {
        group = stored
        groups.set(jid, stored)
      }
    }
    return group
  }

  const bindLidMappingStore = (store: LidMappingStore | undefined) => {
    externalLidMapping = store
  }

  const lidMapping: LidMappingFacade = {
    storeMappings: async (pairs) => {
      if (externalLidMapping) {
        await externalLidMapping.storeLIDPNMappings(pairs)
      }
      for (const pair of pairs) {
        upsertLidMapping(pair)
      }
    },
    getLidForPn: async (pn) => {
      if (externalLidMapping) {
        return externalLidMapping.getLIDForPN(pn)
      }
      const cached = pnToLid.get(pn)
      if (cached) return cached
      if (redisStore.enabled) {
        const stored = await redisStore.getLidForPn(pn)
        if (stored) {
          pnToLid.set(pn, stored)
          lidToPn.set(stored, pn)
          return stored
        }
      }
      return null
    },
    getLidsForPns: async (pns) => {
      if (externalLidMapping) {
        return externalLidMapping.getLIDsForPNs(pns)
      }
      const results: LIDMapping[] = []
      for (const pn of pns) {
        let lid = pnToLid.get(pn)
        if (!lid && redisStore.enabled) {
          const stored = await redisStore.getLidForPn(pn)
          if (stored) {
            lid = stored
            pnToLid.set(pn, stored)
            lidToPn.set(stored, pn)
          }
        }
        if (lid) {
          results.push({ pn, lid })
        }
      }
      return results.length ? results : null
    },
    getPnForLid: async (lid) => {
      if (externalLidMapping) {
        return externalLidMapping.getPNForLID(lid)
      }
      const cached = lidToPn.get(lid)
      if (cached) return cached
      if (redisStore.enabled) {
        const stored = await redisStore.getPnForLid(lid)
        if (stored) {
          lidToPn.set(lid, stored)
          pnToLid.set(stored, lid)
          return stored
        }
      }
      return null
    },
    getPnsForLids: async (lids) => {
      if (externalLidMapping) {
        return externalLidMapping.getPNsForLIDs(lids)
      }
      const results: LIDMapping[] = []
      for (const lid of lids) {
        let pn = lidToPn.get(lid)
        if (!pn && redisStore.enabled) {
          const stored = await redisStore.getPnForLid(lid)
          if (stored) {
            pn = stored
            lidToPn.set(lid, stored)
            pnToLid.set(stored, lid)
          }
        }
        if (pn) {
          results.push({ pn, lid })
        }
      }
      return results.length ? results : null
    },
  }

  return {
    bind,
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
