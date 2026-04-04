import makeWASocket, {
  Browsers,
  DEFAULT_CONNECTION_CONFIG,
  fetchLatestBaileysVersion,
  type SignalRepositoryWithLIDStore,
} from '@whiskeysockets/baileys'
import type { AppLogger } from '../../observability/logger.js'
import { createBaileysLogger } from '../../observability/baileys-logger.js'
import { createBaileysStore } from '../../store/baileys-store.js'
import { getAuthState } from '../auth/state.js'
import { allowHistorySyncOnceForNewLogin, initHistorySyncPolicy, shouldSyncHistoryMessageOnce } from './history-sync.js'

const store = createBaileysStore()

type SocketWithSignalRepository = {
  signalRepository?: SignalRepositoryWithLIDStore
}

async function resolveBaileysVersion(logger: AppLogger) {
  try {
    const latest = await fetchLatestBaileysVersion()
    if ('error' in latest && latest.error) {
      logger.warn('falha ao buscar a última versão do Baileys, usando a versão padrão', {
        err: latest.error,
      })
      return DEFAULT_CONNECTION_CONFIG.version
    }

    if (!latest.isLatest) {
      logger.warn('versão do Baileys não é a mais recente, usando a versão obtida', {
        version: latest.version,
      })
    }

    return latest.version
  } catch (error) {
    logger.warn('falha ao buscar a última versão do Baileys, usando a versão padrão', {
      err: error,
    })
    return DEFAULT_CONNECTION_CONFIG.version
  }
}

/**
 * Cria o socket do Baileys com stores, logger e politicas de sync.
 */
export async function createSocket(logger: AppLogger) {
  const { state, saveCreds } = await getAuthState()
  const version = await resolveBaileysVersion(logger)
  initHistorySyncPolicy(state.creds)

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu('Zyra System'),
    logger: createBaileysLogger(logger),
    emitOwnEvents: true,
    fireInitQueries: false,
    syncFullHistory: false,
    // Permite sincronizar histórico apenas no primeiro login (evita travar o buffer)
    shouldSyncHistoryMessage: shouldSyncHistoryMessageOnce,
    getMessage: store.getMessage,
    cachedGroupMetadata: store.getGroupMetadata,
    msgRetryCounterCache: store.caches.msgRetryCounterCache,
    callOfferCache: store.caches.callOfferCache,
    placeholderResendCache: store.caches.placeholderResendCache,
    userDevicesCache: store.caches.userDevicesCache,
    mediaCache: store.caches.mediaCache,
  })

  store.setSelfJid(sock.user?.id ?? null)
  sock.ev.on('connection.update', (update) => {
    if (update.connection === 'open') {
      store.setSelfJid(sock.user?.id ?? null)
    }
    if (update.isNewLogin) {
      allowHistorySyncOnceForNewLogin()
    }
  })

  const lidMappingStore = (sock as SocketWithSignalRepository).signalRepository?.lidMapping
  store.bindLidMappingStore(lidMappingStore)
  store.bind(sock.ev)
  sock.ev.on('creds.update', saveCreds)

  return sock
}
