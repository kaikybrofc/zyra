import process from 'node:process'
import { config as loadDotEnv } from 'dotenv'

loadDotEnv()

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value.toLowerCase() !== 'false'
}

function readNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function readRiskLevel(value: string | undefined, fallback: 'low' | 'medium' | 'high' | 'critical'): 'low' | 'medium' | 'high' | 'critical' {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'critical') {
    return normalized
  }
  return fallback
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
  mysqlRetryIntervalMs: readNumber(process.env.WA_MYSQL_RETRY_MS, 60_000),
  connectionId: process.env.WA_CONNECTION_ID ?? 'default',
  allowOwnMessages: readBoolean(process.env.WA_ACCEPT_OWN_MESSAGES, false),
  authPersistKeysOnDisk: readBoolean(process.env.WA_AUTH_PERSIST_KEYS, false),
  antibanEnabled: readBoolean(process.env.WA_ANTIBAN_ENABLED, false),
  antibanLogging: readBoolean(process.env.WA_ANTIBAN_LOGGING, false),
  antibanStateDir: process.env.WA_ANTIBAN_STATE_DIR ?? 'data/antiban',
  antibanStateSaveIntervalMs: readNumber(process.env.WA_ANTIBAN_STATE_SAVE_MS, 300_000),
  antibanAutoPauseAt: readRiskLevel(process.env.WA_ANTIBAN_AUTO_PAUSE_AT, 'high'),
  antibanMaxPerMinute: readOptionalNumber(process.env.WA_ANTIBAN_MAX_PER_MINUTE),
  antibanMaxPerHour: readOptionalNumber(process.env.WA_ANTIBAN_MAX_PER_HOUR),
  antibanMaxPerDay: readOptionalNumber(process.env.WA_ANTIBAN_MAX_PER_DAY),
  antibanMinDelayMs: readOptionalNumber(process.env.WA_ANTIBAN_MIN_DELAY_MS),
  antibanMaxDelayMs: readOptionalNumber(process.env.WA_ANTIBAN_MAX_DELAY_MS),
  antibanNewChatDelayMs: readOptionalNumber(process.env.WA_ANTIBAN_NEW_CHAT_DELAY_MS),
  antibanWarmUpDays: readOptionalNumber(process.env.WA_ANTIBAN_WARMUP_DAYS),
  antibanWarmUpDay1Limit: readOptionalNumber(process.env.WA_ANTIBAN_WARMUP_DAY1_LIMIT),
  antibanWarmUpGrowthFactor: readOptionalNumber(process.env.WA_ANTIBAN_WARMUP_GROWTH_FACTOR),
  antibanInactivityThresholdHours: readOptionalNumber(process.env.WA_ANTIBAN_INACTIVITY_THRESHOLD_HOURS),
}
