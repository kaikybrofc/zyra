import { DisconnectReason, type BaileysEventMap, type GroupMetadata, type WASocket } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import type { AppLogger } from '../observability/logger.js'
import { config } from '../config/index.js'
import { handleIncomingMessages } from '../router/index.js'

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

export function registerEvents({ sock, logger, reconnect }: RegisterOptions): void {
  const logEvent = (event: keyof BaileysEventMap, meta: Record<string, unknown>) => {
    logger.debug('evento do Baileys recebido', { event, ...meta })
  }

  const syncGroupsOnConnect = async (): Promise<GroupMetadata[]> => {
    try {
      logger.info('sincronizando grupos da conta')
      const groupMap = await sock.groupFetchAllParticipating()
      const groups = Object.values(groupMap)
      if (groups.length) {
        sock.ev.emit('groups.upsert', groups)
        logger.info('grupos sincronizados', { count: groups.length })
      } else {
        logger.info('nenhum grupo encontrado para sincronizar')
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
      })

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        logger.warn('conexão encerrada', { statusCode })

        if (shouldReconnect) {
          void reconnect()
        }
      } else if (connection === 'open') {
        logger.info('conexão aberta')
        void (async () => {
          const groupsSnapshot = await syncGroupsOnConnect()
          await syncCommunitiesOnConnect(groupsSnapshot)
        })()
      }
    },
    'creds.update': () => {
      logEvent('creds.update', {})
    },
    'messaging-history.set': ({ chats, contacts, messages, isLatest, progress, syncType }) => {
      logEvent('messaging-history.set', {
        chats: chats.length,
        contacts: contacts.length,
        messages: messages.length,
        isLatest,
        progress,
        syncType,
      })
    },
    'chats.upsert': (chats) => logEvent('chats.upsert', { count: chats.length }),
    'chats.update': (updates) => logEvent('chats.update', { count: updates.length }),
    'lid-mapping.update': ({ lid, pn }) => logEvent('lid-mapping.update', { lid, pn }),
    'chats.delete': (ids) => logEvent('chats.delete', { count: ids.length }),
    'presence.update': ({ id, presences }) =>
      logEvent('presence.update', { id, count: Object.keys(presences).length }),
    'contacts.upsert': (contacts) => logEvent('contacts.upsert', { count: contacts.length }),
    'contacts.update': (updates) => logEvent('contacts.update', { count: updates.length }),
    'messages.delete': (data) => {
      if ('all' in data && data.all) {
        logEvent('messages.delete', { jid: data.jid, all: true })
        return
      }
      if ('keys' in data) {
        logEvent('messages.delete', { count: data.keys.length })
      } else {
        logEvent('messages.delete', { count: 0 })
      }
    },
    'messages.update': (updates) => logEvent('messages.update', { count: updates.length }),
    'messages.media-update': (updates) => logEvent('messages.media-update', { count: updates.length }),
    'messages.upsert': async (event) => {
      logger.info('messages.upsert recebido', {
        count: event.messages.length,
        type: event.type,
      })
      try {
        await handleIncomingMessages(sock, event.messages, logger)
        logEvent('messages.upsert', { count: event.messages.length, type: event.type })
      } catch (error) {
        logger.error('falha ao processar messages.upsert', {
          err: error,
          count: event.messages.length,
          type: event.type,
        })
      }
    },
    'messages.reaction': (reactions) =>
      logEvent('messages.reaction', { count: reactions.length }),
    'message-receipt.update': (updates) =>
      logEvent('message-receipt.update', { count: updates.length }),
    'groups.upsert': (groups) => logEvent('groups.upsert', { count: groups.length }),
    'groups.update': (updates) => logEvent('groups.update', { count: updates.length }),
    'group-participants.update': ({ id, action, participants }) =>
      logEvent('group-participants.update', {
        id,
        action,
        count: participants.length,
      }),
    'group.join-request': ({ id, action, method, participant }) =>
      logEvent('group.join-request', { id, action, method, participant }),
    'group.member-tag.update': ({ groupId, participant, label }) =>
      logEvent('group.member-tag.update', { groupId, participant, label }),
    'blocklist.set': ({ blocklist }) => logEvent('blocklist.set', { count: blocklist.length }),
    'blocklist.update': ({ blocklist, type }) =>
      logEvent('blocklist.update', { count: blocklist.length, type }),
    call: (calls) => logEvent('call', { count: calls.length }),
    'labels.edit': (label) =>
      logEvent('labels.edit', { id: label.id, deleted: label.deleted }),
    'labels.association': ({ association, type }) =>
      logEvent('labels.association', { type, association }),
    'newsletter.reaction': ({ id, server_id }) =>
      logEvent('newsletter.reaction', { id, serverId: server_id }),
    'newsletter.view': ({ id, server_id, count }) =>
      logEvent('newsletter.view', { id, serverId: server_id, count }),
    'newsletter-participants.update': ({ id, author, user, new_role, action }) =>
      logEvent('newsletter-participants.update', { id, author, user, newRole: new_role, action }),
    'newsletter-settings.update': ({ id }) => logEvent('newsletter-settings.update', { id }),
    'chats.lock': ({ id, locked }) => logEvent('chats.lock', { id, locked }),
    'settings.update': (update) => logEvent('settings.update', { setting: update.setting }),
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
