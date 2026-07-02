import process from 'node:process'
import { loadEnv } from './bootstrap/env.js'
import { start } from './bootstrap/start.js'
import { config } from './config/index.js'

type ValidationResult = {
  errors: string[]
  warnings: string[]
}

const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
const BOOLEAN_VALUES = new Set(['true', 'false'])
const CONNECTION_CONTROL_MODES = new Set(['legacy', 'managed', 'hybrid'])
const ANTIBAN_PRESETS = new Set(['conservative', 'moderate', 'aggressive', 'high-volume'])

/**
 * Realiza validações básicas de ambiente e configuração antes da inicialização (boot).
 */
const validateEnvironment = (): ValidationResult => {
  const errors: string[] = []
  const warnings: string[] = []

  const ensureBoolean = (key: string) => {
    const raw = process.env[key]
    if (!raw) return
    const normalized = raw.trim().toLowerCase()
    if (!BOOLEAN_VALUES.has(normalized)) {
      warnings.push(`${key} deve ser "true" ou "false" (valor atual: "${raw}").`)
    }
  }

  const ensureUrl = (key: string, value: string | undefined, options: { requireDatabase?: boolean; allowedProtocols?: string[] } = {}) => {
    if (!value) return
    try {
      const url = new URL(value)
      const allowed = options.allowedProtocols ?? []
      if (allowed.length && !allowed.includes(url.protocol)) {
        errors.push(`${key} deve utilizar o protocolo ${allowed.join(' ou ')} (valor atual: "${value}").`)
      }
      if (options.requireDatabase) {
        const dbName = url.pathname.replace(/^\//, '').trim()
        if (!dbName) {
          errors.push(`${key} precisa apontar para um banco de dados (ex: /zyra).`)
        }
      }
    } catch {
      errors.push(`${key} não é uma URL válida (valor atual: "${value}").`)
    }
  }

  const ensurePositiveNumber = (key: string) => {
    const raw = process.env[key]
    if (!raw) return
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) {
      warnings.push(`${key} must be a non-negative number (current value: "${raw}").`)
    }
  }

  const ensurePort = (key: string) => {
    const raw = process.env[key]
    if (!raw) return
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      errors.push(`${key} must be a valid port (1–65535) (current value: "${raw}").`)
    }
  }

  const ensureEnum = (key: string, values: Set<string>) => {
    const raw = process.env[key]
    if (!raw) return
    const normalized = raw.trim().toLowerCase()
    if (!values.has(normalized)) {
      errors.push(`${key} inválido ("${raw}"). Valores aceitos: ${Array.from(values).join(', ')}.`)
    }
  }

  const ensureDeprecated = (oldKey: string, newKey: string) => {
    if (process.env[oldKey] !== undefined) {
      warnings.push(`${oldKey} is deprecated — use ${newKey} instead.`)
    }
  }

  if (!config.authDir.trim()) {
    errors.push('WA_AUTH_DIR não pode estar vazio.')
  }

  if (!LOG_LEVELS.has(config.logLevel)) {
    warnings.push(`LOG_LEVEL inválido ("${config.logLevel}"). Valores aceitos: ${[...LOG_LEVELS].join(', ')}.`)
  }

  ensureBoolean('WA_PRINT_QR')
  ensureBoolean('WA_ACCEPT_OWN_MESSAGES')
  ensureBoolean('WA_IGNORE_STATUS_BROADCAST')
  ensureBoolean('WA_AUTH_PERSIST_KEYS')
  ensureBoolean('WA_MEDIA_AUTO_DOWNLOAD')
  ensureBoolean('WA_ANTIBAN_ENABLED')
  ensureBoolean('WA_ANTIBAN_LOGGING')
  ensureBoolean('WA_ANTIBAN_JID_CANONICALIZER_ENABLED')
  ensureBoolean('WA_ANTIBAN_DEAF_SESSION_ENABLED')
  ensureBoolean('WA_ANTIBAN_DEAF_SESSION_AUTO_RECONNECT')
  ensureBoolean('WA_ANTIBAN_GROUP_PROFILES_ENABLED')
  ensureBoolean('WA_ANTIBAN_GROUP_OP_GUARD_ENABLED')
  ensureBoolean('WA_ANTIBAN_LEGITIMACY_SIGNALS_ENABLED')
  ensureBoolean('WA_ANTIBAN_LEGITIMACY_TYPOS_ENABLED')
  ensureBoolean('WA_ANTIBAN_LEGITIMACY_READ_GAPS_ENABLED')
  ensureBoolean('WA_ANTIBAN_LEGITIMACY_TYPING_PAUSES_ENABLED')
  ensureBoolean('WA_ANTIBAN_INSTANCE_COORDINATOR_ENABLED')
  ensureBoolean('WA_ANTIBAN_METRICS_ENABLED')
  ensureBoolean('WA_BACKFILL_ONCE')
  ensureBoolean('WA_HEALTH_ENABLED')
  ensureBoolean('WA_API_ENABLED')
  ensureBoolean('WA_BOOTSTRAP_CONNECTIONS_ENABLED')
  ensureBoolean('WA_WEBHOOK_RETRY_ENABLED')
  ensureBoolean('WA_WEBHOOK_OUTBOX_ENABLED')
  ensureBoolean('WA_SQL_EVENT_LOG_ENABLED')
  ensureBoolean('WA_SQL_MESSAGE_EVENTS_ENABLED')

  const mysqlUrl = process.env.MYSQL_URL ?? process.env.WA_DB_URL
  ensureUrl('MYSQL_URL', mysqlUrl, {
    requireDatabase: true,
    allowedProtocols: ['mysql:', 'mariadb:'],
  })
  ensureUrl('WA_REDIS_URL', process.env.WA_REDIS_URL, {
    allowedProtocols: ['redis:', 'rediss:'],
  })

  ensureDeprecated('WA_DB_URL', 'MYSQL_URL')

  ensurePort('WA_HEALTH_PORT')
  ensurePort('WA_ANTIBAN_METRICS_PORT')
  ensurePort('WA_API_PORT')

  ensurePositiveNumber('WA_SHUTDOWN_TIMEOUT_MS')
  ensurePositiveNumber('WA_CREDS_DEBOUNCE_MS')
  ensurePositiveNumber('WA_MYSQL_RETRY_MS')
  ensurePositiveNumber('WA_MEDIA_MAX_BYTES')
  ensurePositiveNumber('WA_MEDIA_RETENTION_DAYS')
  ensurePositiveNumber('WA_ANTIBAN_STATE_SAVE_MS')
  ensurePositiveNumber('WA_ANTIBAN_DEAF_SESSION_TIMEOUT_MS')
  ensurePositiveNumber('WA_ANTIBAN_DEAF_SESSION_MIN_UPTIME_MS')
  ensurePositiveNumber('WA_ANTIBAN_GROUP_MULTIPLIER')
  ensurePositiveNumber('WA_ANTIBAN_GROUP_ADD_MAX')
  ensurePositiveNumber('WA_ANTIBAN_GROUP_ADD_WINDOW_MS')
  ensurePositiveNumber('WA_ANTIBAN_GROUP_REMOVE_MAX')
  ensurePositiveNumber('WA_ANTIBAN_GROUP_REMOVE_WINDOW_MS')
  ensurePositiveNumber('WA_ANTIBAN_GROUP_CREATE_MAX')
  ensurePositiveNumber('WA_ANTIBAN_GROUP_CREATE_WINDOW_MS')
  ensurePositiveNumber('WA_ANTIBAN_GROUP_INVITE_MAX')
  ensurePositiveNumber('WA_ANTIBAN_GROUP_INVITE_WINDOW_MS')
  ensurePositiveNumber('WA_ANTIBAN_LEGITIMACY_TYPO_PROBABILITY')
  ensurePositiveNumber('WA_ANTIBAN_INSTANCE_POOL_MAX_PER_MINUTE')
  ensurePositiveNumber('WA_ANTIBAN_INSTANCE_POOL_MAX_PER_HOUR')
  ensurePositiveNumber('WA_ROUTER_MAX_PENDING_PER_QUEUE')
  ensurePositiveNumber('WA_BACKFILL_INTERVAL_MS')
  ensurePositiveNumber('WA_BACKFILL_STALLED_BACKOFF_MS')
  ensurePositiveNumber('WA_RECONNECT_BASE_DELAY_MS')
  ensurePositiveNumber('WA_RECONNECT_MAX_DELAY_MS')
  ensurePositiveNumber('WA_RECONNECT_MAX_ATTEMPTS')
  ensurePositiveNumber('WA_VERSION_CACHE_TTL_MS')
  ensurePositiveNumber('WA_API_MEDIA_MAX_BYTES')
  ensureEnum('WA_CONNECTION_CONTROL_MODE', CONNECTION_CONTROL_MODES)
  ensureEnum('WA_ANTIBAN_PRESET', ANTIBAN_PRESETS)

  if (config.connectionIds) {
    const hasInvalidConnectionIds = config.connectionIds.some((connectionId) => !connectionId.trim())
    if (hasInvalidConnectionIds) {
      errors.push('WA_CONNECTION_IDS contém valores inválidos.')
    }
  }

  if (!config.connectionIds?.length && !config.mysqlUrl && !config.connectionId.trim()) {
    errors.push('WA_CONNECTION_ID não pode estar vazio quando não houver descoberta automática de conexões.')
  }

  return { errors, warnings }
}

/**
 * Inicializa o bot com validação e tratamento de erro padrão.
 */
const bootstrap = async (): Promise<void> => {
  loadEnv()

  const { errors, warnings } = validateEnvironment()
  for (const warning of warnings) {
    console.warn(`[Aviso] ${warning}`)
  }
  if (errors.length) {
    for (const error of errors) {
      console.error(`[Erro] ${error}`)
    }
    process.exitCode = 1
    return
  }

  await start()
}

bootstrap().catch((error) => {
  console.error('Falha ao iniciar o bot:', error)
  process.exitCode = 1
})
