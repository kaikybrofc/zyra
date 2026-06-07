import path from 'node:path'
import {
  FileStateAdapter,
  JidCanonicalizer,
  LidResolver,
  wrapSocket,
  type AntiBanConfig,
  type GroupOperation,
  type GroupOperationGuardConfig,
  type HealthStatus,
  type LegitimacySignalInjectorConfig,
  type TimelockState,
  type WarmUpState,
  type WrappedSocket,
  type WrapSocketOptions,
} from 'baileys-antiban'
import { config } from '../../config/index.js'
import type { AppLogger } from '../../observability/logger.js'
import { assertValidConnectionId } from './connection-id.js'

/**
 * Extensão do socket para incluir métodos do Anti-Ban.
 */
type SocketWithAntiBan = {
  /** Propriedades injetadas pelo wrapper do Anti-Ban. */
  antiban?: {
    /** Exporta o estado atual de aquecimento (warm-up). */
    exportWarmUpState: () => WarmUpState
    /** Obtém estatísticas internas de uso. */
    getStats: () => unknown
    /** Libera timers internos da lib ao descartar o socket. */
    destroy?: () => void
  }
}

const DEFAULT_GROUP_OPERATION_LIMITS: Record<GroupOperation, { max: number; windowMs: number }> = {
  add: { max: 3, windowMs: 10 * 60_000 },
  remove: { max: 5, windowMs: 10 * 60_000 },
  create: { max: 2, windowMs: 10 * 60_000 },
  invite: { max: 10, windowMs: 10 * 60_000 },
}

const buildRateLimiterConfig = () => ({
  ...(config.antibanMaxPerMinute !== undefined ? { maxPerMinute: config.antibanMaxPerMinute } : {}),
  ...(config.antibanMaxPerHour !== undefined ? { maxPerHour: config.antibanMaxPerHour } : {}),
  ...(config.antibanMaxPerDay !== undefined ? { maxPerDay: config.antibanMaxPerDay } : {}),
  ...(config.antibanMinDelayMs !== undefined ? { minDelayMs: config.antibanMinDelayMs } : {}),
  ...(config.antibanMaxDelayMs !== undefined ? { maxDelayMs: config.antibanMaxDelayMs } : {}),
  ...(config.antibanNewChatDelayMs !== undefined ? { newChatDelayMs: config.antibanNewChatDelayMs } : {}),
})

const buildRateLimiterRuntimeOverrides = () => ({
  ...(config.antibanMaxIdenticalMessages !== undefined ? { maxIdenticalMessages: config.antibanMaxIdenticalMessages } : {}),
  ...(config.antibanIdenticalMessageWindowMs !== undefined ? { identicalMessageWindowMs: config.antibanIdenticalMessageWindowMs } : {}),
  ...(config.antibanBurstAllowance !== undefined ? { burstAllowance: config.antibanBurstAllowance } : {}),
})

const buildWarmUpConfig = () => ({
  ...(config.antibanWarmUpDays !== undefined ? { warmupDays: config.antibanWarmUpDays } : {}),
  ...(config.antibanWarmUpDay1Limit !== undefined ? { day1Limit: config.antibanWarmUpDay1Limit } : {}),
  ...(config.antibanWarmUpGrowthFactor !== undefined ? { growthFactor: config.antibanWarmUpGrowthFactor } : {}),
  ...(config.antibanInactivityThresholdHours !== undefined ? { inactivityThresholdHours: config.antibanInactivityThresholdHours } : {}),
})

const buildGroupProfileConfig = () => ({
  groupProfiles: config.antibanGroupProfilesEnabled,
  ...(config.antibanGroupMultiplier !== undefined ? { groupMultiplier: config.antibanGroupMultiplier } : {}),
})

const buildDeafSessionConfig = (logger: AppLogger, connectionId: string) => {
  if (!config.antibanDeafSessionEnabled) return undefined
  return {
    timeoutMs: config.antibanDeafSessionTimeoutMs,
    minUptimeMs: config.antibanDeafSessionMinUptimeMs,
    autoReconnect: config.antibanDeafSessionAutoReconnect,
    onDeafSession: (info: { lastMessageAt: Date | null; silenceDurationMs: number; connectedSinceMs: number }) => {
      logger.warn('antiban detectou sessao possivelmente surda', {
        connectionId,
        lastMessageAt: info.lastMessageAt?.toISOString() ?? null,
        silenceDurationMs: info.silenceDurationMs,
        connectedSinceMs: info.connectedSinceMs,
        autoReconnect: config.antibanDeafSessionAutoReconnect,
      })
    },
  }
}

