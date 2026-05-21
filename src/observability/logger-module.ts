import winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'

const LOG_LEVELS = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
} as const

export type NivelLog = keyof typeof LOG_LEVELS | string

export interface LoggerInstancia extends winston.Logger {
  fatal: winston.LeveledLogMethod
  error: winston.LeveledLogMethod
  warn: winston.LeveledLogMethod
  info: winston.LeveledLogMethod
  debug: winston.LeveledLogMethod
  trace: winston.LeveledLogMethod
  [customLevel: string]: winston.LeveledLogMethod | unknown
}

export interface OpcoesLogger {
  level?: NivelLog
  defaultMeta?: Record<string, unknown>
  transports?: winston.transport[]
  transportDefinitions?: DefinicaoTransporte[]
  format?: winston.Logform.Format
}

export interface DefinicaoTransporte {
  type: 'console' | 'dailyRotateFile'
  options: Record<string, unknown>
}

const createTransport = ({ type, options }: DefinicaoTransporte): winston.transport => {
  if (type === 'console') {
    return new winston.transports.Console(options)
  }

  return new DailyRotateFile(options)
}

export const criarInstanciaLogger = (opcoes: OpcoesLogger = {}): LoggerInstancia => {
  const transports = opcoes.transports ?? (opcoes.transportDefinitions ?? []).map(createTransport)

  return winston.createLogger({
    level: opcoes.level ?? 'info',
    levels: LOG_LEVELS,
    format: opcoes.format ?? winston.format.errors({ stack: true }),
    defaultMeta: opcoes.defaultMeta,
    transports,
    exitOnError: false,
  }) as LoggerInstancia
}
