import path from 'node:path'
import { FileStateAdapter, wrapSocket, type AntiBanConfig, type WarmUpState, type WrappedSocket } from 'baileys-antiban'
import { config } from '../../config/index.js'
import type { AppLogger } from '../../observability/logger.js'

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
  }
}

const buildRateLimiterConfig = () => ({
  ...(config.antibanMaxPerMinute !== undefined ? { maxPerMinute: config.antibanMaxPerMinute } : {}),
  ...(config.antibanMaxPerHour !== undefined ? { maxPerHour: config.antibanMaxPerHour } : {}),
  ...(config.antibanMaxPerDay !== undefined ? { maxPerDay: config.antibanMaxPerDay } : {}),
  ...(config.antibanMinDelayMs !== undefined ? { minDelayMs: config.antibanMinDelayMs } : {}),
  ...(config.antibanMaxDelayMs !== undefined ? { maxDelayMs: config.antibanMaxDelayMs } : {}),
  ...(config.antibanNewChatDelayMs !== undefined ? { newChatDelayMs: config.antibanNewChatDelayMs } : {}),
  ...(config.antibanMaxIdenticalMessages !== undefined ? { maxIdenticalMessages: config.antibanMaxIdenticalMessages } : {}),
  ...(config.antibanIdenticalMessageWindowMs !== undefined ? { identicalMessageWindowMs: config.antibanIdenticalMessageWindowMs } : {}),
  ...(config.antibanBurstAllowance !== undefined ? { burstAllowance: config.antibanBurstAllowance } : {}),
})

const buildWarmUpConfig = () => ({
  ...(config.antibanWarmUpDays !== undefined ? { warmUpDays: config.antibanWarmUpDays } : {}),
  ...(config.antibanWarmUpDay1Limit !== undefined ? { day1Limit: config.antibanWarmUpDay1Limit } : {}),
  ...(config.antibanWarmUpGrowthFactor !== undefined ? { growthFactor: config.antibanWarmUpGrowthFactor } : {}),
  ...(config.antibanInactivityThresholdHours !== undefined ? { inactivityThresholdHours: config.antibanInactivityThresholdHours } : {}),
})

const resolveStateAdapter = (connectionId: string): FileStateAdapter =>
  new FileStateAdapter(path.resolve(process.cwd(), config.antibanStateDir, connectionId))

/**
 * Cria a configuração do Anti-Ban baseada nas configurações globais da aplicação.
 * @param logger Logger da aplicação para reportar riscos e bloqueios.
 * @param connectionId Identificador único da conexão (ex: 'main').
 * @returns Objeto de configuração compatível com a biblioteca baileys-antiban.
 */
export function createAntiBanConfig(logger: AppLogger, connectionId: string): AntiBanConfig {
  const lidResolver = {
    canonical: config.antibanLidCanonical,
    ...(config.antibanLidMaxEntries !== undefined ? { maxEntries: config.antibanLidMaxEntries } : {}),
  } as const

  return {
    logging: config.antibanLogging,
    rateLimiter: buildRateLimiterConfig(),
    warmUp: buildWarmUpConfig(),
    lidResolver,
    jidCanonicalizer: {
      enabled: config.antibanJidCanonicalizerEnabled,
      canonicalizeOutbound: true,
      learnFromEvents: true,
      resolverConfig: lidResolver,
    },
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

/**
 * Carrega o estado de aquecimento (warm-up) do Anti-Ban do armazenamento persistente.
 * @param connectionId Identificador da conexão.
 * @param logger Logger para reportar erros de carregamento.
 * @returns O estado de warm-up ou undefined se não existir ou se o Anti-Ban estiver desativado.
 */
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
