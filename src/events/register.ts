import { DisconnectReason, type BaileysEventMap, type GroupMetadata, type WAMessage, type WASocket } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode-terminal'
import type { AppLogger } from '../observability/logger.js'
import { config } from '../config/index.js'
import { handleIncomingMessages } from '../router/index.js'
import { createSqlStore } from '../store/sql-store.js'
import { getMessageText, getNormalizedMessage } from '../utils/message.js'

/**
 * Opções de inicialização para o registro de eventos.
 */
type RegisterOptions = {
  /** Instância do socket do Baileys. */
  sock: WASocket
  /** Logger da aplicação. */
  logger: AppLogger
  /** Função para disparar a reconexão do socket. */
  reconnect: () => Promise<void>
  /** Identificador único da conexão (usado para logs e banco de dados). */
  connectionId: string
}

/**
 * Extensão do socket para incluir métodos de persistência imediata.
 */
type SocketWithCredsFlush = WASocket & {
  /** Força a persistência imediata das credenciais. */
  flushCredsNow?: (reason: string) => Promise<void>
}

/**
 * Metadados de uma Newsletter (Canal).
 */
type NewsletterMetadata = {
  /** JID da Newsletter. */
  id: string
  /** JID do proprietário. */
  owner?: string | null
  /** Nome da Newsletter. */
  name?: string
  /** Descrição da Newsletter. */
  description?: string | null
  /** Link de convite. */
  invite?: string | null
  /** Timestamp de criação. */
  creation_time?: number | null
  /** Número de inscritos. */
  subscribers?: number | null
  /** Status de verificação. */
  verification?: string | null
  /** Estado de silenciamento. */
  mute_state?: string | null
  /** Foto de perfil. */
  picture?: unknown
  /** Metadados da thread (mensagens). */
  thread_metadata?: {
    creation_time?: number | null
    name?: string
    description?: string | null
  } | null
}

/**
 * Extensão do socket para incluir busca de metadados de Newsletter.
 */
type SocketWithNewsletterMetadata = WASocket & {
  /** Busca metadados de uma Newsletter via JID ou invite. */
  newsletterMetadata?: (type: 'invite' | 'jid', key: string) => Promise<NewsletterMetadata | null>
}

const ALL_EVENTS = ['connection.update', 'creds.update', 'messaging-history.set', 'chats.upsert', 'chats.update', 'lid-mapping.update', 'chats.delete', 'presence.update', 'contacts.upsert', 'contacts.update', 'messages.delete', 'messages.update', 'messages.media-update', 'messages.upsert', 'messages.reaction', 'message-receipt.update', 'groups.upsert', 'groups.update', 'group-participants.update', 'group.join-request', 'group.member-tag.update', 'blocklist.set', 'blocklist.update', 'call', 'labels.edit', 'labels.association', 'newsletter.reaction', 'newsletter.view', 'newsletter-participants.update', 'newsletter-settings.update', 'chats.lock', 'settings.update'] as const satisfies readonly (keyof BaileysEventMap)[]
const REACHOUT_TIMELOCK_STATUS_CODE = 463

type MissingEvents = Exclude<keyof BaileysEventMap, (typeof ALL_EVENTS)[number]>
type _AllEventsCoverageHint = MissingEvents extends never ? true : MissingEvents

/**
 * Define a estrutura de um manipulador de evento genérico.
 */
type EventHandler<K extends keyof BaileysEventMap> = (data: BaileysEventMap[K]) => void | Promise<void>

/**
 * Registra todos os listeners de eventos do Baileys e integra com persistência SQL e logs.
 * Esta função é o coração da reatividade do bot, lidando desde conexões até mensagens e newsletters.
 * 
 * @param options Opções de configuração contendo o socket, logger e callbacks de ciclo de vida.
 */
