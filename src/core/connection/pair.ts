import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RowDataPacket } from 'mysql2/promise'
import { DisconnectReason } from 'baileys'
import { Boom } from '@hapi/boom'
import { loadEnv } from '../../bootstrap/env.js'
import { config } from '../../config/index.js'
import { initMysqlSchema } from '../db/init.js'
import { getMysqlPool } from '../db/mysql.js'
import { closeRedisClient } from '../redis/client.js'
import { createSocket, flushSocketCredsNow, type SocketWithCredsFlush, unregisterShutdownTarget } from './socket.js'
import { createLogger, type AppLogger } from '../../observability/logger.js'
import { renderQrInTerminal } from '../../events/qr-terminal.js'

const PAIR_TIMEOUT_MS = Math.max(60_000, Number(process.env.WA_PAIR_TIMEOUT_MS ?? 10 * 60_000))
const PAIR_VALIDATE_TIMEOUT_MS = Math.max(30_000, Number(process.env.WA_PAIR_VALIDATE_TIMEOUT_MS ?? 120_000))
const PAIR_USAGE = 'uso: npm run session:pair -- --connection <id>'
const PM2_APP_NAME = process.env.WA_PM2_APP_NAME?.trim() || 'zyra'
const execFileAsync = promisify(execFile)
const VALID_MYSQL_PROTOCOLS = new Set(['mysql:', 'mariadb:'])
const EXPECTED_POST_LOGIN_CLOSE_CODES = new Set<number>([DisconnectReason.restartRequired, 408, 428, 440])

type ConnectionUpdate = {
  connection?: string
  qr?: string
  isNewLogin?: boolean
  lastDisconnect?: { error?: unknown }
}

type WaitPhase = 'pairing' | 'validacao'

type ConnectionWaitResult = {
  outcome: 'open' | 'close'
  sawQr: boolean
  sawNewLogin: boolean
  statusCode: number | null
}

/**
 * Extrai uma mensagem amigável de erro para logs e saída de CLI.
 *
 * @param error Erro em formato desconhecido.
 * @returns Mensagem textual representando o erro.
 */
function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/**
 * Formata o sufixo com status de desconexão para compor mensagens de erro.
 *
 * @param statusCode Código de status extraído do fechamento de conexão.
 * @returns String vazia quando ausente ou sufixo no formato ` (status XXX)`.
 */
function formatStatusCodeSuffix(statusCode: number | null): string {
  return statusCode ? ` (status ${statusCode})` : ''
}

/**
 * Lê `--connection` dos argumentos da CLI.
 *
 * Suporta os formatos `--connection <id>` e `--connection=<id>`.
 *
 * @param argv Argumentos já normalizados (ex: `process.argv.slice(2)`).
 * @returns Connection id informado ou `null` quando ausente.
 */
function parseConnectionId(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index++) {
    const current = argv[index]
    if (current === '--connection') {
      return argv[index + 1]?.trim() || null
    }
    if (current?.startsWith('--connection=')) {
      return current.slice('--connection='.length).trim() || null
    }
  }
  return null
}

/**
 * Valida e normaliza um `connection_id` recebido por CLI.
 *
 * @param connectionId Valor bruto informado pelo usuário.
 * @returns Connection id válido e com trim aplicado.
 * @throws Error Quando ausente/vazio ou contendo caracteres de controle.
 */
function validateConnectionId(connectionId: string | null): string {
  const trimmed = connectionId?.trim()
  if (!trimmed) {
    throw new Error(`informe a conexão com --connection <id>\n${PAIR_USAGE}`)
  }
  const hasControlCharacter = [...trimmed].some((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })
  if (hasControlCharacter) {
    throw new Error(`connection_id inválido: caracteres de controle não são permitidos (${trimmed})`)
  }
  return trimmed
}

/**
 * Garante que `MYSQL_URL` está presente e utilizável no fluxo de pairing.
 *
 * @param mysqlUrl URL de conexão do MySQL/MariaDB.
 * @throws Error Quando ausente, inválida, com protocolo incorreto ou sem nome de banco.
 */
