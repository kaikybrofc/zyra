import { DisconnectReason, type BaileysEventMap, type GroupMetadata, type WASocket } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import type { AppLogger } from '../observability/logger.js'
import { config } from '../config/index.js'
import { handleIncomingMessages } from '../router/index.js'
import { createSqlStore } from '../store/sql-store.js'

type RegisterOptions = {
  sock: WASocket
  logger: AppLogger
  reconnect: () => Promise<void>
}

const ALL_EVENTS = [
  'connection.update',
  'creds.update',
  'messaging-history.set',
  'chats.upsert',
  'chats.update',
  'lid-mapping.update',
  'chats.delete',
  'presence.update',
  'contacts.upsert',
  'contacts.update',
  'messages.delete',
  'messages.update',
  'messages.media-update',
  'messages.upsert',
  'messages.reaction',
  'message-receipt.update',
  'groups.upsert',
  'groups.update',
  'group-participants.update',
  'group.join-request',
  'group.member-tag.update',
  'blocklist.set',
  'blocklist.update',
  'call',
  'labels.edit',
  'labels.association',
  'newsletter.reaction',
  'newsletter.view',
  'newsletter-participants.update',
  'newsletter-settings.update',
  'chats.lock',
  'settings.update',
] as const satisfies readonly (keyof BaileysEventMap)[]

type MissingEvents = Exclude<keyof BaileysEventMap, (typeof ALL_EVENTS)[number]>
const _allEventsCovered: MissingEvents extends never ? true : never = true
void _allEventsCovered

type EventHandler<K extends keyof BaileysEventMap> = (
  data: BaileysEventMap[K]
) => void | Promise<void>

let restartedAfterNewLogin = false

