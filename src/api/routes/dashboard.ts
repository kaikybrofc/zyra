import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const __dir = dirname(fileURLToPath(import.meta.url))
// Resolves to src/api/dashboard.html in dev (tsx) and dist/api/dashboard.html in prod
const html = readFileSync(resolve(__dir, '../dashboard.html'), 'utf-8')

export const serveDashboard = (_req: IncomingMessage, res: ServerResponse): void => {
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(html)
}