export function registerEvents({ sock, logger, reconnect, connectionId }: RegisterOptions): void {
  const socketWithCredsFlush = sock as SocketWithCredsFlush
  const socketWithNewsletterMetadata = sock as SocketWithNewsletterMetadata
  const sqlStore = createSqlStore(connectionId)
  let restartedAfterNewLogin = false
  const newsletterMetadataSync = new Map<string, { nextAttemptAt: number; inFlight?: Promise<void> }>()
  const NEWSLETTER_METADATA_SYNC_TTL_MS = 5 * 60_000
  const NEWSLETTER_METADATA_RETRY_TTL_MS = 30 * 1000
  const newsletterMediaRetryState = new Map<string, { attempts: number; nextAttemptAt: number; lastError?: string | null }>()
  const NEWSLETTER_MEDIA_RETRY_BASE_MS = 10_000
  const NEWSLETTER_MEDIA_RETRY_MAX_ATTEMPTS = 5
  type EventContext = {
    actorJid?: string | null
    targetJid?: string | null
    chatJid?: string | null
    groupJid?: string | null
    messageKey?: { chatJid: string; messageId: string; fromMe: boolean } | null
  }
  const recordEvent = (event: keyof BaileysEventMap, meta: Record<string, unknown>, context?: EventContext) => {
    if (!sqlStore.enabled) return
    void sqlStore.recordEvent({ type: String(event), data: meta, ...context })
  }
  const logEvent = (event: keyof BaileysEventMap, meta: Record<string, unknown>, context?: EventContext) => {
    logger.debug('evento do Baileys recebido', { event, ...meta })
    recordEvent(event, meta, context)
  }
  const resolveSelfJid = () => sock.user?.id ?? null
  const toEventMessageKey = (key?: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null }) => {
    if (!key?.remoteJid || !key.id) return null
    return { chatJid: key.remoteJid, messageId: key.id, fromMe: Boolean(key.fromMe) }
  }
  const toGroupJid = (jid?: string | null) => (jid && jid.endsWith('@g.us') ? jid : null)
  const isNewsletterJid = (jid?: string | null): jid is string => Boolean(jid && jid.endsWith('@newsletter'))
  const getNewsletterRetryKey = (message: WAMessage): string | null => {
    const chatJid = message.key?.remoteJid
    const messageId = message.key?.id
    if (!chatJid || !messageId || !isNewsletterJid(chatJid)) return null
    return `${chatJid}:${messageId}`
  }
  const hasMediaKey = (message: WAMessage): boolean => {
    const normalized = getNormalizedMessage(message)
    if (!normalized.content || !normalized.type) return false
    const inner = (normalized.content as Record<string, unknown>)[normalized.type] as
      | { mediaKey?: Uint8Array | Buffer | null; mediaKeyTimestamp?: number | null }
      | null
      | undefined
    if (!inner || typeof inner !== 'object') return false
    if (inner.mediaKey && ((inner.mediaKey as Uint8Array).byteLength ?? 0) > 0) return true
    return typeof inner.mediaKeyTimestamp === 'number' && Number.isFinite(inner.mediaKeyTimestamp)
  }
  const hasMediaTransportHints = (message: WAMessage): boolean => {
    const normalized = getNormalizedMessage(message)
    if (!normalized.content || !normalized.type) return false
    const inner = (normalized.content as Record<string, unknown>)[normalized.type] as
      | { directPath?: string | null; url?: string | null }
      | null
      | undefined
    if (!inner || typeof inner !== 'object') return false
    return Boolean(inner.directPath || inner.url)
  }
  const maybeRefreshNewsletterMedia = async (message: WAMessage): Promise<void> => {
    const key = message.key
    const chatJid = key?.remoteJid ?? null
    if (!isNewsletterJid(chatJid)) return
    const normalized = getNormalizedMessage(message)
    if (!normalized.type || !['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage'].includes(normalized.type)) return
    const retryKey = getNewsletterRetryKey(message)
    if (!retryKey) return
    if (hasMediaKey(message)) {
      newsletterMediaRetryState.delete(retryKey)
      return
    }
    if (!hasMediaTransportHints(message)) return
    const now = Date.now()
    const retryState = newsletterMediaRetryState.get(retryKey)
    if (retryState) {
      if (retryState.attempts >= NEWSLETTER_MEDIA_RETRY_MAX_ATTEMPTS) return
      if (retryState.nextAttemptAt > now) return
    }
    const nextAttempt = (retryState?.attempts ?? 0) + 1
    newsletterMediaRetryState.set(retryKey, {
      attempts: nextAttempt,
      nextAttemptAt: now + NEWSLETTER_MEDIA_RETRY_BASE_MS * nextAttempt,
      lastError: retryState?.lastError ?? null,
    })
    try {
      const refreshed = await sock.updateMediaMessage(message)
      if (!refreshed || !refreshed.key || !hasMediaKey(refreshed)) return
      sock.ev.emit('messages.update', [{ key: refreshed.key, update: refreshed }])
      newsletterMediaRetryState.delete(retryKey)
      logger.debug('midia newsletter atualizada via updateMediaMessage', {
        chatJid,
        messageId: refreshed.key.id ?? key?.id ?? null,
        messageType: normalized.type,
      })
    } catch (error) {
      const messageError = error instanceof Error ? error.message : String(error)
      const prev = newsletterMediaRetryState.get(retryKey)
      newsletterMediaRetryState.set(retryKey, {
        attempts: prev?.attempts ?? nextAttempt,
        nextAttemptAt: now + NEWSLETTER_MEDIA_RETRY_BASE_MS * (prev?.attempts ?? nextAttempt),
        lastError: messageError,
      })
      const shouldLogWarn = !prev?.lastError || prev.lastError !== messageError
      if (shouldLogWarn) {
        logger.warn('falha ao atualizar midia de newsletter', {
          err: error,
          chatJid,
          messageId: key?.id ?? null,
          messageType: normalized.type,
          attempt: prev?.attempts ?? nextAttempt,
        })
      }
    }
  }
  const recordNewsletterSnapshot = (newsletterId: string | null | undefined, data: Record<string, unknown>) => {
    if (!sqlStore.enabled || !newsletterId) return
    void sqlStore.recordNewsletter({ newsletterId, data })
  }
  const recordNewsletterMetadata = async (newsletterId: string, metadata: NewsletterMetadata | null | undefined) => {
    if (!sqlStore.enabled || !metadata) return
    recordNewsletterSnapshot(newsletterId, {
      id: newsletterId,
      owner: metadata.owner ?? null,
      name: metadata.name ?? metadata.thread_metadata?.name ?? null,
      description: metadata.description ?? metadata.thread_metadata?.description ?? null,
      invite: metadata.invite ?? null,
      creationTime: metadata.creation_time ?? metadata.thread_metadata?.creation_time ?? null,
      subscribers: metadata.subscribers ?? null,
      verification: metadata.verification ?? null,
      muteState: metadata.mute_state ?? null,
      picture: metadata.picture ?? null,
    })
    if (metadata.owner) {
      await sqlStore.recordNewsletterParticipant({
        newsletterId,
        userJid: metadata.owner,
        role: 'OWNER',
        status: 'ACTIVE',
      })
    }
  }
  const syncNewsletterMetadata = async (newsletterId: string, source: string, options?: { force?: boolean }) => {
    if (!sqlStore.enabled) return
    if (typeof socketWithNewsletterMetadata.newsletterMetadata !== 'function') return
    const cached = newsletterMetadataSync.get(newsletterId)
    const now = Date.now()
    if (cached?.inFlight) {
      await cached.inFlight
      return
    }
    if (!options?.force && cached && cached.nextAttemptAt > now) {
      return
    }
    const inFlight = (async () => {
      try {
        const metadata = await socketWithNewsletterMetadata.newsletterMetadata?.('jid', newsletterId)
        await recordNewsletterMetadata(newsletterId, metadata)
        newsletterMetadataSync.set(newsletterId, { nextAttemptAt: Date.now() + NEWSLETTER_METADATA_SYNC_TTL_MS })
      } catch (error) {
        newsletterMetadataSync.set(newsletterId, { nextAttemptAt: Date.now() + NEWSLETTER_METADATA_RETRY_TTL_MS })
        logger.debug('falha ao sincronizar metadados de newsletter', { newsletterId, source, err: error })
      }
    })()
    newsletterMetadataSync.set(newsletterId, { nextAttemptAt: now + NEWSLETTER_METADATA_SYNC_TTL_MS, inFlight })
    await inFlight
  }
  const recordNewsletterFromMessage = async (message: BaileysEventMap['messages.upsert']['messages'][number], upsertType: string) => {
    const key = message.key
    const newsletterId = isNewsletterJid(key?.remoteJid) ? key.remoteJid : null
    if (!newsletterId) return
    const normalizedMessage = getNormalizedMessage(message)
    recordNewsletterSnapshot(newsletterId, {
      id: newsletterId,
      lastMessageId: key?.id ?? null,
      fromMe: Boolean(key?.fromMe),
      pushName: message.pushName ?? null,
      messageTimestamp: message.messageTimestamp ?? null,
      messageType: normalizedMessage.type,
    })
    void sqlStore.recordNewsletterEvent({
      newsletterId,
      eventType: `message.${upsertType}`,
      data: {
        id: newsletterId,
        messageId: key?.id ?? null,
        fromMe: Boolean(key?.fromMe),
        pushName: message.pushName ?? null,
        messageTimestamp: message.messageTimestamp ?? null,
        messageType: normalizedMessage.type,
        text: getMessageText(message),
      },
    })
    await syncNewsletterMetadata(newsletterId, 'messages.upsert')
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
        const linkedParents = new Set(groupsSnapshot.map((group) => group.linkedParent).filter((jid): jid is string => Boolean(jid)))
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

      logEvent(
        'connection.update',
        {
          connection,
          hasQr: Boolean(qr),
          receivedPendingNotifications,
          isNewLogin,
        },
        { actorJid: resolveSelfJid() }
      )

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        const restartRequired = statusCode === DisconnectReason.restartRequired

        logger.warn('conexão encerrada', { statusCode, restartRequired })
        if (statusCode === REACHOUT_TIMELOCK_STATUS_CODE) {
          logger.error('alerta de restricao de conta detectado (463)', {
            statusCode,
            connectionId,
            recommendation: 'verifique reachout timelock/tctoken e reduza alcance para novos contatos temporariamente',
          })
        }

        if (shouldReconnect) {
          void (async () => {
            if (restartRequired && socketWithCredsFlush.flushCredsNow) {
              try {
                await socketWithCredsFlush.flushCredsNow('before_reconnect')
              } catch (error) {
                logger.warn('falha ao forcar persistencia de creds antes de reconectar', { err: error })
              }
            }
            await reconnect()
          })()
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
      logEvent(
        'messaging-history.set',
        {
          chats: chats.length,
          contacts: contacts.length,
          messages: messages.length,
          isLatest,
          progress,
          syncType,
        },
        { actorJid: resolveSelfJid() }
      )
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
    'lid-mapping.update': ({ lid, pn }) => logEvent('lid-mapping.update', { lid, pn }, { actorJid: resolveSelfJid() }),
    'chats.delete': (ids) => {
      logger.debug('evento do Baileys recebido', { event: 'chats.delete', count: ids.length })
      const actorJid = resolveSelfJid()
      for (const id of ids) {
        recordEvent('chats.delete', { id }, { chatJid: id, actorJid })
      }
    },
    'presence.update': ({ id, presences }) => logEvent('presence.update', { id, count: Object.keys(presences).length }, { chatJid: id, actorJid: resolveSelfJid() }),
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
        logEvent('messages.delete', { jid: data.jid, all: true }, { chatJid: data.jid ?? null, actorJid: selfJid })
        return
      }
      if ('keys' in data) {
        logger.debug('evento do Baileys recebido', { event: 'messages.delete', count: data.keys.length })
        for (const key of data.keys) {
          const messageKey = toEventMessageKey(key)
          if (!messageKey) continue
          const chatJid = messageKey.chatJid
          const groupJid = toGroupJid(chatJid)
          const actorJid = key.fromMe ? selfJid : (key.participant ?? (groupJid ? null : chatJid))
          recordEvent('messages.delete', { id: key.id ?? null }, { chatJid, groupJid, messageKey, actorJid })
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
        const actorJid = key.fromMe ? selfJid : (key.participant ?? (groupJid ? null : chatJid))
        recordEvent('messages.update', { update }, { chatJid, groupJid, messageKey, actorJid })
      }
    },
    'messages.media-update': (updates) => {
      logger.debug('evento do Baileys recebido', { event: 'messages.media-update', count: updates.length })
      const selfJid = resolveSelfJid()
      for (const item of updates) {
        const key = (item as { key?: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null; participant?: string | null } }).key
        const update = (item as { update?: unknown }).update
        const mergedMessage = { key, ...(typeof update === 'object' && update ? (update as object) : {}) } as WAMessage
        void maybeRefreshNewsletterMedia(mergedMessage)
        const messageKey = toEventMessageKey(key)
        if (!messageKey) continue
        const chatJid = messageKey.chatJid
        const groupJid = toGroupJid(chatJid)
        const actorJid = key?.fromMe ? selfJid : (key?.participant ?? (groupJid ? null : chatJid))
        recordEvent('messages.media-update', { update }, { chatJid, groupJid, messageKey, actorJid })
      }
    },
    'messages.upsert': async (event) => {
      logger.info('messages.upsert recebido', {
        count: event.messages.length,
        type: event.type,
      })
      try {
        if (event.type === 'notify') {
          await handleIncomingMessages(sock, event.messages, logger, connectionId, sqlStore)
          const refreshTasks = event.messages.map((message) => maybeRefreshNewsletterMedia(message))
          if (refreshTasks.length) {
            await Promise.allSettled(refreshTasks)
          }
        }
        logger.debug('evento do Baileys recebido', {
          event: 'messages.upsert',
          count: event.messages.length,
          type: event.type,
        })
        if (sqlStore.enabled) {
          const newsletterTasks: Promise<void>[] = []
          for (const message of event.messages) {
            newsletterTasks.push(recordNewsletterFromMessage(message, event.type))
          }
          if (newsletterTasks.length) {
            await Promise.allSettled(newsletterTasks)
          }
        }
        if (sqlStore.enabled && event.type === 'notify') {
          const selfJid = resolveSelfJid()
          for (const message of event.messages) {
            const key = message.key
            const messageKey = toEventMessageKey(key)
            if (!messageKey) continue
            const chatJid = messageKey.chatJid
            const groupJid = toGroupJid(chatJid)
            const actorJid = key?.fromMe ? selfJid : (key?.participant ?? (groupJid ? null : chatJid))
            recordEvent('messages.upsert', { type: event.type }, { chatJid, groupJid, messageKey, actorJid })
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
        const actorJid = reactionAny.key?.participant ?? reactionAny.sender ?? reactionAny.reaction?.participant ?? null
        const targetJid = reactionAny.key?.participant ?? null
        recordEvent('messages.reaction', { id: key?.id ?? null }, { chatJid, groupJid, messageKey, actorJid, targetJid })
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
        recordEvent('message-receipt.update', { receipt: updateAny.receipt ?? null }, { chatJid, groupJid, messageKey, actorJid })
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
        recordEvent('group-participants.update', { id, action, participant: participant.id }, { groupJid: id, actorJid, targetJid: participant.id })
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
      logEvent('group.join-request', { id, action, method, participant }, { groupJid: id, actorJid, targetJid: participant })
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
    'group.member-tag.update': ({ groupId, participant, label }) => logEvent('group.member-tag.update', { groupId, participant, label }, { groupJid: groupId, targetJid: participant, actorJid: resolveSelfJid() }),
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
      const actorJid = (label as { author?: string | null }).author ?? (label as { actor?: string | null }).actor ?? (label as { creator?: string | null }).creator ?? null
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
      const associationType = messageId && chatJid ? 'message' : groupJid ? 'group' : contactJid ? 'contact' : 'chat'
      const messageKey = associationType === 'message' && messageId && chatJid ? { chatJid, messageId, fromMe: false } : null
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
      logEvent('newsletter.reaction', { id, serverId: server_id }, { actorJid: resolveSelfJid() })
      if (sqlStore.enabled) {
        recordNewsletterSnapshot(id, { id, server_id })
        void sqlStore.recordNewsletterEvent({
          newsletterId: id,
          eventType: 'reaction',
          data: { id, server_id },
        })
      }
    },
    'newsletter.view': ({ id, server_id, count }) => {
      logEvent('newsletter.view', { id, serverId: server_id, count }, { actorJid: resolveSelfJid() })
      if (sqlStore.enabled) {
        recordNewsletterSnapshot(id, { id, server_id, count })
        void sqlStore.recordNewsletterEvent({
          newsletterId: id,
          eventType: 'view',
          data: { id, server_id, count },
        })
      }
    },
    'newsletter-participants.update': ({ id, author, user, new_role, action }) => {
      logEvent('newsletter-participants.update', { id, author, user, newRole: new_role, action }, { actorJid: author ?? null, targetJid: user ?? null })
      if (sqlStore.enabled) {
        recordNewsletterSnapshot(id, { id, author, user, new_role, action })
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
    'newsletter-settings.update': ({ id, update }) => {
      logEvent('newsletter-settings.update', { id, update }, { actorJid: resolveSelfJid() })
      if (sqlStore.enabled) {
        recordNewsletterSnapshot(id, { id, update: update ?? null })
        void sqlStore.recordNewsletterEvent({
          newsletterId: id,
          eventType: 'settings.update',
          data: { id, update: update ?? null },
        })
        void syncNewsletterMetadata(id, 'newsletter-settings.update', { force: true })
      }
    },
    'chats.lock': ({ id, locked }) => logEvent('chats.lock', { id, locked }, { chatJid: id, actorJid: resolveSelfJid() }),
    'settings.update': (update) => logEvent('settings.update', { setting: update.setting }, { actorJid: resolveSelfJid() }),
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