function validateMysqlUrlForPairing(mysqlUrl: string | null | undefined): void {
  if (!mysqlUrl) {
    throw new Error('MYSQL_URL é obrigatório para pairing via terminal com descoberta posterior')
  }

  let parsed: URL
  try {
    parsed = new URL(mysqlUrl)
  } catch {
    throw new Error(`MYSQL_URL não é uma URL válida (valor atual: "${mysqlUrl}")`)
  }

  if (!VALID_MYSQL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`MYSQL_URL deve utilizar o protocolo mysql: ou mariadb: (valor atual: "${mysqlUrl}")`)
  }

  const dbName = parsed.pathname.replace(/^\//, '').trim()
  if (!dbName) {
    throw new Error('MYSQL_URL precisa apontar para um banco de dados (ex: /zyra)')
  }
}

/**
 * Executa as validações obrigatórias antes do pareamento.
 *
 * @param connectionId Identificador solicitado pela CLI.
 * @returns Connection id validado.
 * @throws Error Quando qualquer pré-requisito não é atendido.
 */
function validatePairingPrerequisites(connectionId: string | null): string {
  const validatedConnectionId = validateConnectionId(connectionId)
  validateMysqlUrlForPairing(config.mysqlUrl)
  return validatedConnectionId
}

/**
 * Extrai o código de status de desconexão de um `connection.update`.
 *
 * Inclui fallback por regex em mensagens de erro quando `output.statusCode`
 * não está disponível.
 *
 * @param update Payload parcial de atualização de conexão.
 * @returns Status code mapeado ou `null`.
 */
function extractDisconnectStatusCode(update: { lastDisconnect?: { error?: unknown } }): number | null {
  const error = update.lastDisconnect?.error as (Boom & { output?: { statusCode?: number } }) | (Error & { output?: { statusCode?: number } }) | undefined

  const explicitStatus = error?.output?.statusCode
  if (typeof explicitStatus === 'number') return explicitStatus

  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/\b515\b/.test(message)) return DisconnectReason.restartRequired
  if (/\b401\b/.test(message)) return DisconnectReason.loggedOut

  return null
}

/**
 * Indica se o fechamento pós-login pode ser tratado como esperado no pairing.
 *
 * @param statusCode Código de fechamento extraído da conexão.
 * @returns `true` para códigos compatíveis com troca/refresh de sessão.
 */
function isExpectedPostLoginClose(statusCode: number | null): boolean {
  return statusCode === null || EXPECTED_POST_LOGIN_CLOSE_CODES.has(statusCode)
}

/**
 * Normaliza connection ids removendo vazios e duplicados, preservando ordem.
 *
 * @param values Lista de valores brutos.
 * @returns Lista única de ids.
 */
