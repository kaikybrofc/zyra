import { mkdirSync } from 'node:fs'
import path from 'node:path'
import winston from 'winston'
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
  const logDir = path.resolve(process.cwd(), 'logs')
  mkdirSync(logDir, { recursive: true })
  const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf((info) => {
      const { timestamp, level, message, ...rest } = info
      const meta = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''
      return `${timestamp ?? ''} [${level}] ${message ?? ''}${meta}`
    })
  )
  const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  )
  const transportDefinitions = [
    {
      type: 'console' as const,
      options: {
        level: config.logLevel,
        format: consoleFormat,
        handleExceptions: true,
        handleRejections: true,
      },
    },
    {
      type: 'dailyRotateFile' as const,
      options: {
        filename: path.join(logDir, 'aplicacao-%DATE%.log'),
        level: config.logLevel,
        format: fileFormat,
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '14d',
      },
    },
    {
      type: 'dailyRotateFile' as const,
      options: {
        filename: path.join(logDir, 'erro-%DATE%.log'),
        level: 'error',
        format: fileFormat,
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '30d',
      },
    },
    {
      type: 'dailyRotateFile' as const,
      options: {
        filename: path.join(logDir, 'aviso-%DATE%.log'),
        level: 'warn',
        format: fileFormat,
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '30d',
      },
    },
  ]
  const logger = criarInstanciaLogger({ level: config.logLevel, transportDefinitions })
  return ensureTrace(logger)
}
