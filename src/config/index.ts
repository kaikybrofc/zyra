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

function readConnectionControlMode(value: string | undefined, fallback: 'legacy' | 'managed' | 'hybrid'): 'legacy' | 'managed' | 'hybrid' {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === 'legacy' || normalized === 'managed' || normalized === 'hybrid') {
    return normalized
  }
  return fallback
}

type AntiBanPreset = 'conservative' | 'moderate' | 'aggressive' | 'high-volume'

function readAntiBanPreset(value: string | undefined): AntiBanPreset | undefined {
  if (!value) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'conservative' || normalized === 'moderate' || normalized === 'aggressive' || normalized === 'high-volume') {
    return normalized
  }
  return undefined
}

function hasMultipleConfiguredConnections(): boolean {
  const raw = process.env.WA_CONNECTION_IDS
  if (!raw) return false
  const ids = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return new Set(ids).size > 1
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
  /** Lista explícita de conexões a subir no processo (WA_CONNECTION_IDS em CSV). */
  get connectionIds() {
    const raw = process.env.WA_CONNECTION_IDS
    if (!raw) return null
    const seen = new Set<string>()
    const values = raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => {
        if (!value || seen.has(value)) return false
        seen.add(value)
        return true
      })
    return values.length ? values : null
  },
  /** Identificador único da conexão do bot (WA_CONNECTION_ID). */
  get connectionId() {
    return process.env.WA_CONNECTION_ID ?? 'default'
  },
  /** Modo de controle de conexões no boot (WA_CONNECTION_CONTROL_MODE). */
  get connectionControlMode() {
    return readConnectionControlMode(process.env.WA_CONNECTION_CONTROL_MODE, 'hybrid')
  },
  /** Se o bot deve processar as próprias mensagens enviadas (WA_ACCEPT_OWN_MESSAGES). */
  get allowOwnMessages() {
    return readBoolean(process.env.WA_ACCEPT_OWN_MESSAGES, false)
  },
  /** Se deve ignorar mensagens de status@broadcast para reduzir ruído de sessão/decriptação (WA_IGNORE_STATUS_BROADCAST). */
  get ignoreStatusBroadcast() {
    return readBoolean(process.env.WA_IGNORE_STATUS_BROADCAST, true)
  },
  /** Se deve permitir ao Baileys processar o sync técnico inicial necessário para mappings LID/PN (WA_HISTORY_SYNC_INITIAL_BOOTSTRAP). */
  get historySyncInitialBootstrap() {
    return readBoolean(process.env.WA_HISTORY_SYNC_INITIAL_BOOTSTRAP, true)
  },
  /** Se deve permitir ao Baileys processar o sync técnico após novo login/pareamento (WA_HISTORY_SYNC_ON_NEW_LOGIN). */
  get historySyncOnNewLogin() {
    return readBoolean(process.env.WA_HISTORY_SYNC_ON_NEW_LOGIN, true)
  },
  /** Se deve importar chats/contatos/mensagens recebidos via messaging-history.set (WA_HISTORY_IMPORT_ENABLED). */
  get historyImportEnabled() {
    return readBoolean(process.env.WA_HISTORY_IMPORT_ENABLED, false)
  },
  /** Se deve buscar e persistir snapshot de grupos assim que a conexão abre (WA_GROUP_SYNC_ON_CONNECT). */
  get groupSyncOnConnect() {
    return readBoolean(process.env.WA_GROUP_SYNC_ON_CONNECT, false)
  },
  /** Se deve persistir messages.upsert type=append, normalmente replay/histórico offline (WA_APPEND_MESSAGE_IMPORT_ENABLED). */
  get appendMessageImportEnabled() {
    return readBoolean(process.env.WA_APPEND_MESSAGE_IMPORT_ENABLED, false)
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
  /** Preset base da lib baileys-antiban (WA_ANTIBAN_PRESET). */
  get antibanPreset() {
    return readAntiBanPreset(process.env.WA_ANTIBAN_PRESET)
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
  /** Máximo de mensagens idênticas antes de bloquear (WA_ANTIBAN_MAX_IDENTICAL_MESSAGES). */
  get antibanMaxIdenticalMessages() {
    return readOptionalNumber(process.env.WA_ANTIBAN_MAX_IDENTICAL_MESSAGES)
  },
  /** Janela em ms para contagem de mensagens idênticas (WA_ANTIBAN_IDENTICAL_WINDOW_MS). */
  get antibanIdenticalMessageWindowMs() {
    return readOptionalNumber(process.env.WA_ANTIBAN_IDENTICAL_WINDOW_MS)
  },
  /** Quantidade de mensagens em burst permitidas (WA_ANTIBAN_BURST_ALLOWANCE). */
  get antibanBurstAllowance() {
    return readOptionalNumber(process.env.WA_ANTIBAN_BURST_ALLOWANCE)
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
  /** Se deve aplicar perfil de grupo com limites mais conservadores (WA_ANTIBAN_GROUP_PROFILES_ENABLED). */
  get antibanGroupProfilesEnabled() {
    return readBoolean(process.env.WA_ANTIBAN_GROUP_PROFILES_ENABLED, true)
  },
  /** Multiplicador de limites para envios em grupos (WA_ANTIBAN_GROUP_MULTIPLIER). */
  get antibanGroupMultiplier() {
    return readOptionalNumber(process.env.WA_ANTIBAN_GROUP_MULTIPLIER)
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
  /** Habilita detector de sessão surda (socket conectado sem eventos de mensagem). */
  get antibanDeafSessionEnabled() {
    return readBoolean(process.env.WA_ANTIBAN_DEAF_SESSION_ENABLED, true)
  },
  /** Timeout em ms sem atividade para considerar sessão "surda". */
  get antibanDeafSessionTimeoutMs() {
    return readNumber(process.env.WA_ANTIBAN_DEAF_SESSION_TIMEOUT_MS, 5 * 60_000)
  },
  /** Uptime mínimo em ms antes de começar a detectar sessão "surda". */
  get antibanDeafSessionMinUptimeMs() {
    return readNumber(process.env.WA_ANTIBAN_DEAF_SESSION_MIN_UPTIME_MS, 2 * 60_000)
  },
  /** Se o detector de sessão "surda" deve forçar auto-reconnect. */
  get antibanDeafSessionAutoReconnect() {
    return readBoolean(process.env.WA_ANTIBAN_DEAF_SESSION_AUTO_RECONNECT, true)
  },
  /** Habilita proteção de rate limit para operações administrativas de grupo. */
  get antibanGroupOperationGuardEnabled() {
    return readBoolean(process.env.WA_ANTIBAN_GROUP_OP_GUARD_ENABLED, true)
  },
  get antibanGroupAddMax() {
    return readOptionalNumber(process.env.WA_ANTIBAN_GROUP_ADD_MAX)
  },
  get antibanGroupAddWindowMs() {
    return readOptionalNumber(process.env.WA_ANTIBAN_GROUP_ADD_WINDOW_MS)
  },
  get antibanGroupRemoveMax() {
    return readOptionalNumber(process.env.WA_ANTIBAN_GROUP_REMOVE_MAX)
  },
  get antibanGroupRemoveWindowMs() {
    return readOptionalNumber(process.env.WA_ANTIBAN_GROUP_REMOVE_WINDOW_MS)
  },
  get antibanGroupCreateMax() {
    return readOptionalNumber(process.env.WA_ANTIBAN_GROUP_CREATE_MAX)
  },
  get antibanGroupCreateWindowMs() {
    return readOptionalNumber(process.env.WA_ANTIBAN_GROUP_CREATE_WINDOW_MS)
  },
  get antibanGroupInviteMax() {
    return readOptionalNumber(process.env.WA_ANTIBAN_GROUP_INVITE_MAX)
  },
  get antibanGroupInviteWindowMs() {
    return readOptionalNumber(process.env.WA_ANTIBAN_GROUP_INVITE_WINDOW_MS)
  },
  /** Habilita sinais de legitimidade da lib (typos, pausas de digitação e read gaps). */
  get antibanLegitimacySignalsEnabled() {
    return readBoolean(process.env.WA_ANTIBAN_LEGITIMACY_SIGNALS_ENABLED, true)
  },
  get antibanLegitimacyTyposEnabled() {
    return readBoolean(process.env.WA_ANTIBAN_LEGITIMACY_TYPOS_ENABLED, true)
  },
  get antibanLegitimacyTypoProbability() {
    return readOptionalNumber(process.env.WA_ANTIBAN_LEGITIMACY_TYPO_PROBABILITY)
  },
  get antibanLegitimacyReadGapsEnabled() {
    return readBoolean(process.env.WA_ANTIBAN_LEGITIMACY_READ_GAPS_ENABLED, true)
  },
  get antibanLegitimacyTypingPausesEnabled() {
    return readBoolean(process.env.WA_ANTIBAN_LEGITIMACY_TYPING_PAUSES_ENABLED, true)
  },
  /** Coordenação de limite compartilhado entre conexões/instâncias. */
  get antibanInstanceCoordinatorEnabled() {
    return readBoolean(process.env.WA_ANTIBAN_INSTANCE_COORDINATOR_ENABLED, hasMultipleConfiguredConnections())
  },
  get antibanInstanceCoordinatorPath() {
    return process.env.WA_ANTIBAN_INSTANCE_COORDINATOR_PATH ?? 'data/antiban/instance-pool.json'
  },
  get antibanInstancePoolMaxPerMinute() {
    return readOptionalNumber(process.env.WA_ANTIBAN_INSTANCE_POOL_MAX_PER_MINUTE)
  },
  get antibanInstancePoolMaxPerHour() {
    return readOptionalNumber(process.env.WA_ANTIBAN_INSTANCE_POOL_MAX_PER_HOUR)
  },
  /** Habilita endpoint Prometheus /metrics para estatísticas do Anti-Ban. */
  get antibanMetricsEnabled() {
    return readBoolean(process.env.WA_ANTIBAN_METRICS_ENABLED, false)
  },
  /** Host de bind do servidor de métricas. */
  get antibanMetricsHost() {
    return process.env.WA_ANTIBAN_METRICS_HOST ?? '0.0.0.0'
  },
  /** Porta do servidor de métricas. */
  get antibanMetricsPort() {
    return readNumber(process.env.WA_ANTIBAN_METRICS_PORT, 9108)
  },
  /** Path HTTP para exposição das métricas. */
  get antibanMetricsPath() {
    const value = (process.env.WA_ANTIBAN_METRICS_PATH ?? '/metrics').trim()
    if (!value) return '/metrics'
    return value.startsWith('/') ? value : `/${value}`
  },
  /** Se deve baixar automaticamente mídias recebidas para disco local (WA_MEDIA_AUTO_DOWNLOAD). */
  get mediaAutoDownload() {
    return readBoolean(process.env.WA_MEDIA_AUTO_DOWNLOAD, false)
  },
  /** Diretório base para salvar mídias baixadas localmente (WA_MEDIA_DOWNLOAD_DIR). */
  get mediaDownloadDir() {
    return process.env.WA_MEDIA_DOWNLOAD_DIR ?? 'data/media'
  },
  /** Limite máximo de armazenamento local de mídia em bytes (WA_MEDIA_MAX_BYTES). */
  get mediaMaxBytes() {
    return readNumber(process.env.WA_MEDIA_MAX_BYTES, 10 * 1024 * 1024 * 1024)
  },
  /** Quantidade de dias para retenção de mídias locais (WA_MEDIA_RETENTION_DAYS). */
  get mediaRetentionDays() {
    return readNumber(process.env.WA_MEDIA_RETENTION_DAYS, 7)
  },
  /** TTL in ms for newsletter metadata cache (WA_NEWSLETTER_METADATA_SYNC_TTL_MS). */
  get newsletterMetadataSyncTtlMs() {
    return readNumber(process.env.WA_NEWSLETTER_METADATA_SYNC_TTL_MS, 5 * 60_000)
  },
  /** TTL in ms for newsletter metadata retry after failure (WA_NEWSLETTER_METADATA_RETRY_TTL_MS). */
  get newsletterMetadataRetryTtlMs() {
    return readNumber(process.env.WA_NEWSLETTER_METADATA_RETRY_TTL_MS, 30_000)
  },
  /** Base in ms for newsletter media retry backoff (WA_NEWSLETTER_MEDIA_RETRY_BASE_MS). */
  get newsletterMediaRetryBaseMs() {
    return readNumber(process.env.WA_NEWSLETTER_MEDIA_RETRY_BASE_MS, 10_000)
  },
  /** Maximum retry attempts for newsletter media (WA_NEWSLETTER_MEDIA_RETRY_MAX_ATTEMPTS). */
  get newsletterMediaRetryMaxAttempts() {
    return readNumber(process.env.WA_NEWSLETTER_MEDIA_RETRY_MAX_ATTEMPTS, 5)
  },
  /** Maximum consecutive failures in backfill worker before shutdown (WA_BACKFILL_MAX_FAILURES). */
  get backfillMaxFailures() {
    return readNumber(process.env.WA_BACKFILL_MAX_FAILURES, 5)
  },
  /** Wait in ms between failed backfill cycles (WA_BACKFILL_FAILURE_BACKOFF_MS). */
  get backfillFailureBackoffMs() {
    return readNumber(process.env.WA_BACKFILL_FAILURE_BACKOFF_MS, 60_000)
  },
  /** Timeout in ms for a single command execution, 0 = disabled (WA_COMMAND_TIMEOUT_MS). */
  get commandTimeoutMs() {
    return readNumber(process.env.WA_COMMAND_TIMEOUT_MS, 60_000)
  },
  /** Base delay in ms for reconnect exponential backoff (WA_RECONNECT_BASE_DELAY_MS). */
  get reconnectBaseDelayMs() {
    return readNumber(process.env.WA_RECONNECT_BASE_DELAY_MS, 2_500)
  },
  /** Maximum delay cap in ms for reconnect backoff (WA_RECONNECT_MAX_DELAY_MS). */
  get reconnectMaxDelayMs() {
    return readNumber(process.env.WA_RECONNECT_MAX_DELAY_MS, 60_000)
  },
  /** Maximum reconnect attempts before giving up, 0 = unlimited (WA_RECONNECT_MAX_ATTEMPTS). */
  get reconnectMaxAttempts() {
    return readNumber(process.env.WA_RECONNECT_MAX_ATTEMPTS, 0)
  },
  /** Maximum number of messages kept in the in-memory cache, 0 = unlimited (WA_MAX_CACHED_MESSAGES). */
  get maxCachedMessages() {
    return readNumber(process.env.WA_MAX_CACHED_MESSAGES, 10_000)
  },
  /** Enables HTTP /health endpoint for liveness probes (WA_HEALTH_ENABLED). */
  get healthEnabled() {
    return readBoolean(process.env.WA_HEALTH_ENABLED, true)
  },
  /** Port for health check server (WA_HEALTH_PORT). */
  get healthPort() {
    return readNumber(process.env.WA_HEALTH_PORT, 9109)
  },
  /** Bind host for health check server (WA_HEALTH_HOST). */
  get healthHost() {
    return process.env.WA_HEALTH_HOST ?? '0.0.0.0'
  },
  /** Habilita servidor HTTP da API REST (WA_API_ENABLED). */
  get apiEnabled() {
    return readBoolean(process.env.WA_API_ENABLED, false)
  },
  /** Controla se este processo deve executar bootstrap do ConnectionManager (WA_BOOTSTRAP_CONNECTIONS_ENABLED). */
  get bootstrapConnectionsEnabled() {
    return readBoolean(process.env.WA_BOOTSTRAP_CONNECTIONS_ENABLED, true)
  },
  /** Porta do servidor HTTP da API REST (WA_API_PORT). */
  get apiPort() {
    return readNumber(process.env.WA_API_PORT, 3000)
  },
  /** Host de bind do servidor HTTP da API REST (WA_API_HOST). */
  get apiHost() {
    return process.env.WA_API_HOST ?? '0.0.0.0'
  },
  /** Chave de autenticação da API REST — se definida, exige Bearer token (WA_API_KEY). */
  get apiKey() {
    return process.env.WA_API_KEY ?? null
  },
  /** Diretório para armazenar uploads de mídia feitos via API REST (WA_API_MEDIA_DIR). */
  get apiMediaDir() {
    return process.env.WA_API_MEDIA_DIR ?? 'data/api-media'
  },
  /** Tamanho máximo de um arquivo enviado para POST /media em bytes (WA_API_MEDIA_MAX_BYTES). */
  get apiMediaMaxBytes() {
    return readNumber(process.env.WA_API_MEDIA_MAX_BYTES, 25 * 1024 * 1024)
  },
  /** Timeout em ms para requisições de webhook (WA_WEBHOOK_TIMEOUT_MS). */
  get webhookTimeoutMs() {
    return readNumber(process.env.WA_WEBHOOK_TIMEOUT_MS, 10_000)
  },
  /** Lista CSV de URLs permitidas para entrega de webhook (WA_WEBHOOK_ALLOWED_TARGETS). */
  get webhookAllowedTargets() {
    const raw = process.env.WA_WEBHOOK_ALLOWED_TARGETS ?? ''
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  },
  /** Segredo compartilhado para autenticar webhooks de entrada via HMAC SHA-256 (WA_WEBHOOK_SHARED_SECRET). */
  get webhookSharedSecret() {
    return process.env.WA_WEBHOOK_SHARED_SECRET ?? null
  },
  /** Tamanho máximo do corpo de webhook de entrada em bytes (WA_WEBHOOK_MAX_BODY_BYTES). */
  get webhookMaxBodyBytes() {
    return readNumber(process.env.WA_WEBHOOK_MAX_BODY_BYTES, 262_144)
  },
  /** Janela máxima de tolerância para timestamp do webhook (WA_WEBHOOK_TIMESTAMP_TOLERANCE_MS). */
  get webhookTimestampToleranceMs() {
    return readNumber(process.env.WA_WEBHOOK_TIMESTAMP_TOLERANCE_MS, 300_000)
  },
  /** Token opcional adicional para ações de hard delete no webhook (WA_WEBHOOK_HARD_DELETE_TOKEN). */
  get webhookHardDeleteToken() {
    return process.env.WA_WEBHOOK_HARD_DELETE_TOKEN ?? null
  },
  /** Número máximo de tentativas de entrega antes de marcar como dead_letter (WA_WEBHOOK_MAX_ATTEMPTS). */
  get webhookMaxAttempts() {
    return readNumber(process.env.WA_WEBHOOK_MAX_ATTEMPTS, 4)
  },
  /** Habilita worker legado de retry para webhook_deliveries (WA_WEBHOOK_RETRY_ENABLED). */
  get webhookRetryWorkerEnabled() {
    return readBoolean(process.env.WA_WEBHOOK_RETRY_ENABLED, true)
  },
  /** Habilita callbacks assíncronos por outbox para eventos de conexão (WA_WEBHOOK_OUTBOX_ENABLED). */
  get webhookOutboxEnabled() {
    return readBoolean(process.env.WA_WEBHOOK_OUTBOX_ENABLED, true)
  },
  /** Tamanho máximo de lote processado por ciclo do worker de outbox (WA_WEBHOOK_OUTBOX_BATCH_SIZE). */
  get webhookOutboxBatchSize() {
    return readNumber(process.env.WA_WEBHOOK_OUTBOX_BATCH_SIZE, 50)
  },
  /** Backoff base em ms para retentativas do outbox (WA_WEBHOOK_OUTBOX_RETRY_BASE_MS). */
  get webhookOutboxRetryBaseMs() {
    return readNumber(process.env.WA_WEBHOOK_OUTBOX_RETRY_BASE_MS, 5_000)
  },
  /** Backoff máximo em ms para retentativas do outbox (WA_WEBHOOK_OUTBOX_RETRY_MAX_MS). */
  get webhookOutboxRetryMaxMs() {
    return readNumber(process.env.WA_WEBHOOK_OUTBOX_RETRY_MAX_MS, 300_000)
  },
}
