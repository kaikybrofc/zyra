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
 * Configurações globais da aplicação derivadas das variáveis de ambiente.
 * Centraliza o acesso a parâmetros de conexão, banco de dados, segurança e comportamento do bot.
 */
export const config = {
  /** Diretório para armazenamento local de credenciais de autenticação (WA_AUTH_DIR). */
  authDir: process.env.WA_AUTH_DIR ?? 'data/auth',
  /** Prefixo para identificar comandos (WA_COMMAND_PREFIX). */
  commandPrefix: (process.env.WA_COMMAND_PREFIX ?? '!').trim() || '!',
  /** Se deve imprimir o QR Code no terminal durante o emparelhamento (WA_PRINT_QR). */
  printQRInTerminal: readBoolean(process.env.WA_PRINT_QR, true),
  /** Nível de verbosidade dos logs da aplicação (LOG_LEVEL). */
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** URL de conexão com o Redis (WA_REDIS_URL). */
  redisUrl: process.env.WA_REDIS_URL,
  /** Prefixo das chaves armazenadas no Redis (WA_REDIS_PREFIX). */
  redisPrefix: process.env.WA_REDIS_PREFIX ?? 'zyra:conexao',
  /** URL de conexão com o MySQL (MYSQL_URL ou WA_DB_URL). */
  mysqlUrl: process.env.MYSQL_URL ?? process.env.WA_DB_URL,
  /** Intervalo em ms para tentar reconexão com o MySQL em caso de falha (WA_MYSQL_RETRY_MS). */
  mysqlRetryIntervalMs: readNumber(process.env.WA_MYSQL_RETRY_MS, 60_000),
  /** Identificador único da conexão do bot (WA_CONNECTION_ID). */
  connectionId: process.env.WA_CONNECTION_ID ?? 'default',
  /** Se o bot deve processar as próprias mensagens enviadas (WA_ACCEPT_OWN_MESSAGES). */
  allowOwnMessages: readBoolean(process.env.WA_ACCEPT_OWN_MESSAGES, false),
  /** Se deve persistir as chaves de autenticação no disco mesmo usando Redis/MySQL (WA_AUTH_PERSIST_KEYS). */
  authPersistKeysOnDisk: readBoolean(process.env.WA_AUTH_PERSIST_KEYS, false),
  /** Se o módulo Anti-Ban está ativado (WA_ANTIBAN_ENABLED). */
  antibanEnabled: readBoolean(process.env.WA_ANTIBAN_ENABLED, false),
  /** Se deve logar detalhadamente as ações do Anti-Ban (WA_ANTIBAN_LOGGING). */
  antibanLogging: readBoolean(process.env.WA_ANTIBAN_LOGGING, false),
  /** Diretório para salvar o estado persistente do Anti-Ban (WA_ANTIBAN_STATE_DIR). */
  antibanStateDir: process.env.WA_ANTIBAN_STATE_DIR ?? 'data/antiban',
  /** Intervalo para salvar automaticamente o estado do Anti-Ban (WA_ANTIBAN_STATE_SAVE_MS). */
  antibanStateSaveIntervalMs: readNumber(process.env.WA_ANTIBAN_STATE_SAVE_MS, 300_000),
  /** Nível de risco no qual o Anti-Ban pausa automaticamente o bot (WA_ANTIBAN_AUTO_PAUSE_AT). */
  antibanAutoPauseAt: readRiskLevel(process.env.WA_ANTIBAN_AUTO_PAUSE_AT, 'high'),
  /** Máximo de mensagens por minuto permitidas pelo Anti-Ban (WA_ANTIBAN_MAX_PER_MINUTE). */
  antibanMaxPerMinute: readOptionalNumber(process.env.WA_ANTIBAN_MAX_PER_MINUTE),
  /** Máximo de mensagens por hora permitidas pelo Anti-Ban (WA_ANTIBAN_MAX_PER_HOUR). */
  antibanMaxPerHour: readOptionalNumber(process.env.WA_ANTIBAN_MAX_PER_HOUR),
  /** Máximo de mensagens por dia permitidas pelo Anti-Ban (WA_ANTIBAN_MAX_PER_DAY). */
  antibanMaxPerDay: readOptionalNumber(process.env.WA_ANTIBAN_MAX_PER_DAY),
  /** Atraso mínimo entre mensagens em ms (WA_ANTIBAN_MIN_DELAY_MS). */
  antibanMinDelayMs: readOptionalNumber(process.env.WA_ANTIBAN_MIN_DELAY_MS),
  /** Atraso máximo entre mensagens em ms (WA_ANTIBAN_MAX_DELAY_MS). */
  antibanMaxDelayMs: readOptionalNumber(process.env.WA_ANTIBAN_MAX_DELAY_MS),
  /** Atraso adicional ao iniciar chat com novo contato (WA_ANTIBAN_NEW_CHAT_DELAY_MS). */
  antibanNewChatDelayMs: readOptionalNumber(process.env.WA_ANTIBAN_NEW_CHAT_DELAY_MS),
  /** Período de aquecimento da conta em dias (WA_ANTIBAN_WARMUP_DAYS). */
  antibanWarmUpDays: readOptionalNumber(process.env.WA_ANTIBAN_WARMUP_DAYS),
  /** Limite de mensagens no primeiro dia de aquecimento (WA_ANTIBAN_WARMUP_DAY1_LIMIT). */
  antibanWarmUpDay1Limit: readOptionalNumber(process.env.WA_ANTIBAN_WARMUP_DAY1_LIMIT),
  /** Fator de crescimento diário do limite durante o aquecimento (WA_ANTIBAN_WARMUP_GROWTH_FACTOR). */
  antibanWarmUpGrowthFactor: readOptionalNumber(process.env.WA_ANTIBAN_WARMUP_GROWTH_FACTOR),
  /** Horas de inatividade para considerar que o aquecimento foi interrompido (WA_ANTIBAN_INACTIVITY_THRESHOLD_HOURS). */
  antibanInactivityThresholdHours: readOptionalNumber(process.env.WA_ANTIBAN_INACTIVITY_THRESHOLD_HOURS),
}
