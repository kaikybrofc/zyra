import type { proto, AuthenticationCreds } from '@whiskeysockets/baileys'

let allowHistorySyncOnce = false

/**
 * Define a politica de sync inicial baseada nas credenciais.
 */
export const initHistorySyncPolicy = (creds: AuthenticationCreds) => {
  if (creds.accountSyncCounter === 0) {
    allowHistorySyncOnce = true
  }
}

/**
 * Libera uma unica sincronizacao completa apos novo login.
 */
export const allowHistorySyncOnceForNewLogin = () => {
  allowHistorySyncOnce = true
}

/**
 * Decide se deve sincronizar historico apenas uma vez.
 */
export const shouldSyncHistoryMessageOnce = (_msg: proto.Message.IHistorySyncNotification) => {
  void _msg
  if (allowHistorySyncOnce) {
    allowHistorySyncOnce = false
    return true
  }
  return false
}
