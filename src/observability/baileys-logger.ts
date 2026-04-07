import type { ILogger } from '@whiskeysockets/baileys/lib/Utils/logger.js'
import type { AppLogger } from './logger.js'

type Meta = Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const mergeMeta = (base: Meta, extra?: Meta): Meta | undefined => {
  const merged = { ...base, ...(extra ?? {}) }
  return Object.keys(merged).length > 0 ? merged : undefined
}

const buildEntry = (bindings: Meta, obj: unknown, msg?: string) => {
  let message: string | undefined = msg
  let meta: Meta | undefined

  if (typeof obj === 'string') {
    message = typeof msg === 'string' ? `${obj} ${msg}`.trim() : obj
  } else if (obj instanceof Error) {
    meta = { err: obj, stack: obj.stack }
    if (!message) {
      message = obj.message
    }
  } else if (isRecord(obj)) {
    const objMeta: Meta = { ...obj }
    if (typeof objMeta.msg === 'string' && !message) {
      message = objMeta.msg
      delete objMeta.msg
    }
    meta = objMeta
  } else if (obj !== undefined && obj !== null) {
    meta = { value: obj }
  }

  return {
    message: message ?? '',
    meta: mergeMeta(bindings, meta),
  }
}

const write =
  (method: (...args: unknown[]) => void, bindings: Meta) =>
  (obj: unknown, msg?: string): void => {
    const entry = buildEntry(bindings, obj, msg)
    if (entry.meta) {
      method(entry.message, entry.meta)
      return
    }
    method(entry.message)
  }

/**
 * Adapta o logger da aplicacao para o formato esperado pelo Baileys.
 */
export const createBaileysLogger = (base: AppLogger, bindings: Meta = {}): ILogger => ({
  get level() {
    return base.level
  },
  child(childBindings: Record<string, unknown>) {
    return createBaileysLogger(base, { ...bindings, ...childBindings })
  },
  trace: write(base.trace.bind(base), bindings),
  debug: write(base.debug.bind(base), bindings),
  info: write(base.info.bind(base), bindings),
  warn: write(base.warn.bind(base), bindings),
  error: write(base.error.bind(base), bindings),
})
