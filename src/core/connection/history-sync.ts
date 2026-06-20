import { proto, type AuthenticationCreds } from 'baileys'

export type HistorySyncPolicy = {
  allowOnceForNewLogin: () => void
  shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification) => boolean
}

const ALLOWED_HISTORY_SYNC_TYPES = new Set<proto.Message.HistorySyncType | null | undefined>([
  proto.Message.HistorySyncType.INITIAL_BOOTSTRAP,
  proto.Message.HistorySyncType.INITIAL_STATUS_V3,
  proto.Message.HistorySyncType.RECENT,
  proto.Message.HistorySyncType.PUSH_NAME,
  proto.Message.HistorySyncType.NON_BLOCKING_DATA,
  proto.Message.HistorySyncType.ON_DEMAND,
])

/**
 * Cria uma política de sincronização de histórico isolada por socket.
 * Importante quando um processo gerencia múltiplas conexões.
 */
export const createHistorySyncPolicy = (creds: AuthenticationCreds): HistorySyncPolicy => {
  let allowHistorySyncOnce = creds.accountSyncCounter === 0

  return {
    allowOnceForNewLogin: () => {
      allowHistorySyncOnce = true
    },
    shouldSyncHistoryMessage: (msg) => {
      if (!ALLOWED_HISTORY_SYNC_TYPES.has(msg.syncType)) {
        return false
      }
      if (msg.syncType === proto.Message.HistorySyncType.RECENT && allowHistorySyncOnce) {
        allowHistorySyncOnce = false
      }
      return true
    },
  }
}
