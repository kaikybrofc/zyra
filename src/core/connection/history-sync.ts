import type { proto, AuthenticationCreds } from '@whiskeysockets/baileys'

export type HistorySyncPolicy = {
  allowOnceForNewLogin: () => void
  shouldSyncHistoryMessage: (msg: proto.Message.IHistorySyncNotification) => boolean
}

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
      void msg
      if (allowHistorySyncOnce) {
        allowHistorySyncOnce = false
        return true
      }
      return false
    },
  }
}
