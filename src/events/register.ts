import { DisconnectReason, jidDecode, type BaileysEventMap, type GroupMetadata, type WAMessage, type WASocket } from 'baileys'
import { Boom } from '@hapi/boom'
import type { AppLogger } from '../observability/logger.js'
import { config } from '../config/index.js'
import { renderQrInTerminal } from './qr-terminal.js'
import { handleIncomingMessages } from '../router/index.js'
import { createSqlStore } from '../store/sql-store.js'
import { getMessageText, getNormalizedMessage } from '../utils/message.js'
import { dispatchWebhookEvent, WEBHOOK_SUPPORTED_EVENTS } from '../webhook/dispatcher.js'
import { enqueueConnectionOutboxEvent } from '../core/webhooks/outbox-dispatcher.js'

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
  /** Callback chamado sempre que um novo QR code é recebido do Baileys. */
  onQrCode?: (qr: string) => void
  /** Callback chamado quando a conexão é estabelecida com sucesso. */
  onConnectionOpen?: () => void
  /** Callback chamado quando a conexão é encerrada. */
  onConnectionClose?: () => void
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

/**
 * Cobertura explícita dos eventos do `BaileysEventMap` escutados pela aplicação.
 *
 * @remarks
 * A lista é usada para registro dinâmico de handlers e para garantir,
 * em tempo de compilação, que não existam chaves do mapa de eventos sem cobertura.
 */
const ALL_EVENTS = ['connection.update', 'creds.update', 'messaging-history.set', 'chats.upsert', 'chats.update', 'lid-mapping.update', 'chats.delete', 'presence.update', 'contacts.upsert', 'contacts.update', 'messages.delete', 'messages.update', 'messages.media-update', 'messages.upsert', 'messages.reaction', 'message-receipt.update', 'groups.upsert', 'groups.update', 'group-participants.update', 'group.join-request', 'group.member-tag.update', 'blocklist.set', 'blocklist.update', 'call', 'labels.edit', 'labels.association', 'newsletter.reaction', 'newsletter.view', 'newsletter-participants.update', 'newsletter-settings.update', 'chats.lock', 'settings.update'] as const satisfies readonly (keyof BaileysEventMap)[]
/** Status code observado quando há reachout timelock/restrição de envio (anti-spam). */
const REACHOUT_TIMELOCK_STATUS_CODE = 463

/**
 * Tipo utilitário para acusar, em build time, eventos não cobertos em `ALL_EVENTS`.
 */
type MissingEvents = Exclude<keyof BaileysEventMap, (typeof ALL_EVENTS)[number]>
type _AllEventsCoverageHint = MissingEvents extends never ? true : MissingEvents

/**
 * Define a estrutura de um manipulador de evento genérico.
 */
type EventHandler<K extends keyof BaileysEventMap> = (data: BaileysEventMap[K]) => void | Promise<void>

/**
 * Registra os listeners do Baileys e integra o pipeline com logs e persistência.
 *
 * @remarks
 * Este módulo centraliza o tratamento de eventos de conexão, credenciais,
 * mensagens, grupos, chamadas e newsletters, além de acionar rotas de negócio
 * e registrar trilhas de auditoria no SQL quando habilitado.
 *
 * @param options Dependências e callbacks do ciclo de vida da conexão.
 */
