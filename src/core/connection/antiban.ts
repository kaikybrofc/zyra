import path from 'node:path'
import { FileStateAdapter, wrapSocket, type AntiBanConfig, type WarmUpState, type WrappedSocket } from 'baileys-antiban'
import { config } from '../../config/index.js'
import type { AppLogger } from '../../observability/logger.js'

type SocketWithAntiBan = {
  antiban?: {
    exportWarmUpState: () => WarmUpState
    getStats: () => unknown
  }
}

const buildRateLimiterConfig = () => ({
  ...(config.antibanMaxPerMinute !== undefined ? { maxPerMinute: config.antibanMaxPerMinute } : {}),
  ...(config.antibanMaxPerHour !== undefined ? { maxPerHour: config.antibanMaxPerHour } : {}),
  ...(config.antibanMaxPerDay !== undefined ? { maxPerDay: config.antibanMaxPerDay } : {}),
  ...(config.antibanMinDelayMs !== undefined ? { minDelayMs: config.antibanMinDelayMs } : {}),
  ...(config.antibanMaxDelayMs !== undefined ? { maxDelayMs: config.antibanMaxDelayMs } : {}),
  ...(config.antibanNewChatDelayMs !== undefined ? { newChatDelayMs: config.antibanNewChatDelayMs } : {}),
})

const buildWarmUpConfig = () => ({
  ...(config.antibanWarmUpDays !== undefined ? { warmUpDays: config.antibanWarmUpDays } : {}),
  ...(config.antibanWarmUpDay1Limit !== undefined ? { day1Limit: config.antibanWarmUpDay1Limit } : {}),
  ...(config.antibanWarmUpGrowthFactor !== undefined ? { growthFactor: config.antibanWarmUpGrowthFactor } : {}),
  ...(config.antibanInactivityThresholdHours !== undefined ? { inactivityThresholdHours: config.antibanInactivityThresholdHours } : {}),
})

const resolveStateAdapter = (connectionId: string): FileStateAdapter =>
  new FileStateAdapter(path.resolve(process.cwd(), config.antibanStateDir, connectionId))

export function createAntiBanConfig(logger: AppLogger, connectionId: string): AntiBanConfig {
  return {
    logging: config.antibanLogging,
    rateLimiter: buildRateLimiterConfig(),
    warmUp: buildWarmUpConfig(),
    health: {
      autoPauseAt: config.antibanAutoPauseAt,
      onRiskChange: (status) => {
        logger.warn('antiban alterou o nivel de risco', {
          connectionId,
          risk: status.risk,
          score: status.score,
          reasons: status.reasons,
          recommendation: status.recommendation,
        })
      },
    },
    timelock: {
      onTimelockDetected: (state) => {
        logger.warn('antiban detectou reachout timelock', {
          connectionId,
          enforcementType: state.enforcementType ?? null,
          expiresAt: state.expiresAt?.toISOString() ?? null,
          errorCount: state.errorCount,
        })
      },
      onTimelockLifted: (state) => {
        logger.info('antiban liberou o reachout timelock', {
          connectionId,
          enforcementType: state.enforcementType ?? null,
          errorCount: state.errorCount,
        })
      },
    },
  }
}

export async function loadAntiBanWarmUpState(connectionId: string, logger: AppLogger): Promise<WarmUpState | undefined> {
  if (!config.antibanEnabled) return undefined
  try {
    const state = await resolveStateAdapter(connectionId).load('warmup')
    return state ?? undefined
  } catch (error) {
    logger.warn('falha ao carregar estado de warm-up do antiban', {
      connectionId,
      err: error,
    })
    return undefined
  }
}

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

export function wrapSocketWithAntiBan<T extends Record<string, unknown>>(
  sock: T,
  logger: AppLogger,
  connectionId: string,
  warmUpState?: WarmUpState
): T & Partial<WrappedSocket> {
  if (!config.antibanEnabled) return sock as T & Partial<WrappedSocket>
  const wrapped = wrapSocket(sock as unknown as Parameters<typeof wrapSocket>[0], createAntiBanConfig(logger, connectionId), warmUpState)
  logger.info('antiban ativado no socket', { connectionId })
  return wrapped as unknown as T & Partial<WrappedSocket>
}
