import process from 'node:process'

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

function readCanonicalJidMode(value: string | undefined, fallback: 'pn' | 'lid'): 'pn' | 'lid' {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'pn' || normalized === 'lid') {
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
  get authDir() {
    return process.env.WA_AUTH_DIR ?? 'data/auth'
  },
  /** Prefixo para identificar comandos (WA_COMMAND_PREFIX). */
  get commandPrefix() {
    return (process.env.WA_COMMAND_PREFIX ?? '!').trim() || '!'
  },
  /** Se deve imprimir o QR Code no terminal durante o emparelhamento (WA_PRINT_QR). */
  get printQRInTerminal() {
    return readBoolean(process.env.WA_PRINT_QR, true)
  },
  /** Nível de verbosidade dos logs da aplicação (LOG_LEVEL). */
  get logLevel() {
    return process.env.LOG_LEVEL ?? 'info'
  },
  /** URL de conexão com o Redis (WA_REDIS_URL). */
  get redisUrl() {
    return process.env.WA_REDIS_URL
  },
  /** Prefixo das chaves armazenadas no Redis (WA_REDIS_PREFIX). */
  get redisPrefix() {
    return process.env.WA_REDIS_PREFIX ?? 'zyra:conexao'
  },
  /** URL de conexão com o MySQL (MYSQL_URL ou WA_DB_URL). */
  get mysqlUrl() {
    return process.env.MYSQL_URL ?? process.env.WA_DB_URL
  },
  /** Intervalo em ms para tentar reconexão com o MySQL em caso de falha (WA_MYSQL_RETRY_MS). */
  get mysqlRetryIntervalMs() {
    return readNumber(process.env.WA_MYSQL_RETRY_MS, 60_000)
  },
  /** Identificador único da conexão do bot (WA_CONNECTION_ID). */
  get connectionId() {
    return process.env.WA_CONNECTION_ID ?? 'default'
  },
  /** Se o bot deve processar as próprias mensagens enviadas (WA_ACCEPT_OWN_MESSAGES). */
  get allowOwnMessages() {
    return readBoolean(process.env.WA_ACCEPT_OWN_MESSAGES, false)
  },
  /** Se deve ignorar mensagens de status@broadcast para reduzir ruído de sessão/decriptação (WA_IGNORE_STATUS_BROADCAST). */
  get ignoreStatusBroadcast() {
    return readBoolean(process.env.WA_IGNORE_STATUS_BROADCAST, true)
  },
  /** Se deve persistir as chaves de autenticação no disco mesmo usando Redis/MySQL (WA_AUTH_PERSIST_KEYS). */
  get authPersistKeysOnDisk() {
    return readBoolean(process.env.WA_AUTH_PERSIST_KEYS, false)
  },
  /** Se o módulo Anti-Ban está ativado (WA_ANTIBAN_ENABLED). */
  get antibanEnabled() {
    return readBoolean(process.env.WA_ANTIBAN_ENABLED, false)
  },
  /** Se deve logar detalhadamente as ações do Anti-Ban (WA_ANTIBAN_LOGGING). */
  get antibanLogging() {
    return readBoolean(process.env.WA_ANTIBAN_LOGGING, false)
  },
  /** Diretório para salvar o estado persistente do Anti-Ban (WA_ANTIBAN_STATE_DIR). */
  get antibanStateDir() {
    return process.env.WA_ANTIBAN_STATE_DIR ?? 'data/antiban'
  },
  /** Intervalo para salvar automaticamente o estado do Anti-Ban (WA_ANTIBAN_STATE_SAVE_MS). */
  get antibanStateSaveIntervalMs() {
    return readNumber(process.env.WA_ANTIBAN_STATE_SAVE_MS, 300_000)
  },
  /** Nível de risco no qual o Anti-Ban pausa automaticamente o bot (WA_ANTIBAN_AUTO_PAUSE_AT). */
  get antibanAutoPauseAt() {
    return readRiskLevel(process.env.WA_ANTIBAN_AUTO_PAUSE_AT, 'high')
  },
  /** Máximo de mensagens por minuto permitidas pelo Anti-Ban (WA_ANTIBAN_MAX_PER_MINUTE). */
  get antibanMaxPerMinute() {
    return readOptionalNumber(process.env.WA_ANTIBAN_MAX_PER_MINUTE)
  },
  /** Máximo de mensagens por hora permitidas pelo Anti-Ban (WA_ANTIBAN_MAX_PER_HOUR). */
  get antibanMaxPerHour() {
    return readOptionalNumber(process.env.WA_ANTIBAN_MAX_PER_HOUR)
  },
  /** Máximo de mensagens por dia permitidas pelo Anti-Ban (WA_ANTIBAN_MAX_PER_DAY). */
  get antibanMaxPerDay() {
    return readOptionalNumber(process.env.WA_ANTIBAN_MAX_PER_DAY)
  },
  /** Atraso mínimo entre mensagens em ms (WA_ANTIBAN_MIN_DELAY_MS). */
  get antibanMinDelayMs() {
    return readOptionalNumber(process.env.WA_ANTIBAN_MIN_DELAY_MS)
  },
  /** Atraso máximo entre mensagens em ms (WA_ANTIBAN_MAX_DELAY_MS). */
  get antibanMaxDelayMs() {
    return readOptionalNumber(process.env.WA_ANTIBAN_MAX_DELAY_MS)
  },
  /** Atraso adicional ao iniciar chat com novo contato (WA_ANTIBAN_NEW_CHAT_DELAY_MS). */
  get antibanNewChatDelayMs() {
    return readOptionalNumber(process.env.WA_ANTIBAN_NEW_CHAT_DELAY_MS)
  },
  /** Período de aquecimento da conta em dias (WA_ANTIBAN_WARMUP_DAYS). */
  get antibanWarmUpDays() {
    return readOptionalNumber(process.env.WA_ANTIBAN_WARMUP_DAYS)
  },
  /** Limite de mensagens no primeiro dia de aquecimento (WA_ANTIBAN_WARMUP_DAY1_LIMIT). */
  get antibanWarmUpDay1Limit() {
    return readOptionalNumber(process.env.WA_ANTIBAN_WARMUP_DAY1_LIMIT)
  },
  /** Fator de crescimento diário do limite durante o aquecimento (WA_ANTIBAN_WARMUP_GROWTH_FACTOR). */
  get antibanWarmUpGrowthFactor() {
    return readOptionalNumber(process.env.WA_ANTIBAN_WARMUP_GROWTH_FACTOR)
  },
  /** Horas de inatividade para considerar que o aquecimento foi interrompido (WA_ANTIBAN_INACTIVITY_THRESHOLD_HOURS). */
  get antibanInactivityThresholdHours() {
    return readOptionalNumber(process.env.WA_ANTIBAN_INACTIVITY_THRESHOLD_HOURS)
  },
  /** Habilita mitigação LID/PN (JID canonicalizer) no antiban (WA_ANTIBAN_JID_CANONICALIZER_ENABLED). */
  get antibanJidCanonicalizerEnabled() {
    return readBoolean(process.env.WA_ANTIBAN_JID_CANONICALIZER_ENABLED, true)
  },
  /** Forma canônica usada na mitigação LID/PN: pn ou lid (WA_ANTIBAN_LID_CANONICAL). */
  get antibanLidCanonical() {
    return readCanonicalJidMode(process.env.WA_ANTIBAN_LID_CANONICAL, 'pn')
  },
  /** Quantidade máxima de mapeamentos LID↔PN em memória (WA_ANTIBAN_LID_MAX_ENTRIES). */
  get antibanLidMaxEntries() {
    return readOptionalNumber(process.env.WA_ANTIBAN_LID_MAX_ENTRIES)
  },
}
