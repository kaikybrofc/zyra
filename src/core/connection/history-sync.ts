import type { proto, AuthenticationCreds } from '@whiskeysockets/baileys'

/**
 * Flag interna que controla se a sincronização de histórico é permitida uma única vez.
 * Útil para evitar re-sincronizações pesadas em cada conexão.
 */
let allowHistorySyncOnce = false

/**
 * Inicializa a política de sincronização de histórico baseada nas credenciais.
 * Se for a primeira conexão da conta, permite a sincronização.
 * @param creds Credenciais de autenticação do Baileys.
 */
export const initHistorySyncPolicy = (creds: AuthenticationCreds) => {
  if (creds.accountSyncCounter === 0) {
    allowHistorySyncOnce = true
  }
}

/**
 * Libera explicitamente uma única sincronização completa após um novo login (scan de QR Code).
 */
export const allowHistorySyncOnceForNewLogin = () => {
  allowHistorySyncOnce = true
}

/**
 * Decide se uma notificação de sincronização de histórico deve ser processada.
 * Implementa uma política de "uma única vez" para economizar recursos.
 * @param _msg Mensagem de notificação de sincronização (não utilizada diretamente, mantida para tipagem).
 * @returns Retorna true se a sincronização for permitida, false caso contrário.
 */
export const shouldSyncHistoryMessageOnce = (_msg: proto.Message.IHistorySyncNotification) => {
  void _msg
  if (allowHistorySyncOnce) {
    allowHistorySyncOnce = false
    return true
  }
  return false
}
