import process from 'node:process'
import { config as loadDotEnv } from 'dotenv'

loadDotEnv()

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value.toLowerCase() !== 'false'
}

/**
 * Configuracoes da aplicacao derivadas das variaveis de ambiente.
 */
export const config = {
  authDir: process.env.WA_AUTH_DIR ?? 'data/auth',
  printQRInTerminal: readBoolean(process.env.WA_PRINT_QR, true),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  redisUrl: process.env.WA_REDIS_URL,
  redisPrefix: process.env.WA_REDIS_PREFIX ?? 'zyra:conexao',
  mysqlUrl: process.env.MYSQL_URL ?? process.env.WA_DB_URL,
  connectionId: process.env.WA_CONNECTION_ID ?? 'default',
  allowOwnMessages: readBoolean(process.env.WA_ACCEPT_OWN_MESSAGES, false),
}
