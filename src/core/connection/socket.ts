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

export async function createSocket(logger: AppLogger) {
  const { state, saveCreds } = await getAuthState()
  const version = await resolveBaileysVersion(logger)

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu('Zyra System'),
    logger: createBaileysLogger(logger),
    emitOwnEvents: true,
    fireInitQueries: true,
    syncFullHistory: true,
    getMessage: store.getMessage,
    cachedGroupMetadata: store.getGroupMetadata,
    msgRetryCounterCache: store.caches.msgRetryCounterCache,
    callOfferCache: store.caches.callOfferCache,
    placeholderResendCache: store.caches.placeholderResendCache,
    userDevicesCache: store.caches.userDevicesCache,
    mediaCache: store.caches.mediaCache,
  })

  const lidMappingStore = (sock as SocketWithSignalRepository).signalRepository?.lidMapping
  store.bindLidMappingStore(lidMappingStore)
  store.bind(sock.ev)
  sock.ev.on('creds.update', saveCreds)

  return sock
}
