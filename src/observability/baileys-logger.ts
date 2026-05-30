import type { ILogger } from 'baileys/lib/Utils/logger.js'
import type { AppLogger } from './logger.js'

type Meta = Record<string, unknown>

type DecryptLogState = {
  attempts: number
  nextAttemptAt: number
  lastError: string
  suppressedDuplicates: number
}

const DECRYPT_LOG_COOLDOWN_MS = 60_000
const decryptLogState = new Map<string, DecryptLogState>()

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const mergeMeta = (base: Meta, extra?: Meta): Meta | undefined => {
  const merged = { ...base, ...(extra ?? {}) }
  return Object.keys(merged).length > 0 ? merged : undefined
}

const getErrorMeta = (meta: Meta | undefined): { errorName: string | null; errorMessage: string | null } => {
  const err = meta?.err ?? meta?.error
  if (err instanceof Error) {
    return { errorName: err.name, errorMessage: err.message }
  }
  if (isRecord(err)) {
    return {
      errorName: typeof err.name === 'string' ? err.name : null,
      errorMessage: typeof err.message === 'string' ? err.message : null,
    }
  }
  return { errorName: null, errorMessage: null }
}

const classifyKnownDecryptNoise = (message: string, meta: Meta | undefined) => {
  if (message !== 'failed to decrypt message' && message !== 'transaction failed, rolling back') return null

  const { errorName, errorMessage } = getErrorMeta(meta)
  if (!errorMessage) return null

  let classification: string | null = null
  if (errorName === 'MessageCounterError' && errorMessage === 'Key used already or never filled') {
    classification = 'signal-message-counter-error'
  } else if (errorMessage === 'Over 2000 messages into the future!') {
    classification = 'signal-message-too-far-future'
  } else if (errorMessage === 'No session found to decrypt message') {
    classification = 'signal-no-session-for-decrypt'
  } else if (errorMessage === 'No matching sessions found for message') {
    classification = 'signal-no-matching-session'
  } else if (errorMessage === 'Bad MAC') {
    classification = 'signal-bad-mac'
  } else if (errorMessage === 'Expected Buffer instead of: Object') {
    classification = 'signal-invalid-buffer-shape'
  }

  if (!classification) return null

  const remoteJid = typeof meta?.sender === 'string' ? meta.sender : typeof meta?.remoteJid === 'string' ? meta.remoteJid : null
  const author = typeof meta?.author === 'string' ? meta.author : typeof meta?.participant === 'string' ? meta.participant : null
  return {
    classification,
    canonical: message === 'failed to decrypt message',
    key: [typeof meta?.connectionId === 'string' ? meta.connectionId : 'default', author ?? '', remoteJid ?? '', classification, errorName, errorMessage].join('::'),
    remoteJid,
    author,
    errorName,
    errorMessage,
  }
}

const writeKnownDecryptNoise = (method: (...args: unknown[]) => void, message: string, meta: Meta | undefined) => {
  const classification = classifyKnownDecryptNoise(message, meta)
  if (!classification) return false
  const now = Date.now()
  const previous = decryptLogState.get(classification.key)

  if (!classification.canonical) {
    const nextState: DecryptLogState = {
      attempts: previous?.attempts ?? 0,
      nextAttemptAt: previous?.nextAttemptAt ?? now + DECRYPT_LOG_COOLDOWN_MS,
      lastError: classification.errorMessage ?? previous?.lastError ?? '',
      suppressedDuplicates: (previous?.suppressedDuplicates ?? 0) + 1,
    }
    decryptLogState.set(classification.key, nextState)
    return true
  }

  if (previous && previous.nextAttemptAt > now && previous.lastError === classification.errorMessage) {
    previous.suppressedDuplicates += 1
    decryptLogState.set(classification.key, previous)
    return true
  }

  const nextState: DecryptLogState = {
    attempts: (previous?.attempts ?? 0) + 1,
    nextAttemptAt: now + DECRYPT_LOG_COOLDOWN_MS,
    lastError: classification.errorMessage ?? '',
    suppressedDuplicates: previous?.suppressedDuplicates ?? 0,
  }
  decryptLogState.set(classification.key, nextState)
  method('falha recorrente de decrypt detectada', {
    ...meta,
    classification: classification.classification,
    attempt: nextState.attempts,
    suppressedDuplicates: nextState.suppressedDuplicates,
    author: classification.author,
    remoteJid: classification.remoteJid,
    errorName: classification.errorName,
    errorMessage: classification.errorMessage,
  })
  nextState.suppressedDuplicates = 0
  decryptLogState.set(classification.key, nextState)
  return true
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
    if (writeKnownDecryptNoise(method, entry.message, entry.meta)) return
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