function normalizeConnectionIds(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

/**
 * Carrega `connection_id` da tabela de credenciais para composição do boot.
 *
 * @returns Lista normalizada de conexões existentes no MySQL.
 */
async function loadConnectionIdsFromMysql(): Promise<string[]> {
  const pool = getMysqlPool()
  if (!pool) return []
  type ConnectionRow = RowDataPacket & { connection_id: string }
  const [rows] = await pool.execute<ConnectionRow[]>(`SELECT connection_id FROM auth_creds ORDER BY updated_at ASC, connection_id ASC`)
  return normalizeConnectionIds(rows.map((row) => row.connection_id))
}

/**
 * Reinicia a aplicação no PM2 com `WA_CONNECTION_IDS` atualizado após pairing.
 *
 * Estratégia:
 * 1) Tenta ler lista atual via `pm2 jlist`
 * 2) Fallback para IDs do MySQL quando variável não existe
 * 3) Mescla com a conexão recém-pareada e reinicia com `--update-env`
 *
 * @param connectionId Conexão recém-validada.
 * @param logger Logger para rastreabilidade do fluxo.
 */
async function restartPm2WithConnectionList(connectionId: string, logger: AppLogger): Promise<void> {
  let stdout = ''
  try {
    const result = await execFileAsync('pm2', ['jlist'], { timeout: 10_000 })
    stdout = result.stdout
  } catch (error) {
    logger.info('pairing: pm2 indisponivel, reinicio automatico ignorado', {
      connectionId,
      appName: PM2_APP_NAME,
      err: error,
    })
    return
  }

  type Pm2Entry = {
    name?: string
    pm2_env?: {
      status?: string
      WA_CONNECTION_IDS?: string
      env?: {
        WA_CONNECTION_IDS?: string
      }
    }
  }

  let entries: Pm2Entry[] = []
  try {
    entries = JSON.parse(stdout) as Pm2Entry[]
  } catch (error) {
    logger.warn('pairing: falha ao ler lista de processos do pm2', {
      connectionId,
      appName: PM2_APP_NAME,
      err: error,
    })
    return
  }

  const app = entries.find((entry) => entry.name === PM2_APP_NAME)
  const appStatus = app?.pm2_env?.status ?? 'unknown'
  if (!app || appStatus !== 'online') {
    logger.info('pairing: app do pm2 nao esta online, reinicio automatico ignorado', {
      connectionId,
      appName: PM2_APP_NAME,
      appStatus,
    })
    return
  }

  const currentCsv = app.pm2_env?.env?.WA_CONNECTION_IDS ?? app.pm2_env?.WA_CONNECTION_IDS ?? ''
  const fromPm2 = currentCsv ? currentCsv.split(',') : []

  let fromMysql: string[] = []
  if (!fromPm2.length) {
    try {
      fromMysql = await loadConnectionIdsFromMysql()
    } catch (error) {
      logger.warn('pairing: falha ao carregar conexoes do mysql para reinicio no pm2', {
        connectionId,
        appName: PM2_APP_NAME,
        err: error,
      })
    }
  }

  const merged = normalizeConnectionIds([...fromPm2, ...fromMysql, connectionId])
  const updatedCsv = merged.join(',')
  const source = fromPm2.length ? 'pm2-env' : fromMysql.length ? 'mysql-fallback' : 'current-connection-only'

  try {
    await execFileAsync('pm2', ['restart', PM2_APP_NAME, '--update-env'], {
      timeout: 30_000,
      env: {
        ...process.env,
        WA_CONNECTION_IDS: updatedCsv,
      },
    })
  } catch (error) {
    logger.warn('pairing: falha ao reiniciar app do pm2 apos validacao', {
      connectionId,
      appName: PM2_APP_NAME,
      source,
      connectionIds: merged,
      err: error,
    })
    return
  }

  logger.info('pairing: pm2 reiniciado com lista atualizada de conexoes', {
    connectionId,
    appName: PM2_APP_NAME,
    source,
    total: merged.length,
    connectionIds: merged,
  })
}

/**
 * Fecha recursos de infraestrutura usados pelo script de pairing.
 *
 * @returns Promise resolvida após tentativa de fechar Redis e pool MySQL.
 */
async function closeResources(): Promise<void> {
  await closeRedisClient().catch(() => undefined)
  const pool = getMysqlPool()
  if (pool) {
    await pool.end().catch(() => undefined)
  }
}

/**
 * Aguarda a abertura ou o fechamento da conexão durante o fluxo de pareamento,
 * observando QR, novo login e códigos de encerramento relevantes.
 */
async function waitForConnectionOutcome(
  sock: SocketWithCredsFlush,
  options: {
    phase: WaitPhase
    connectionId: string
    timeoutMs: number
    onQr?: (qr: string) => void
    onNewLogin?: () => void
    rejectOnQr?: boolean
    shouldIgnoreClose?: (result: ConnectionWaitResult) => boolean
  }
): Promise<ConnectionWaitResult> {
  const eventBus = sock.ev as {
    on: (event: 'connection.update', listener: (update: ConnectionUpdate) => void) => unknown
    off?: (event: 'connection.update', listener: (update: ConnectionUpdate) => void) => unknown
    removeListener?: (event: 'connection.update', listener: (update: ConnectionUpdate) => void) => unknown
  }

  return await new Promise<ConnectionWaitResult>((resolve, reject) => {
    let settled = false
    let sawQr = false
    let sawNewLogin = false

    const cleanup = () => {
      clearTimeout(timeoutId)
      eventBus.off?.('connection.update', onConnectionUpdate)
      eventBus.removeListener?.('connection.update', onConnectionUpdate)
    }

    const settleResolve = (result: ConnectionWaitResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const settleReject = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const timeoutId = setTimeout(() => {
      settleReject(new Error(`timeout no ${options.phase} da conexao ${options.connectionId}`))
    }, options.timeoutMs)

    const onConnectionUpdate = (update: ConnectionUpdate) => {
      if (update.qr) {
        sawQr = true
        options.onQr?.(update.qr)
        if (options.rejectOnQr) {
          settleReject(new Error(`validacao falhou: QR reapareceu para a conexao ${options.connectionId} (sessao nao estabilizou)`))
          return
        }
      }

      if (update.isNewLogin) {
        sawNewLogin = true
        options.onNewLogin?.()
      }

      if (update.connection === 'open') {
        settleResolve({
          outcome: 'open',
          sawQr,
          sawNewLogin,
          statusCode: null,
        })
        return
      }

      if (update.connection === 'close') {
        const result: ConnectionWaitResult = {
          outcome: 'close',
          sawQr,
          sawNewLogin,
          statusCode: extractDisconnectStatusCode(update),
        }
        if (options.shouldIgnoreClose?.(result)) return
        settleResolve(result)
      }
    }

    eventBus.on('connection.update', onConnectionUpdate)
  })
}

/**
 * Valida a sessão recém-pareada abrindo uma nova instância controlada do socket.
 *
 * @param connectionId Conexão a ser validada.
 * @param logger Logger para telemetria de validação.
 * @throws Error Quando a sessão não estabiliza sem QR.
 */
async function validateSessionBoot(connectionId: string, logger: AppLogger): Promise<void> {
  logger.info('pairing: iniciando validacao pos-pareamento (reconexao controlada)', { connectionId })
  const validationSock = (await createSocket(connectionId, logger)) as SocketWithCredsFlush

  try {
    const result = await waitForConnectionOutcome(validationSock, {
      phase: 'validacao',
      connectionId,
      timeoutMs: PAIR_VALIDATE_TIMEOUT_MS,
      rejectOnQr: true,
    })

    if (result.outcome === 'open') {
      logger.info('pairing: validacao concluida, conexao abriu sem QR', { connectionId })
      return
    }

    logger.warn('pairing: validacao encerrou antes de abrir', {
      connectionId,
      statusCode: result.statusCode,
      sawQr: result.sawQr,
      sawNewLogin: result.sawNewLogin,
    })
    throw new Error(`validacao falhou: conexao ${connectionId} encerrou antes de abrir${formatStatusCodeSuffix(result.statusCode)}`)
  } finally {
    await shutdownPairSocket(connectionId, validationSock, 'pairing_validation_finalize', logger)
  }
}

/**
 * Executa teardown seguro de um socket usado no fluxo de pairing.
 *
 * @param connectionId Identificador da conexão.
 * @param sock Socket a ser encerrado.
 * @param reason Motivo textual de encerramento/persistência.
 * @param logger Logger para rastreamento de falhas não críticas.
 */
async function shutdownPairSocket(connectionId: string, sock: SocketWithCredsFlush, reason: string, logger: AppLogger): Promise<void> {
  try {
    await flushSocketCredsNow(sock, reason)
  } catch (error) {
    logger.warn('pairing: falha ao persistir credenciais durante teardown do socket', {
      connectionId,
      reason,
      err: error,
    })
  }

  try {
    ;(sock.ev as { removeAllListeners?: (...args: unknown[]) => unknown }).removeAllListeners?.()
  } catch (error) {
    logger.debug('pairing: falha ao remover listeners durante teardown do socket', {
      connectionId,
      reason,
      err: error,
    })
  }

  try {
    await sock.end(undefined)
  } catch (error) {
    logger.debug('pairing: falha ao encerrar socket durante teardown', {
      connectionId,
      reason,
      err: error,
    })
  }

  unregisterShutdownTarget(connectionId, sock)
}

/**
 * Executa o pareamento via terminal para uma conexão específica,
 * valida a sessão criada e tenta reiniciar o processo principal no PM2.
 */
async function main(): Promise<void> {
  loadEnv()
  const logger = createLogger()
  const connectionId = validatePairingPrerequisites(parseConnectionId(process.argv.slice(2)))

  await initMysqlSchema(logger)

  let pairingSock: SocketWithCredsFlush | null = null
  try {
    pairingSock = (await createSocket(connectionId, logger)) as SocketWithCredsFlush

    const result = await waitForConnectionOutcome(pairingSock, {
      phase: 'pairing',
      connectionId,
      timeoutMs: PAIR_TIMEOUT_MS,
      onQr: (qr) => {
        renderQrInTerminal(logger, qr, connectionId)
      },
      onNewLogin: () => {
        logger.info('novo login detectado, aguardando estabilizacao da conexao', { connectionId })
      },
      shouldIgnoreClose: ({ statusCode, sawNewLogin }) => statusCode === DisconnectReason.restartRequired && !sawNewLogin,
    })

    if (result.outcome === 'open') {
      await flushSocketCredsNow(pairingSock, 'pairing_complete')
      logger.info('pairing concluído com sucesso', { connectionId })
    } else {
      logger.warn('pairing: conexao encerrada durante fluxo', {
        connectionId,
        statusCode: result.statusCode,
        pairingConfigured: result.sawNewLogin,
        expectedAfterNewLogin: result.sawNewLogin && isExpectedPostLoginClose(result.statusCode),
      })

      if (result.sawNewLogin && isExpectedPostLoginClose(result.statusCode)) {
        const flushReason = result.statusCode === DisconnectReason.restartRequired ? 'pairing_restart_required' : 'pairing_post_login_close'
        await flushSocketCredsNow(pairingSock, flushReason)

        if (result.statusCode === null) {
          logger.warn('pairing: encerramento pos-login sem status explicito, seguindo por compatibilidade', {
            connectionId,
          })
        }

        logger.info('pairing: restart esperado apos novo login; credenciais persistidas com sucesso', {
          connectionId,
          statusCode: result.statusCode,
          nextAction: 'inicie/reinicie o processo principal para conectar com a sessao salva',
        })
      } else {
        logger.error('pairing: falha real durante o fechamento da conexao', {
          connectionId,
          statusCode: result.statusCode,
          pairingConfigured: result.sawNewLogin,
          recommendation: result.statusCode === DisconnectReason.loggedOut ? 'sessao invalidada pelo WhatsApp; execute novo pareamento' : 'verifique conectividade/rede e tente novamente',
        })
        throw new Error(`pairing encerrado antes de abrir a conexão ${connectionId}${formatStatusCodeSuffix(result.statusCode)}`)
      }
    }
  } finally {
    if (pairingSock) {
      await shutdownPairSocket(connectionId, pairingSock, 'pairing_finalize', logger)
    }
  }

  await validateSessionBoot(connectionId, logger)
  logger.info('pairing: sessao validada com sucesso no WhatsApp e no socket local', {
    connectionId,
  })
  await restartPm2WithConnectionList(connectionId, logger)
  await new Promise<void>((resolve) => setTimeout(resolve, 300))
  await closeResources()
}

main().catch(async (error) => {
  const logger = createLogger()
  logger.error('falha no pairing via terminal', {
    err: error,
    message: formatErrorMessage(error),
    usage: PAIR_USAGE,
  })
  await closeResources()
  process.exitCode = 1
})
