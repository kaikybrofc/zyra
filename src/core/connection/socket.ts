import makeWASocket, {
  Browsers,
  DEFAULT_CONNECTION_CONFIG,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import type { AppLogger } from '../../observability/logger.js'
import { createBaileysLogger } from '../../observability/baileys-logger.js'
import { createBaileysStore } from '../../store/baileys-store.js'
import { getAuthState } from '../auth/state.js'

const store = createBaileysStore()

type SocketWithSignalRepository = {
  signalRepository?: {
    lidMapping?: {
      storeLIDPNMappings: (pairs: { lid: string; pn: string }[]) => Promise<void>
      getLIDForPN: (pn: string) => Promise<string | null>
      getLIDsForPNs: (pns: string[]) => Promise<{ lid: string; pn: string }[] | null>
      getPNForLID: (lid: string) => Promise<string | null>
      getPNsForLIDs: (lids: string[]) => Promise<{ lid: string; pn: string }[] | null>
    }
  }
}

async function resolveBaileysVersion(logger: AppLogger) {
  try {
    const latest = await fetchLatestBaileysVersion()
    if ('error' in latest && latest.error) {
      logger.warn('failed to fetch latest Baileys version, using default', {
        err: latest.error,
      })
      return DEFAULT_CONNECTION_CONFIG.version
    }

    if (!latest.isLatest) {
      logger.warn('Baileys version is not the latest, using fetched version', {
        version: latest.version,
      })
    }

    return latest.version
  } catch (error) {
    logger.warn('failed to fetch latest Baileys version, using default', {
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