export function registerEvents({ sock, logger, reconnect }: RegisterOptions): void {
  const sqlStore = createSqlStore()
  type EventContext = {
    actorJid?: string | null
    targetJid?: string | null
    chatJid?: string | null
    groupJid?: string | null
    messageKey?: { chatJid: string; messageId: string; fromMe: boolean } | null
  }
  const recordEvent = (
    event: keyof BaileysEventMap,
    meta: Record<string, unknown>,
    context?: EventContext
  ) => {
    if (!sqlStore.enabled) return
    void sqlStore.recordEvent({ type: String(event), data: meta, ...context })
  }
  const logEvent = (
    event: keyof BaileysEventMap,
    meta: Record<string, unknown>,
    context?: EventContext
  ) => {
    logger.debug('evento do Baileys recebido', { event, ...meta })
    recordEvent(event, meta, context)
  }
  const resolveSelfJid = () => sock.user?.id ?? null
  const toEventMessageKey = (key?: {
    remoteJid?: string | null
    id?: string | null
    fromMe?: boolean | null
  }) => {
    if (!key?.remoteJid || !key.id) return null
    return { chatJid: key.remoteJid, messageId: key.id, fromMe: Boolean(key.fromMe) }
  }
  const toGroupJid = (jid?: string | null) =>
    jid && jid.endsWith('@g.us') ? jid : null

  const syncGroupsOnConnect = async (): Promise<GroupMetadata[]> => {
    try {
      logger.info('sincronizando grupos da conta')
      const groupMap = await sock.groupFetchAllParticipating()
      const groups = Object.values(groupMap)
      if (groups.length) {
        sock.ev.emit('groups.upsert', groups)
        logger.info('grupos sincronizados', { count: groups.length })
      } else {
        logger.info('nenhum grupo encontrado para sincronizar, tentando novamente em 5s')
        await new Promise((resolve) => setTimeout(resolve, 5000))
        const retryMap = await sock.groupFetchAllParticipating()
        const retryGroups = Object.values(retryMap)
        if (retryGroups.length) {
          sock.ev.emit('groups.upsert', retryGroups)
          logger.info('grupos sincronizados (retry)', { count: retryGroups.length })
          return retryGroups
        }
        logger.info('nenhum grupo encontrado para sincronizar (retry)')
      }
      return groups
    } catch (error) {
      logger.warn('falha ao sincronizar grupos', { err: error })
      return []
    }
  }

  const syncCommunitiesOnConnect = async (groupsSnapshot: GroupMetadata[]) => {
    try {
      logger.info('sincronizando comunidades da conta')
      const communityMap = await sock.communityFetchAllParticipating()
      const communities = Object.values(communityMap)
      if (communities.length) {
        logger.info('comunidades sincronizadas', { count: communities.length })
      } else {
        const communityGroups = groupsSnapshot.filter((group) => group.isCommunity)
        const linkedParents = new Set(
          groupsSnapshot
            .map((group) => group.linkedParent)
            .filter((jid): jid is string => Boolean(jid))
        )
        if (communityGroups.length || linkedParents.size) {
          logger.info('comunidades detectadas via grupos', {
            communities: communityGroups.length,
            linkedParents: linkedParents.size,
          })
        } else {
          logger.info('nenhuma comunidade encontrada para sincronizar')
        }
      }
    } catch (error) {
      logger.warn('falha ao sincronizar comunidades', { err: error })
    }
  }

  const handlers: Partial<{ [K in keyof BaileysEventMap]: EventHandler<K> }> = {
    'connection.update': (update) => {
      const { connection, lastDisconnect, qr, receivedPendingNotifications, isNewLogin } = update

      if (qr && config.printQRInTerminal) {
        logger.info('QR code recebido, escaneie com seu WhatsApp')
        qrcode.generate(qr, { small: true })
      }

      logger.info('connection.update', {
        connection,
        receivedPendingNotifications,
        isNewLogin,
        hasLastDisconnect: Boolean(lastDisconnect),
      })

      logEvent('connection.update', {
        connection,
        hasQr: Boolean(qr),
        receivedPendingNotifications,
        isNewLogin,
      }, { actorJid: resolveSelfJid() })

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        const restartRequired = statusCode === DisconnectReason.restartRequired

        logger.warn('conexão encerrada', { statusCode, restartRequired })

        if (shouldReconnect) {
          void reconnect()
        }
      } else if (connection === 'open') {
        logger.info('conexão aberta')
        if (isNewLogin && !restartedAfterNewLogin) {
          restartedAfterNewLogin = true
          logger.warn('novo login detectado, reiniciando conexão para estabilizar')
          setTimeout(() => {
            void sock.end(new Error('Restart after new login'))
          }, 1500)
        }
        void (async () => {
          if (sqlStore.enabled) {
            void sqlStore.recordBotSession({
              deviceLabel: sock.user?.id ?? null,
              platform: (sock.user as { platform?: string } | undefined)?.platform ?? null,
              appVersion: (sock.user as { appVersion?: string } | undefined)?.appVersion ?? null,
              lastLogin: new Date(),
              data: { user: sock.user ?? null, update },
            })
          }
          if (sqlStore.enabled && typeof (sock as { fetchBlocklist?: () => Promise<string[]> }).fetchBlocklist === 'function') {
            try {
              const blocklist = await (sock as { fetchBlocklist: () => Promise<string[]> }).fetchBlocklist()
              for (const jid of blocklist) {
                void sqlStore.setBlocklist({ jid, isBlocked: true })
              }
            } catch (error) {
              logger.warn('falha ao sincronizar blocklist', { err: error })
            }
          }
          const groupsSnapshot = await syncGroupsOnConnect()
          await syncCommunitiesOnConnect(groupsSnapshot)
        })()
      }
    },
    'creds.update': () => {
      logEvent('creds.update', {}, { actorJid: resolveSelfJid() })
    },
    'messaging-history.set': ({ chats, contacts, messages, isLatest, progress, syncType }) => {
      logEvent('messaging-history.set', {
        chats: chats.length,
        contacts: contacts.length,
        messages: messages.length,
        isLatest,
        progress,
        syncType,
      }, { actorJid: resolveSelfJid() })
    },
    'chats.upsert': (chats) => {
      logger.debug('evento do Baileys recebido', { event: 'chats.upsert', count: chats.length })
      const actorJid = resolveSelfJid()
      for (const chat of chats) {
        if (!chat.id) continue
        recordEvent('chats.upsert', { id: chat.id }, { chatJid: chat.id, actorJid })
      }
    },
    'chats.update': (updates) => {
      logger.debug('evento do Baileys recebido', { event: 'chats.update', count: updates.length })
      const actorJid = resolveSelfJid()
      for (const update of updates) {
        const id = (update as { id?: string | null }).id
        if (!id) continue
        recordEvent('chats.update', { id }, { chatJid: id, actorJid })
      }
    },
    'lid-mapping.update': ({ lid, pn }) =>
      logEvent('lid-mapping.update', { lid, pn }, { actorJid: resolveSelfJid() }),
    'chats.delete': (ids) => {
      logger.debug('evento do Baileys recebido', { event: 'chats.delete', count: ids.length })
      const actorJid = resolveSelfJid()
      for (const id of ids) {
        recordEvent('chats.delete', { id }, { chatJid: id, actorJid })
      }
    },
    'presence.update': ({ id, presences }) =>
      logEvent(
        'presence.update',
        { id, count: Object.keys(presences).length },
        { chatJid: id, actorJid: resolveSelfJid() }
      ),
    'contacts.upsert': (contacts) => {
      logger.debug('evento do Baileys recebido', { event: 'contacts.upsert', count: contacts.length })
      const actorJid = resolveSelfJid()
      for (const contact of contacts) {
        if (!contact.id) continue
        recordEvent('contacts.upsert', { id: contact.id }, { targetJid: contact.id, actorJid })
      }
    },
    'contacts.update': (updates) => {
      logger.debug('evento do Baileys recebido', { event: 'contacts.update', count: updates.length })
      const actorJid = resolveSelfJid()
      for (const update of updates) {
        const id = (update as { id?: string | null }).id
        if (!id) continue
        recordEvent('contacts.update', { id }, { targetJid: id, actorJid })
      }
    },
    'messages.delete': (data) => {
      const selfJid = resolveSelfJid()
      if ('all' in data && data.all) {
        logEvent(
          'messages.delete',
          { jid: data.jid, all: true },
          { chatJid: data.jid ?? null, actorJid: selfJid }
        )
        return
      }
      if ('keys' in data) {
        logger.debug('evento do Baileys recebido', { event: 'messages.delete', count: data.keys.length })
        for (const key of data.keys) {
          const messageKey = toEventMessageKey(key)
          if (!messageKey) continue
          const chatJid = messageKey.chatJid
          const groupJid = toGroupJid(chatJid)
          const actorJid = key.fromMe
            ? selfJid
            : (key.participant ?? (groupJid ? null : chatJid))
          recordEvent(
            'messages.delete',
            { id: key.id ?? null },
            { chatJid, groupJid, messageKey, actorJid }
          )
        }
        return
      }
      logEvent('messages.delete', { count: 0 }, { actorJid: selfJid })
    },
    'messages.update': (updates) => {
      logger.debug('evento do Baileys recebido', { event: 'messages.update', count: updates.length })
      const selfJid = resolveSelfJid()
      for (const { key, update } of updates) {
        const messageKey = toEventMessageKey(key)
        if (!messageKey) continue
        const chatJid = messageKey.chatJid
        const groupJid = toGroupJid(chatJid)
        const actorJid = key.fromMe
          ? selfJid
          : (key.participant ?? (groupJid ? null : chatJid))
        recordEvent(
          'messages.update',
          { update },
          { chatJid, groupJid, messageKey, actorJid }
        )
      }
    },
    'messages.media-update': (updates) => {
      logger.debug('evento do Baileys recebido', { event: 'messages.media-update', count: updates.length })
      const selfJid = resolveSelfJid()
      for (const item of updates) {
        const key = (item as { key?: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null; participant?: string | null } }).key
        const update = (item as { update?: unknown }).update
        const messageKey = toEventMessageKey(key)
        if (!messageKey) continue
        const chatJid = messageKey.chatJid
        const groupJid = toGroupJid(chatJid)
        const actorJid = key?.fromMe
          ? selfJid
          : (key?.participant ?? (groupJid ? null : chatJid))
        recordEvent(
          'messages.media-update',
          { update },
          { chatJid, groupJid, messageKey, actorJid }
        )
      }
    },
    'messages.upsert': async (event) => {
      logger.info('messages.upsert recebido', {
        count: event.messages.length,
        type: event.type,
      })
      try {
        await handleIncomingMessages(sock, event.messages, logger)
        logger.debug('evento do Baileys recebido', {
          event: 'messages.upsert',
          count: event.messages.length,
          type: event.type,
        })
        if (sqlStore.enabled && event.type === 'notify') {
          const selfJid = resolveSelfJid()
          for (const message of event.messages) {
            const key = message.key
            const messageKey = toEventMessageKey(key)
            if (!messageKey) continue
            const chatJid = messageKey.chatJid
            const groupJid = toGroupJid(chatJid)
            const actorJid = key?.fromMe
              ? selfJid
              : (key?.participant ?? (groupJid ? null : chatJid))
            recordEvent(
              'messages.upsert',
              { type: event.type },
              { chatJid, groupJid, messageKey, actorJid }
            )
          }
        }
      } catch (error) {
        logger.error('falha ao processar messages.upsert', {
          err: error,
          count: event.messages.length,
          type: event.type,
        })
        if (sqlStore.enabled && event.messages.length) {
          const first = event.messages[0]
          const key = first?.key
          if (key?.remoteJid) {
            void sqlStore.recordMessageFailure({
              chatJid: key.remoteJid,
              messageId: key.id ?? null,
              senderJid: key.participant ?? null,
              reason: error instanceof Error ? error.message : 'erro ao processar message.upsert',
              data: { error, type: event.type },
            })
          }
        }
      }
    },
    'messages.reaction': (reactions) => {
      logger.debug('evento do Baileys recebido', { event: 'messages.reaction', count: reactions.length })
      for (const reaction of reactions) {
        const reactionAny = reaction as {
          key?: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null; participant?: string | null }
          sender?: string | null
          reaction?: { participant?: string | null }
        }
        const key = reactionAny.key
        const messageKey = toEventMessageKey(key)
        if (!messageKey) continue
        const chatJid = messageKey.chatJid
        const groupJid = toGroupJid(chatJid)
        const actorJid =
          reactionAny.key?.participant ?? reactionAny.sender ?? reactionAny.reaction?.participant ?? null
        const targetJid = reactionAny.key?.participant ?? null
        recordEvent(
          'messages.reaction',
          { id: key?.id ?? null },
          { chatJid, groupJid, messageKey, actorJid, targetJid }
        )
      }
    },
    'message-receipt.update': (updates) => {
      logger.debug('evento do Baileys recebido', { event: 'message-receipt.update', count: updates.length })
      for (const update of updates) {
        const updateAny = update as {
          key?: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null; participant?: string | null }
          participant?: string | null
          receipt?: unknown
        }
        const key = updateAny.key
        const messageKey = toEventMessageKey(key)
        if (!messageKey) continue
        const chatJid = messageKey.chatJid
        const groupJid = toGroupJid(chatJid)
        const actorJid = updateAny.participant ?? updateAny.key?.participant ?? null
        recordEvent(
          'message-receipt.update',
          { receipt: updateAny.receipt ?? null },
          { chatJid, groupJid, messageKey, actorJid }
        )
      }
    },
    'groups.upsert': (groups) => {
      logger.debug('evento do Baileys recebido', { event: 'groups.upsert', count: groups.length })
      const actorJid = resolveSelfJid()
      for (const group of groups) {
        if (!group.id) continue
        recordEvent('groups.upsert', { id: group.id }, { groupJid: group.id, actorJid })
      }
    },
    'groups.update': (updates) => {
      logger.debug('evento do Baileys recebido', { event: 'groups.update', count: updates.length })
      for (const update of updates) {
        const id = (update as { id?: string | null }).id
        if (!id) continue
        const actorJid = (update as { author?: string | null }).author ?? resolveSelfJid()
        recordEvent('groups.update', { id }, { groupJid: id, actorJid })
      }
    },
    'group-participants.update': ({ id, action, participants, author }) => {
      logger.debug('evento do Baileys recebido', {
        event: 'group-participants.update',
        id,
        action,
        count: participants.length,
      })
      const actorJid = author ?? resolveSelfJid()
      for (const participant of participants) {
        recordEvent(
          'group-participants.update',
          { id, action, participant: participant.id },
          { groupJid: id, actorJid, targetJid: participant.id }
        )
        if (sqlStore.enabled) {
          void sqlStore.recordGroupEvent({
            groupJid: id,
            eventType: action,
            actorJid,
            targetJid: participant.id,
            data: participant,
          })
        }
      }
    },
    'group.join-request': ({ id, action, method, participant, author }) => {
      const actorJid = author ?? resolveSelfJid()
      logEvent(
        'group.join-request',
        { id, action, method, participant },
        { groupJid: id, actorJid, targetJid: participant }
      )
      if (sqlStore.enabled) {
        void sqlStore.recordGroupJoinRequest({
          groupJid: id,
          userJid: participant,
          actorJid,
          action,
          method,
          data: { id, action, method, participant },
        })
        void sqlStore.recordGroupEvent({
          groupJid: id,
          eventType: 'join-request',
          actorJid,
          targetJid: participant,
          data: { action, method },
        })
      }
    },
    'group.member-tag.update': ({ groupId, participant, label }) =>
      logEvent(
        'group.member-tag.update',
        { groupId, participant, label },
        { groupJid: groupId, targetJid: participant, actorJid: resolveSelfJid() }
      ),
    'blocklist.set': ({ blocklist }) => {
      logger.debug('evento do Baileys recebido', { event: 'blocklist.set', count: blocklist.length })
      const actorJid = resolveSelfJid()
      for (const jid of blocklist) {
        recordEvent('blocklist.set', { jid }, { targetJid: jid, actorJid })
        if (sqlStore.enabled) {
          void sqlStore.setBlocklist({ jid, isBlocked: true })
        }
      }
    },
    'blocklist.update': ({ blocklist, type }) => {
      logger.debug('evento do Baileys recebido', { event: 'blocklist.update', count: blocklist.length, type })
      const actorJid = resolveSelfJid()
      if (sqlStore.enabled) {
        const isBlocked = type !== 'remove'
        for (const jid of blocklist) {
          recordEvent('blocklist.update', { jid, type }, { targetJid: jid, actorJid })
          void sqlStore.setBlocklist({ jid, isBlocked })
        }
      }
    },
    call: (calls) => {
      logger.debug('evento do Baileys recebido', { event: 'call', count: calls.length })
      for (const call of calls) {
        const entry = call as { chatId?: string | null; groupJid?: string | null; from?: string | null; id?: string | null; status?: string | null }
        const chatJid = entry.chatId ?? null
        const groupJid = entry.groupJid ?? toGroupJid(chatJid)
        const actorJid = entry.from ?? null
        recordEvent('call', { id: entry.id ?? null, status: entry.status ?? null }, { chatJid, groupJid, actorJid })
      }
    },
    'labels.edit': (label) => {
      const actorJid =
        (label as { author?: string | null }).author ??
        (label as { actor?: string | null }).actor ??
        (label as { creator?: string | null }).creator ??
        null
      logEvent('labels.edit', { id: label.id, deleted: label.deleted }, { actorJid })
    },
    'labels.association': ({ association, type }) => {
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
      const messageId = assoc.messageId ?? assoc.message_id
      const chatJid = assoc.chatId ?? assoc.chat_id ?? null
      const groupJid = assoc.groupJid ?? assoc.group_jid ?? null
      const contactJid = assoc.contactJid ?? assoc.contact_jid ?? null
      const actorJid = assoc.actor ?? assoc.author ?? null
      const associationType =
        messageId && chatJid
          ? 'message'
          : groupJid
            ? 'group'
            : contactJid
              ? 'contact'
              : 'chat'
      const messageKey =
        associationType === 'message' && messageId && chatJid
          ? { chatJid, messageId, fromMe: false }
          : null
      logEvent(
        'labels.association',
        { action: type, associationType, association },
        {
          actorJid,
          chatJid: associationType === 'chat' ? chatJid : null,
          groupJid: associationType === 'group' ? groupJid : null,
          targetJid: associationType === 'contact' ? contactJid : null,
          messageKey,
        }
      )
    },
    'newsletter.reaction': ({ id, server_id }) => {
      logEvent(
        'newsletter.reaction',
        { id, serverId: server_id },
        { actorJid: resolveSelfJid() }
      )
      if (sqlStore.enabled) {
        void sqlStore.recordNewsletter({ newsletterId: id, data: { id, server_id } })
        void sqlStore.recordNewsletterEvent({
          newsletterId: id,
          eventType: 'reaction',
          data: { id, server_id },
        })
      }
    },
    'newsletter.view': ({ id, server_id, count }) => {
      logEvent(
        'newsletter.view',
        { id, serverId: server_id, count },
        { actorJid: resolveSelfJid() }
      )
      if (sqlStore.enabled) {
        void sqlStore.recordNewsletter({ newsletterId: id, data: { id, server_id, count } })
        void sqlStore.recordNewsletterEvent({
          newsletterId: id,
          eventType: 'view',
          data: { id, server_id, count },
        })
      }
    },
    'newsletter-participants.update': ({ id, author, user, new_role, action }) => {
      logEvent(
        'newsletter-participants.update',
        { id, author, user, newRole: new_role, action },
        { actorJid: author ?? null, targetJid: user ?? null }
      )
      if (sqlStore.enabled) {
        if (user) {
          void sqlStore.recordNewsletterParticipant({
            newsletterId: id,
            userJid: user,
            role: new_role ?? null,
            status: action ?? null,
          })
        }
        void sqlStore.recordNewsletterEvent({
          newsletterId: id,
          eventType: 'participants.update',
          actorJid: author ?? null,
          targetJid: user ?? null,
          data: { id, author, user, new_role, action },
        })
      }
    },
    'newsletter-settings.update': ({ id }) => {
      logEvent(
        'newsletter-settings.update',
        { id },
        { actorJid: resolveSelfJid() }
      )
      if (sqlStore.enabled) {
        void sqlStore.recordNewsletterEvent({
          newsletterId: id,
          eventType: 'settings.update',
          data: { id },
        })
      }
    },
    'chats.lock': ({ id, locked }) =>
      logEvent('chats.lock', { id, locked }, { chatJid: id, actorJid: resolveSelfJid() }),
    'settings.update': (update) =>
      logEvent('settings.update', { setting: update.setting }, { actorJid: resolveSelfJid() }),
  }

  for (const event of ALL_EVENTS) {
    sock.ev.on(event, async (data) => {
      const handler = handlers[event] as EventHandler<typeof event> | undefined
      if (handler) {
        await handler(data as never)
      } else {
        logEvent(event, {})
      }
    })
  }
}