const buildGroupOperationGuardConfig = (): GroupOperationGuardConfig | false => {
  if (!config.antibanGroupOperationGuardEnabled) return false

  const limits: GroupOperationGuardConfig['limits'] = {}
  const addLimit = (operation: GroupOperation, max: number | undefined, windowMs: number | undefined) => {
    if (max === undefined && windowMs === undefined) return
    const fallback = DEFAULT_GROUP_OPERATION_LIMITS[operation]
    limits[operation] = {
      max: max ?? fallback.max,
      windowMs: windowMs ?? fallback.windowMs,
    }
  }

  addLimit('add', config.antibanGroupAddMax, config.antibanGroupAddWindowMs)
  addLimit('remove', config.antibanGroupRemoveMax, config.antibanGroupRemoveWindowMs)
  addLimit('create', config.antibanGroupCreateMax, config.antibanGroupCreateWindowMs)
  addLimit('invite', config.antibanGroupInviteMax, config.antibanGroupInviteWindowMs)

  return Object.keys(limits).length ? { limits } : {}
}

const buildLegitimacySignalsConfig = (): LegitimacySignalInjectorConfig | false => {
  if (!config.antibanLegitimacySignalsEnabled) return false
  return {
    enableTypos: config.antibanLegitimacyTyposEnabled,
    ...(config.antibanLegitimacyTypoProbability !== undefined ? { typoProbability: config.antibanLegitimacyTypoProbability } : {}),
    enableReadGaps: config.antibanLegitimacyReadGapsEnabled,
    enableTypingPauses: config.antibanLegitimacyTypingPausesEnabled,
  }
}

const buildWrapOptions = (logger: AppLogger, connectionId: string): WrapSocketOptions => ({
  deafSession: buildDeafSessionConfig(logger, connectionId),
  groupOpGuard: buildGroupOperationGuardConfig(),
  legitimacySignals: buildLegitimacySignalsConfig(),
})

export const resolveAntiBanStateDir = (connectionId: string): string => path.resolve(process.cwd(), config.antibanStateDir, assertValidConnectionId(connectionId))

export const resolveAntiBanInstanceCoordinatorPath = (): string => path.resolve(process.cwd(), config.antibanInstanceCoordinatorPath)

const resolveStateAdapter = (connectionId: string): FileStateAdapter => new FileStateAdapter(resolveAntiBanStateDir(connectionId))

const isInvalidPersistedWarmUpStateError = (error: unknown): boolean => {
  if (!(error instanceof SyntaxError)) return false
  return typeof error.message === 'string' && error.message.length > 0
}

/**
 * Cria a configuração do Anti-Ban baseada nas configurações globais da aplicação.
 * @param logger Logger da aplicação para reportar riscos e bloqueios.
 * @param connectionId Identificador único da conexão (ex: 'main').
 * @returns Objeto de configuração compatível com a biblioteca baileys-antiban.
 */
export function createAntiBanConfig(logger: AppLogger, connectionId: string): AntiBanConfig {
  return {
    ...(config.antibanPreset !== undefined ? { preset: config.antibanPreset } : {}),
    logging: config.antibanLogging,
    ...buildRateLimiterConfig(),
    ...buildRateLimiterRuntimeOverrides(),
    ...buildWarmUpConfig(),
    ...buildGroupProfileConfig(),
    ...(config.antibanAutoPauseAt !== undefined ? { autoPauseAt: config.antibanAutoPauseAt } : {}),
    ...(config.antibanInstanceCoordinatorEnabled
      ? {
          instanceCoordinator: resolveAntiBanInstanceCoordinatorPath(),
          ...(config.antibanInstancePoolMaxPerMinute !== undefined ? { instancePoolMaxPerMinute: config.antibanInstancePoolMaxPerMinute } : {}),
          ...(config.antibanInstancePoolMaxPerHour !== undefined ? { instancePoolMaxPerHour: config.antibanInstancePoolMaxPerHour } : {}),
        }
      : {}),
    onAtRisk: (status: HealthStatus) => {
      logger.error('antiban atingiu risco alto para a conexão', {
        connectionId,
        risk: status.risk,
        score: status.score,
        reasons: status.reasons,
        recommendation: status.recommendation,
      })
    },
    onRiskChange: (status: HealthStatus) => {
      logger.warn('antiban alterou o nivel de risco', {
        connectionId,
        risk: status.risk,
        score: status.score,
        reasons: status.reasons,
        recommendation: status.recommendation,
      })
    },
    onTimelockDetected: (state: TimelockState) => {
      logger.warn('antiban detectou reachout timelock', {
        connectionId,
        enforcementType: state.enforcementType ?? null,
        expiresAt: state.expiresAt?.toISOString() ?? null,
        errorCount: state.errorCount,
      })
    },
    onTimelockLifted: (state: TimelockState) => {
      logger.info('antiban liberou o reachout timelock', {
        connectionId,
        enforcementType: state.enforcementType ?? null,
        errorCount: state.errorCount,
      })
    },
  }
}

