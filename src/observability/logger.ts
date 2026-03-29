import { criarInstanciaLogger, type LoggerInstancia } from '@kaikybrofc/logger-module'
import { config } from '../config/index.js'

export type AppLogger = LoggerInstancia & {
  trace: (...args: unknown[]) => void
}

function ensureTrace(logger: LoggerInstancia): AppLogger {
  const typedLogger = logger as LoggerInstancia & {
    trace?: (...args: unknown[]) => void
  }

  if (!typedLogger.trace) {
    typedLogger.trace = (typedLogger.debug ?? typedLogger.info).bind(typedLogger)
  }

  if (typedLogger.child) {
    const originalChild = typedLogger.child.bind(typedLogger)
    typedLogger.child = ((meta?: object) =>
      ensureTrace(originalChild((meta ?? {}) as object))) as LoggerInstancia['child']
  }

  return typedLogger as AppLogger
}

export function createLogger(): AppLogger {
  const logger = criarInstanciaLogger({ level: config.logLevel })
  return ensureTrace(logger)
}