export function registerEvents({ sock, logger, reconnect, connectionId, onQrCode, onConnectionOpen, onConnectionClose }: RegisterOptions): void {
  /** Socket com capability opcional de flush imediato de credenciais. */
  const socketWithCredsFlush = sock as SocketWithCredsFlush
  /** Socket com capability opcional de consulta de metadados de newsletter. */
  const socketWithNewsletterMetadata = sock as SocketWithNewsletterMetadata
  /** Store SQL usada para auditoria, eventos e persistências complementares. */
  const sqlStore = createSqlStore(connectionId)
  /** Evita loop de restart após primeiro login (estabilização do estado inicial). */
  let restartedAfterNewLogin = false
  /** Evita spam de QR no terminal durante o mesmo ciclo de conexão. */
  let qrRenderedInCurrentCycle = false
  /** Contador de QR suprimidos no terminal para observabilidade. */
  let suppressedTerminalQrCount = 0
  /** Cache de sincronização de metadados de newsletters com TTL e dedupe de chamadas concorrentes. */
  const newsletterMetadataSync = new Map<string, { nextAttemptAt: number; inFlight?: Promise<void> }>()
  /** TTL de sucesso para sync de metadados de newsletter. */
  const NEWSLETTER_METADATA_SYNC_TTL_MS = config.newsletterMetadataSyncTtlMs
  /** TTL de retry quando sync de metadados falha. */
  const NEWSLETTER_METADATA_RETRY_TTL_MS = config.newsletterMetadataRetryTtlMs
  /** Limite de entries do cache de metadados para conter uso de memória. */
  const MAX_NEWSLETTER_METADATA_ENTRIES = 1_000
  /** Estado de retentativa para refresh de mídia de newsletters com mediaKey ausente/inválida. */
  const newsletterMediaRetryState = new Map<string, { attempts: number; nextAttemptAt: number; lastError?: string | null }>()
  /** Backoff base (ms) para retentativas de refresh de mídia de newsletter. */
  const NEWSLETTER_MEDIA_RETRY_BASE_MS = config.newsletterMediaRetryBaseMs
  /** Máximo de tentativas para refresh de mídia de newsletter por mensagem. */
  const NEWSLETTER_MEDIA_RETRY_MAX_ATTEMPTS = config.newsletterMediaRetryMaxAttempts
  /** Limite de entries do estado de retry para conter memória em alto throughput. */
  const MAX_NEWSLETTER_MEDIA_RETRY_ENTRIES = 5_000

  /**
   * Remove o item mais antigo de um `Map` quando o limite de capacidade é excedido.
   * Útil para caches/estados em memória com política FIFO simples.
   */
  const evictOldestIfNeeded = <K, V>(map: Map<K, V>, max: number): void => {
    if (map.size > max) {
      const oldest = map.keys().next().value
      if (oldest !== undefined) map.delete(oldest)
    }
  }
  type EventContext = {
    actorJid?: string | null
    targetJid?: string | null
    chatJid?: string | null
    groupJid?: string | null
    messageKey?: { chatJid: string; messageId: string; fromMe: boolean } | null
  }

  /**
   * Persiste um evento padronizado no banco de auditoria (`events_log`).
   */
  const recordEvent = (event: keyof BaileysEventMap, meta: Record<string, unknown>, context?: EventContext) => {
    if (!sqlStore.enabled) return
    void sqlStore.recordEvent({ type: String(event), data: meta, ...context })
  }

  /**
   * Loga o evento em nível debug e replica para auditoria SQL.
   */
  const logEvent = (event: keyof BaileysEventMap, meta: Record<string, unknown>, context?: EventContext) => {
    logger.debug('evento do Baileys recebido', { event, ...meta })
    recordEvent(event, meta, context)
  }

  /**
   * Resolve o JID da própria sessão autenticada, quando disponível.
   */
  const resolveSelfJid = () => sock.user?.id ?? null

  /**
   * Converte chave de mensagem do Baileys para formato canônico de auditoria.
   */
  const toEventMessageKey = (key?: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null }) => {
    if (!key?.remoteJid || !key.id) return null
    return { chatJid: key.remoteJid, messageId: key.id, fromMe: Boolean(key.fromMe) }
  }

  /**
   * Normaliza JID de grupo, retornando `null` para chats que não são `@g.us`.
   */
  const toGroupJid = (jid?: string | null) => (jid && jid.endsWith('@g.us') ? jid : null)

  /**
   * Persiste mapeamento de device vinculado ao usuário quando o JID contém sufixo de device.
   */
  const persistUserDeviceFromJid = (rawJid: string | null | undefined, source: string) => {
    if (!sqlStore.enabled || !rawJid) return
    const decoded = jidDecode(rawJid)
    if (!decoded?.user || !decoded.server || typeof decoded.device !== 'number' || decoded.device < 0) return
    const userJid = `${decoded.user}@${decoded.server}`
    void sqlStore.setUserDevice({
      userJid,
      deviceId: String(decoded.device),
      data: {
        source,
        rawJid,
        server: decoded.server,
      },
    })
  }

  /**
   * Extrai e persiste devices de `participant` e `remoteJid` a partir de uma message key.
   */
  const persistDevicesFromMessageKey = (key?: { remoteJid?: string | null; participant?: string | null; fromMe?: boolean | null }, source = 'messages.upsert') => {
    if (!key) return
    persistUserDeviceFromJid(key.participant ?? null, `${source}:participant`)
    if (!key.fromMe) {
      persistUserDeviceFromJid(key.remoteJid ?? null, `${source}:remoteJid`)
    }
  }

  /**
   * Verifica se o JID pertence a um canal/newsletter.
   */
  const isNewsletterJid = (jid?: string | null): jid is string => Boolean(jid && jid.endsWith('@newsletter'))

  /**
   * Gera chave estável para controle de retry de mídia de newsletter.
   */
  const getNewsletterRetryKey = (message: WAMessage): string | null => {
    const chatJid = message.key?.remoteJid
    const messageId = message.key?.id
    if (!chatJid || !messageId || !isNewsletterJid(chatJid)) return null
    return `${chatJid}:${messageId}`
  }

  /**
   * Detecta presença de `mediaKey` válida na mensagem (ou timestamp compatível).
   */
  const hasMediaKey = (message: WAMessage): boolean => {
    const normalized = getNormalizedMessage(message)
    if (!normalized.content || !normalized.type) return false
    const inner = (normalized.content as Record<string, unknown>)[normalized.type] as { mediaKey?: Uint8Array | Buffer | null; mediaKeyTimestamp?: number | null } | null | undefined
    if (!inner || typeof inner !== 'object') return false
    if (inner.mediaKey && ((inner.mediaKey as Uint8Array).byteLength ?? 0) > 0) return true
    return typeof inner.mediaKeyTimestamp === 'number' && Number.isFinite(inner.mediaKeyTimestamp)
  }

  /**
   * Detecta indícios de transporte (`directPath`/`url`) para tentar refresh de mídia.
   */
  const hasMediaTransportHints = (message: WAMessage): boolean => {
    const normalized = getNormalizedMessage(message)
    if (!normalized.content || !normalized.type) return false
    const inner = (normalized.content as Record<string, unknown>)[normalized.type] as { directPath?: string | null; url?: string | null } | null | undefined
    if (!inner || typeof inner !== 'object') return false
    return Boolean(inner.directPath || inner.url)
  }

  /**
   * Classifica erros conhecidos do stack de mídia para reduzir ruído de logs.
   */
  const isKnownNewsletterMediaRefreshError = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("Cannot read properties of null (reading 'length')")) return true
    if (!(error instanceof Error) || !error.stack) return false
    return error.stack.includes('passArray8ToWasm0') && error.stack.includes('messages-media.js')
  }

  /**
   * Tenta recuperar mídia de newsletter chamando `updateMediaMessage` com retentativa e backoff.
   *
   * @remarks
   * Quando o refresh funciona, emite `messages.update` sintético para reaproveitar pipeline já existente.
   */
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
    evictOldestIfNeeded(newsletterMediaRetryState, MAX_NEWSLETTER_MEDIA_RETRY_ENTRIES)
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
      evictOldestIfNeeded(newsletterMediaRetryState, MAX_NEWSLETTER_MEDIA_RETRY_ENTRIES)
      const isKnownError = isKnownNewsletterMediaRefreshError(error)
      if (isKnownError) {
        logger.debug('falha conhecida ao atualizar midia de newsletter (ignorada)', {
          chatJid,
          messageId: key?.id ?? null,
          messageType: normalized.type,
          attempt: prev?.attempts ?? nextAttempt,
          error: messageError,
        })
        return
      }
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
  /**
   * Persiste snapshot consolidado da newsletter para consultas rápidas.
   */
  const recordNewsletterSnapshot = (newsletterId: string | null | undefined, data: Record<string, unknown>) => {
    if (!sqlStore.enabled || !newsletterId) return
    void sqlStore.recordNewsletter({ newsletterId, data })
  }
  /**
   * Persiste metadados normalizados da newsletter e registra owner como participante quando disponível.
   */
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
  /**
   * Sincroniza metadados de newsletter com deduplicação e TTL para evitar sobrecarga.
   */
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
    evictOldestIfNeeded(newsletterMetadataSync, MAX_NEWSLETTER_METADATA_ENTRIES)
    await inFlight
  }
  /**
   * Registra evento e snapshot de newsletter a partir de `messages.upsert`.
   */
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

  /**
   * Sincroniza grupos no momento em que a conexão abre, com tentativa extra em caso de vazio inicial.
   */
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

  /**
   * Sincroniza comunidades e aplica fallback de detecção via snapshot de grupos.
   */
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

  /**
   * Tabela de handlers por evento do Baileys.
   *
   * @remarks
   * Mantém todo o comportamento reativo em um único mapa para facilitar cobertura,
   * auditoria e manutenção evolutiva.
   */
  const handlers: Partial<{ [K in keyof BaileysEventMap]: EventHandler<K> }> = {
    'connection.update': (update) => {
      const { connection, lastDisconnect, qr, receivedPendingNotifications, isNewLogin } = update

      if (qr) {
        if (config.printQRInTerminal) {
          if (!qrRenderedInCurrentCycle) {
            renderQrInTerminal(logger, qr, connectionId)
            qrRenderedInCurrentCycle = true
            suppressedTerminalQrCount = 0
          } else {
            suppressedTerminalQrCount += 1
            if (suppressedTerminalQrCount === 1 || suppressedTerminalQrCount % 10 === 0) {
              logger.info('novo QR recebido; impressão no terminal suprimida até concluir a chamada atual', {
                connectionId,
                suppressedCount: suppressedTerminalQrCount,
              })
            }
          }
        }
        onQrCode?.(qr)
      }

      if (connection === 'open' || connection === 'close') {
        qrRenderedInCurrentCycle = false
        suppressedTerminalQrCount = 0
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
        onConnectionClose?.()
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
        if (statusCode === DisconnectReason.loggedOut) {
          void enqueueConnectionOutboxEvent(connectionId, 'connection.auth.logged_out', {
            statusCode,
            shouldReconnect: false,
          })
        } else if (statusCode) {
          void enqueueConnectionOutboxEvent(connectionId, 'connection.error', {
            statusCode,
            restartRequired,
            shouldReconnect,
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
        onConnectionOpen?.()
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
        persistDevicesFromMessageKey(key, 'messages.update')
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
        persistDevicesFromMessageKey(key, 'messages.media-update')
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
            persistDevicesFromMessageKey(message.key, 'messages.upsert')
            newsletterTasks.push(recordNewsletterFromMessage(message, event.type))
          }
          if (newsletterTasks.length) {
            await Promise.allSettled(newsletterTasks)
          }
        }
        if (sqlStore.enabled) {
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

  /**
   * Registra listeners dinâmicos para cada evento coberto em `ALL_EVENTS`.
   */
  for (const event of ALL_EVENTS) {
    sock.ev.on(event, async (data) => {
      const handler = handlers[event] as EventHandler<typeof event> | undefined
      if (handler) {
        await handler(data as never)
      } else {
        logEvent(event, {})
      }
      if (WEBHOOK_SUPPORTED_EVENTS.has(event)) {
        void dispatchWebhookEvent(connectionId, event, data)
      }
    })
  }
}
