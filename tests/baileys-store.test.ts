import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let createCacheStoreMock: ReturnType<typeof vi.fn>
let createExtendedCacheStoreMock: ReturnType<typeof vi.fn>
let createRedisStoreMock: ReturnType<typeof vi.fn>
let createSqlStoreMock: ReturnType<typeof vi.fn>

vi.mock('../src/store/cache-store.js', () => ({
  createCacheStore: (...args: unknown[]) => createCacheStoreMock(...args),
  createExtendedCacheStore: (...args: unknown[]) => createExtendedCacheStoreMock(...args),
}))
vi.mock('../src/store/redis-store.js', () => ({
  createRedisStore: (...args: unknown[]) => createRedisStoreMock(...args),
}))
vi.mock('../src/store/sql-store.js', () => ({
  createSqlStore: (...args: unknown[]) => createSqlStoreMock(...args),
}))

const createCache = () => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  flushAll: vi.fn(),
})

const createExtendedCache = () => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  flushAll: vi.fn(),
  mget: vi.fn(),
  mset: vi.fn(),
  mdel: vi.fn(),
})

const createRedisStoreStub = () => ({
  enabled: true,
  getMessage: vi.fn(async () => undefined),
  setMessage: vi.fn(async () => undefined),
  deleteMessage: vi.fn(async () => undefined),
  deleteMessagesByJid: vi.fn(async () => undefined),
  getGroup: vi.fn(async () => undefined),
  setGroup: vi.fn(async () => undefined),
  deleteGroup: vi.fn(async () => undefined),
  setChat: vi.fn(async () => undefined),
  deleteChat: vi.fn(async () => undefined),
  setContact: vi.fn(async () => undefined),
  setLidMapping: vi.fn(async () => undefined),
  getLidForPn: vi.fn(async () => null),
  getPnForLid: vi.fn(async () => null),
})