const attachAntiBanRuntimeExtensions = (sock: SocketWithAntiBan, logger: AppLogger, connectionId: string): void => {
  const antiban = sock.antiban as
    | {
        rateLimiter?: { config?: Record<string, unknown> }
        health?: { config?: Record<string, unknown> }
        timelock?: { config?: Record<string, unknown> }
        lidResolverModule?: unknown
        jidCanonicalizerModule?: unknown
      }
    | undefined

  if (!antiban) return

  const rateLimiterConfig = antiban.rateLimiter?.config
  if (rateLimiterConfig) {
    Object.assign(rateLimiterConfig, buildRateLimiterRuntimeOverrides())
  }

  const lidResolver = new LidResolver({
    canonical: config.antibanLidCanonical,
    ...(config.antibanLidMaxEntries !== undefined ? { maxEntries: config.antibanLidMaxEntries } : {}),
  })
  antiban.lidResolverModule = lidResolver

  if (config.antibanJidCanonicalizerEnabled) {
    antiban.jidCanonicalizerModule = new JidCanonicalizer({
      enabled: true,
      canonicalizeOutbound: true,
      learnFromEvents: true,
      resolver: lidResolver,
    })
  }
}

/**
 * Carrega o estado de aquecimento (warm-up) do Anti-Ban do armazenamento persistente.
 * @param connectionId Identificador da conexão.
 * @param logger Logger para reportar erros de carregamento.
 * @returns O estado de warm-up ou undefined se não existir ou se o Anti-Ban estiver desativado.
 */
export async function loadAntiBanWarmUpState(connectionId: string, logger: AppLogger): Promise<WarmUpState | undefined> {
  if (!config.antibanEnabled) return undefined
  const stateAdapter = resolveStateAdapter(connectionId)
  try {
    const state = await stateAdapter.load('warmup')
    return state ?? undefined
  } catch (error) {
    if (isInvalidPersistedWarmUpStateError(error)) {
      try {
        await stateAdapter.delete('warmup')
        logger.warn('estado de warm-up do antiban corrompido foi descartado', {
          connectionId,
          err: error,
        })
        return undefined
      } catch (deleteError) {
        logger.warn('falha ao remover estado de warm-up corrompido do antiban', {
          connectionId,
          err: deleteError,
          originalErr: error,
        })
        return undefined
      }
    }

    logger.warn('falha ao carregar estado de warm-up do antiban', {
      connectionId,
      err: error,
    })
    return undefined
  }
}

/**
 * Salva o estado atual de aquecimento (warm-up) do Anti-Ban no armazenamento persistente.
 * @param sock Socket envolvido pelo Anti-Ban.
 * @param connectionId Identificador da conexão.
 * @param logger Logger para reportar o status da operação.
 * @param reason Motivo pelo qual o estado está sendo salvo (ex: 'periodico', 'desconexao').
 */
export async function saveAntiBanWarmUpState(sock: SocketWithAntiBan, connectionId: string, logger: AppLogger, reason: string): Promise<void> {
  if (!config.antibanEnabled || !sock.antiban) return
  try {
    await resolveStateAdapter(connectionId).save('warmup', sock.antiban.exportWarmUpState())
    logger.debug('estado de warm-up do antiban salvo', { connectionId, reason })
  } catch (error) {
    logger.warn('falha ao salvar estado de warm-up do antiban', {
      connectionId,
      reason,
      err: error,
    })
  }
}

/**
 * Envolve um socket do Baileys com a camada de proteção Anti-Ban.
 * @param sock Instância do socket original.
 * @param logger Logger da aplicação.
 * @param connectionId Identificador da conexão.
 * @param warmUpState Estado de aquecimento inicial opcional.
 * @returns O socket protegido ou o original se o Anti-Ban estiver desativado.
 */
export function wrapSocketWithAntiBan<T extends Record<string, unknown>>(sock: T, logger: AppLogger, connectionId: string, warmUpState?: WarmUpState): T & Partial<WrappedSocket> {
  if (!config.antibanEnabled) return sock as T & Partial<WrappedSocket>
  const wrapped = wrapSocket(sock as unknown as Parameters<typeof wrapSocket>[0], createAntiBanConfig(logger, connectionId), warmUpState, buildWrapOptions(logger, connectionId))
  attachAntiBanRuntimeExtensions(wrapped as unknown as SocketWithAntiBan, logger, connectionId)
  logger.info('antiban ativado no socket', {
    connectionId,
    preset: config.antibanPreset ?? 'conservative',
    groupOpGuard: config.antibanGroupOperationGuardEnabled,
    legitimacySignals: config.antibanLegitimacySignalsEnabled,
    instanceCoordinator: config.antibanInstanceCoordinatorEnabled ? resolveAntiBanInstanceCoordinatorPath() : null,
  })
  return wrapped as unknown as T & Partial<WrappedSocket>
}
