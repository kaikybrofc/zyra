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
      warnings.push(
        `${key} deve ser "true" ou "false" (valor atual: "${raw}").`
      )
    }
  }

  const ensureUrl = (
    key: string,
    value: string | undefined,
    options: { requireDatabase?: boolean; allowedProtocols?: string[] } = {}
  ) => {
    if (!value) return
    try {
      const url = new URL(value)
      const allowed = options.allowedProtocols ?? []
      if (allowed.length && !allowed.includes(url.protocol)) {
        errors.push(
          `${key} deve utilizar o protocolo ${allowed.join(' ou ')} (valor atual: "${value}").`
        )
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

  if (!config.authDir.trim()) {
    errors.push('WA_AUTH_DIR não pode estar vazio.')
  }

  if (!LOG_LEVELS.has(config.logLevel)) {
    warnings.push(
      `LOG_LEVEL inválido ("${config.logLevel}"). Valores aceitos: ${[
        ...LOG_LEVELS,
      ].join(', ')}.`
    )
  }

  ensureBoolean('WA_PRINT_QR')
  ensureBoolean('WA_ACCEPT_OWN_MESSAGES')

  const mysqlUrl = process.env.MYSQL_URL ?? process.env.WA_DB_URL
  ensureUrl('MYSQL_URL', mysqlUrl, {
    requireDatabase: true,
    allowedProtocols: ['mysql:', 'mariadb:'],
  })
  ensureUrl('WA_REDIS_URL', process.env.WA_REDIS_URL, {
    allowedProtocols: ['redis:', 'rediss:'],
  })

  if (!config.connectionId.trim()) {
    errors.push('WA_CONNECTION_ID não pode estar vazio.')
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