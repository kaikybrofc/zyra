import type { proto, AuthenticationCreds } from '@whiskeysockets/baileys'

let allowHistorySyncOnce = false

export const initHistorySyncPolicy = (creds: AuthenticationCreds) => {
  if (creds.accountSyncCounter === 0) {
    allowHistorySyncOnce = true
  }
}

export const allowHistorySyncOnceForNewLogin = () => {
  allowHistorySyncOnce = true
}

export const shouldSyncHistoryMessageOnce = (_msg: proto.Message.IHistorySyncNotification) => {
  void _msg
  if (allowHistorySyncOnce) {
    allowHistorySyncOnce = false
    return true
  }
  return false
}
