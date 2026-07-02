import { proto, type AuthenticationCreds } from 'baileys'

export type HistorySyncPolicy = {
  allowOnceForNewLogin: () => void
  shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification) => boolean
}

export type HistorySyncPolicyOptions = {
  allowInitialBootstrap?: boolean
  allowNewLogin?: boolean
}

const ALLOWED_HISTORY_SYNC_TYPES = new Set<proto.Message.HistorySyncType | null | undefined>([
  null,
  undefined,
  proto.Message.HistorySyncType.INITIAL_BOOTSTRAP,
  proto.Message.HistorySyncType.INITIAL_STATUS_V3,
  proto.Message.HistorySyncType.PUSH_NAME,
  proto.Message.HistorySyncType.NON_BLOCKING_DATA,
])

/**
 * Cria uma política de sincronização de histórico isolada por socket.
 * Importante quando um processo gerencia múltiplas conexões.
 */
export const createHistorySyncPolicy = (creds: AuthenticationCreds, options: HistorySyncPolicyOptions = {}): HistorySyncPolicy => {
  void creds
  let allowHistorySync = Boolean(options.allowInitialBootstrap)

  return {
    allowOnceForNewLogin: () => {
      if (!options.allowNewLogin) return
      allowHistorySync = true
    },
    shouldSyncHistoryMessage: (msg) => {
      if (!allowHistorySync) {
        return false
      }
      if (!ALLOWED_HISTORY_SYNC_TYPES.has(msg.syncType)) {
        return false
      }
      return true
    },
  }
}