const createSqlStoreStub = () => ({
  enabled: true,
  setSelfJid: vi.fn(),
  getMessage: vi.fn(async () => undefined),
  setMessage: vi.fn(async () => undefined),
  deleteMessage: vi.fn(async () => undefined),
  deleteMessagesByJid: vi.fn(async () => undefined),
  getGroup: vi.fn(async () => undefined),
  setGroup: vi.fn(async () => undefined),
  deleteGroup: vi.fn(async () => undefined),
  setGroupParticipants: vi.fn(async () => undefined),
  removeGroupParticipants: vi.fn(async () => undefined),
  setChat: vi.fn(async () => undefined),
  deleteChat: vi.fn(async () => undefined),
  setContact: vi.fn(async () => undefined),
  setLidMapping: vi.fn(async () => undefined),
  getLidForPn: vi.fn(async () => null),
  getPnForLid: vi.fn(async () => null),
  recordMessageEvent: vi.fn(async () => undefined),
  recordEvent: vi.fn(async () => undefined),
  setBlocklist: vi.fn(async () => undefined),
  recordGroupEvent: vi.fn(async () => undefined),
  recordGroupJoinRequest: vi.fn(async () => undefined),
  recordNewsletter: vi.fn(async () => undefined),
  recordNewsletterParticipant: vi.fn(async () => undefined),
  recordNewsletterEvent: vi.fn(async () => undefined),
  recordMessageFailure: vi.fn(async () => undefined),
  recordBotSession: vi.fn(async () => undefined),
  recordCommandLog: vi.fn(async () => undefined),
  setUserDevice: vi.fn(async () => undefined),
  setChatUser: vi.fn(async () => undefined),
  deleteChatUser: vi.fn(async () => undefined),
  setLabel: vi.fn(async () => undefined),
  setLabelAssociation: vi.fn(async () => undefined),
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  createCacheStoreMock = vi.fn(() => createCache())
  createExtendedCacheStoreMock = vi.fn(() => createExtendedCache())
  createRedisStoreMock = vi.fn(() => createRedisStoreStub())
  createSqlStoreMock = vi.fn(() => createSqlStoreStub())
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('baileys-store', () => {
  it('processa messaging-history e groups.upsert persistindo chat, contato, mensagem e mappings', async () => {
    const redisStore = createRedisStoreStub()
    const sqlStore = createSqlStoreStub()
    createRedisStoreMock.mockReturnValue(redisStore)
    createSqlStoreMock.mockReturnValue(sqlStore)

    const { createBaileysStore } = await import('../src/store/baileys-store.ts')
    const store = createBaileysStore('tenant')
    const ev = new EventEmitter()
    store.bind(ev as never)

    const message = {
      key: {
        remoteJid: 'chat@s.whatsapp.net',
        id: 'msg-1',
        fromMe: false,
        participant: 'user@s.whatsapp.net',
      },
      message: { conversation: 'oi' },
    }

    ev.emit('messaging-history.set', {
      chats: [{ id: 'chat@s.whatsapp.net', unreadCount: 1 }],
      contacts: [{ id: 'user@s.whatsapp.net', name: 'User' }],
      messages: [message],
      lidPnMappings: [{ lid: '551199@lid', pn: '551199' }],
    })

    ev.emit('groups.upsert', [
      {
        id: 'group@g.us',
        subject: 'Grupo',
        participants: [{ id: 'user@s.whatsapp.net', admin: 'admin' }],
        owner: '999999@lid',
        ownerPn: '999999',
      },
    ])

    expect(redisStore.setChat).toHaveBeenCalledWith('chat@s.whatsapp.net', expect.objectContaining({ id: 'chat@s.whatsapp.net' }))
    expect(sqlStore.setContact).toHaveBeenCalledWith('user@s.whatsapp.net', expect.objectContaining({ id: 'user@s.whatsapp.net' }))
    expect(redisStore.setMessage).toHaveBeenCalled()
    expect(sqlStore.setGroupParticipants).toHaveBeenCalledWith(
      'group@g.us',
      [{ id: 'user@s.whatsapp.net', admin: 'admin' }],
      { replace: true }
    )
    expect(sqlStore.setChatUser).toHaveBeenCalledWith('group@g.us', 'user@s.whatsapp.net', 'admin')
    expect(await store.getMessage(message.key as never)).toEqual({ conversation: 'oi' })
    expect(await store.getGroupMetadata('group@g.us')).toEqual(expect.objectContaining({ id: 'group@g.us', subject: 'Grupo' }))
    expect(await store.lidMapping.getLidForPn('551199')).toBe('551199@lid')
    expect(await store.lidMapping.getLidForPn('999999')).toBe('999999@lid')
  })

  it('faz fallback para redis e sql quando mensagem ou grupo nao estao em memoria', async () => {
    const redisStore = createRedisStoreStub()
    const sqlStore = createSqlStoreStub()
    createRedisStoreMock.mockReturnValue(redisStore)
    createSqlStoreMock.mockReturnValue(sqlStore)

    redisStore.getMessage.mockResolvedValueOnce({
      key: { remoteJid: 'chat@s.whatsapp.net', id: 'msg-1', fromMe: false },
      message: { conversation: 'redis' },
    })
    redisStore.getGroup.mockResolvedValueOnce({ id: 'group@g.us', subject: 'Redis Group' })
    sqlStore.getMessage.mockResolvedValueOnce({
      key: { remoteJid: 'chat2@s.whatsapp.net', id: 'msg-2', fromMe: false },
      message: { conversation: 'sql' },
    })
    sqlStore.getGroup.mockResolvedValueOnce({ id: 'group2@g.us', subject: 'SQL Group' })

    const { createBaileysStore } = await import('../src/store/baileys-store.ts')
    const store = createBaileysStore('tenant')

    expect(
      await store.getMessage({ remoteJid: 'chat@s.whatsapp.net', id: 'msg-1', fromMe: false } as never)
    ).toEqual({ conversation: 'redis' })
    expect(await store.getGroupMetadata('group@g.us')).toEqual({ id: 'group@g.us', subject: 'Redis Group' })

    redisStore.getMessage.mockResolvedValueOnce(undefined)
    redisStore.getGroup.mockResolvedValueOnce(undefined)

    expect(
      await store.getMessage({ remoteJid: 'chat2@s.whatsapp.net', id: 'msg-2', fromMe: false } as never)
    ).toEqual({ conversation: 'sql' })
    expect(await store.getGroupMetadata('group2@g.us')).toEqual({ id: 'group2@g.us', subject: 'SQL Group' })
  })

  it('atualiza participantes do grupo, selfJid e eventos de mensagem', async () => {
    const redisStore = createRedisStoreStub()
    const sqlStore = createSqlStoreStub()
    createRedisStoreMock.mockReturnValue(redisStore)
    createSqlStoreMock.mockReturnValue(sqlStore)

    const { createBaileysStore } = await import('../src/store/baileys-store.ts')
    const store = createBaileysStore('tenant')
    const ev = new EventEmitter()
    store.bind(ev as never)
    store.setSelfJid('bot@s.whatsapp.net')

    ev.emit('groups.upsert', [
      {
        id: 'group@g.us',
        subject: 'Grupo',
        size: 1,
        participants: [{ id: 'user1@s.whatsapp.net' }],
      },
    ])

    ev.emit('group-participants.update', {
      id: 'group@g.us',
      participants: [{ id: 'user2@s.whatsapp.net', admin: 'admin' }],
      action: 'add',
    })

    expect(sqlStore.setGroupParticipants).toHaveBeenCalledWith(
      'group@g.us',
      [{ id: 'user2@s.whatsapp.net', admin: 'admin' }]
    )
    expect(sqlStore.setChatUser).toHaveBeenCalledWith('group@g.us', 'user2@s.whatsapp.net', 'admin')
    expect(await store.getGroupMetadata('group@g.us')).toEqual(
      expect.objectContaining({
        size: 2,
        participants: expect.arrayContaining([
          expect.objectContaining({ id: 'user1@s.whatsapp.net' }),
          expect.objectContaining({ id: 'user2@s.whatsapp.net', admin: 'admin' }),
        ]),
      })
    )

    ev.emit('group-participants.update', {
      id: 'group@g.us',
      participants: [{ id: 'user2@s.whatsapp.net' }],
      action: 'remove',
    })

    expect(sqlStore.removeGroupParticipants).toHaveBeenCalledWith('group@g.us', ['user2@s.whatsapp.net'])
    expect(sqlStore.deleteChatUser).toHaveBeenCalledWith('group@g.us', 'user2@s.whatsapp.net')

    ev.emit('messages.upsert', {
      messages: [
        {
          key: {
            remoteJid: 'chat@s.whatsapp.net',
            id: 'msg-1',
            fromMe: false,
            participant: 'user1@s.whatsapp.net',
          },
          message: { conversation: 'oi' },
        },
      ],
    })

    ev.emit('messages.update', [
      {
        key: { remoteJid: 'chat@s.whatsapp.net', id: 'msg-1', fromMe: false },
        update: { status: 2 },
      },
    ])

    ev.emit('messages.delete', {
      keys: [{ remoteJid: 'chat@s.whatsapp.net', id: 'msg-1', fromMe: false }],
    })

    expect(sqlStore.recordMessageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        key: { chatJid: 'chat@s.whatsapp.net', messageId: 'msg-1', fromMe: false },
        type: 'update',
        actorJid: 'chat@s.whatsapp.net',
      })
    )
    expect(sqlStore.deleteMessage).toHaveBeenCalledWith('chat@s.whatsapp.net', 'msg-1', false)
    expect(sqlStore.setSelfJid).toHaveBeenCalledWith('bot@s.whatsapp.net')
  })

  it('integra facade de lid mapping com store externa e fallbacks locais', async () => {
    const redisStore = createRedisStoreStub()
    const sqlStore = createSqlStoreStub()
    createRedisStoreMock.mockReturnValue(redisStore)
    createSqlStoreMock.mockReturnValue(sqlStore)

    redisStore.getLidForPn.mockResolvedValueOnce('5511@lid')
    sqlStore.getPnForLid.mockResolvedValueOnce('5511')

    const externalStore = {
      storeLIDPNMappings: vi.fn(async () => undefined),
      getLIDForPN: vi.fn(async (pn: string) => `${pn}@external`),
      getLIDsForPNs: vi.fn(async (pns: string[]) => pns.map((pn) => ({ pn, lid: `${pn}@external` }))),
      getPNForLID: vi.fn(async (lid: string) => lid.replace('@external', '')),
      getPNsForLIDs: vi.fn(async (lids: string[]) => lids.map((lid) => ({ lid, pn: lid.replace('@external', '') }))),
    }

    const { createBaileysStore } = await import('../src/store/baileys-store.ts')
    const store = createBaileysStore('tenant')

    await store.lidMapping.storeMappings([
      { lid: '7000@lid', pn: '7000' },
      { lid: '7000@lid', pn: '7000' },
    ] as never)

    expect(await store.lidMapping.getLidForPn('7000')).toBe('7000@lid')
    expect(await store.lidMapping.getPnForLid('7000@lid')).toBe('7000')

    expect(await store.lidMapping.getLidForPn('5511')).toBe('5511@lid')
    expect(await store.lidMapping.getPnForLid('5511@lid')).toBe('5511')

    store.bindLidMappingStore(externalStore as never)

    await store.lidMapping.storeMappings([{ lid: '8800@external', pn: '8800' }] as never)
    expect(externalStore.storeLIDPNMappings).toHaveBeenCalledWith([{ lid: '8800@external', pn: '8800' }])
    expect(await store.lidMapping.getLidsForPns(['8800'])).toEqual([{ pn: '8800', lid: '8800@external' }])
    expect(await store.lidMapping.getPnsForLids(['8800@external'])).toEqual([{ lid: '8800@external', pn: '8800' }])
  })
})
