import NodeCache from '@cacheable/node-cache'
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

const createCacheStore = (ttl: number): CacheStore => {
  const cache = new NodeCache<unknown>({
    stdTTL: ttl,
    useClones: false,
  })

  return {
    get: <T>(key: string) => cache.get(key) as T | undefined,
    set: <T>(key: string, value: T) => cache.set(key, value),
    del: (key: string) => cache.del(key),
    flushAll: () => cache.flushAll(),
  }
}

const createUserDevicesCache = (ttl: number): PossiblyExtendedCacheStore => {
  const cache = new NodeCache<unknown>({
    stdTTL: ttl,
    useClones: false,
  })

  return {
    get: <T>(key: string) => cache.get(key) as T | undefined,
    set: <T>(key: string, value: T) => cache.set(key, value),
    del: (key: string) => cache.del(key),
    flushAll: () => cache.flushAll(),
    mget: async (keys) => cache.mget(keys),
    mset: async (entries) => {
      cache.mset(entries)
    },
    mdel: async (keys) => {
      cache.mdel(keys)
    },
  }
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
  const chats = new Map<string, Chat>()
  const contacts = new Map<string, Contact>()
  const groups = new Map<string, GroupMetadata>()
  const messages = new Map<string, WAMessage>()
  const pnToLid = new Map<string, string>()
  const lidToPn = new Map<string, string>()
  let externalLidMapping: LidMappingStore | undefined
  const msgRetryCounterCache = createCacheStore(DEFAULT_CACHE_TTLS.MSG_RETRY)
  const callOfferCache = createCacheStore(DEFAULT_CACHE_TTLS.CALL_OFFER)
  const placeholderResendCache = createCacheStore(DEFAULT_CACHE_TTLS.MSG_RETRY)
  const userDevicesCache = createUserDevicesCache(DEFAULT_CACHE_TTLS.USER_DEVICES)
  const mediaCache = createCacheStore(DEFAULT_CACHE_TTLS.MSG_RETRY)

  const upsertMessage = (message: WAMessage) => {
    if (!message.key?.remoteJid || !message.key?.id) return
    messages.set(toMessageKey(message.key), message)
  }

  const upsertLidMapping = ({ lid, pn }: LIDMapping) => {
    if (!lid || !pn) return
    pnToLid.set(pn, lid)
    lidToPn.set(lid, pn)
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
      }
      for (const contact of contactList) {
        mergeById(contacts, contact)
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
      }
    })

    ev.on('chats.update', (updates) => {
      for (const update of updates) {
        const { id, ...rest } = update as ChatUpdate & { id?: string | null }
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
        upsertGroupLidMappings(group)
      }
    })

    ev.on('groups.update', (updates) => {
      for (const update of updates) {
        const id = update.id
        if (!id) continue
        const existing = groups.get(id)
        if (!existing) continue
        groups.set(id, mergeDefined(existing, update))
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

      groups.set(id, {
        ...group,
        participants: nextParticipants,
        size: typeof nextSize === 'number' ? nextSize : group.size,
      })
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

    ev.on('lid-mapping.update', (mapping) => {
      upsertLidMapping(mapping)
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
      return pnToLid.get(pn) ?? null
    },
    getLidsForPns: async (pns) => {
      if (externalLidMapping) {
        return externalLidMapping.getLIDsForPNs(pns)
      }
      const results = pns
        .map((pn) => {
          const lid = pnToLid.get(pn)
          return lid ? { pn, lid } : null
        })
        .filter((pair): pair is LIDMapping => Boolean(pair))
      return results.length ? results : null
    },
    getPnForLid: async (lid) => {
      if (externalLidMapping) {
        return externalLidMapping.getPNForLID(lid)
      }
      return lidToPn.get(lid) ?? null
    },
    getPnsForLids: async (lids) => {
      if (externalLidMapping) {
        return externalLidMapping.getPNsForLIDs(lids)
      }
      const results = lids
        .map((lid) => {
          const pn = lidToPn.get(lid)
          return pn ? { pn, lid } : null
        })
        .filter((pair): pair is LIDMapping => Boolean(pair))
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
