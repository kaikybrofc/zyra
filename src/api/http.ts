import type { IncomingMessage, ServerResponse } from 'node:http'

/** Params extraídos de segmentos dinâmicos da rota (ex: :id). */
export type RouteParams = Record<string, string>

/** Erro lançado quando o corpo excede o limite máximo permitido. */
export class BodyTooLargeError extends Error {
  constructor(message = 'request body too large') {
    super(message)
    this.name = 'BodyTooLargeError'
  }
}

/** Lê o corpo completo de uma requisição HTTP como string UTF-8. */
export const readBody = (req: IncomingMessage, options?: { maxBytes?: number }): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const maxBytes = options?.maxBytes
    let total = 0
    let finished = false
    req.on('data', (chunk) => {
      if (finished) return
      const buf = chunk as Buffer
      total += buf.length
      if (typeof maxBytes === 'number' && maxBytes > 0 && total > maxBytes) {
        finished = true
        reject(new BodyTooLargeError())
      } else {
        chunks.push(buf)
      }
    })
    req.on('end', () => {
      if (finished) return
      finished = true
      resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', (error) => {
      if (finished) return
      finished = true
      reject(error)
    })
  })

/** Faz parse de JSON com retorno null em caso de erro de sintaxe. */
export const parseJson = <T>(body: string): T | null => {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** Envia resposta JSON com status e payload arbitrário. */
export const sendJson = (res: ServerResponse, status: number, data: unknown): void => {
  const body = JSON.stringify(data)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(body)
}

/** Envia resposta de erro padronizada `{ error }`. */
export const sendError = (res: ServerResponse, status: number, error: string): void => {
  sendJson(res, status, { error })
}

/** Faz parse resiliente da URL recebida no servidor HTTP nativo. */
export const parseUrl = (req: IncomingMessage): URL => new URL(req.url ?? '/', 'http://localhost')

type RouteMatch = { params: RouteParams } | null

/**
 * Verifica se `pathname` bate com `pattern`.
 * Segmentos prefixados com `:` viram parâmetros nomeados.
 * Quantidade de segmentos deve ser igual — sem wildcards.
 */
export const matchRoute = (pattern: string, pathname: string): RouteMatch => {
  const pp = pattern.split('/')
  const vp = pathname.split('/')
  if (pp.length !== vp.length) return null
  const params: RouteParams = {}
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i] ?? ''
    const val = vp[i] ?? ''
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = decodeURIComponent(val)
    } else if (seg !== val) {
      return null
    }
  }
  return { params }
}
