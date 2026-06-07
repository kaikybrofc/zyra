import console from 'node:console'
import process from 'node:process'

const mode = (process.argv[2] ?? '').trim().toLowerCase()

const setDefaultEnv = (key, value) => {
  if (process.env[key] === undefined) {
    process.env[key] = value
  }
}

switch (mode) {
  case 'connections-only':
    setDefaultEnv('WA_API_ENABLED', 'false')
    setDefaultEnv('WA_BOOTSTRAP_CONNECTIONS_ENABLED', 'true')
    setDefaultEnv('WA_WEBHOOK_RETRY_ENABLED', 'false')
    setDefaultEnv('WA_WEBHOOK_OUTBOX_ENABLED', 'false')
    break
  case 'api-webhook':
    setDefaultEnv('WA_API_ENABLED', 'true')
    setDefaultEnv('WA_BOOTSTRAP_CONNECTIONS_ENABLED', 'false')
    setDefaultEnv('WA_WEBHOOK_RETRY_ENABLED', 'true')
    setDefaultEnv('WA_WEBHOOK_OUTBOX_ENABLED', 'true')
    break
  case 'stateless':
    setDefaultEnv('WA_API_ENABLED', 'false')
    setDefaultEnv('WA_BOOTSTRAP_CONNECTIONS_ENABLED', 'false')
    setDefaultEnv('WA_WEBHOOK_RETRY_ENABLED', 'false')
    setDefaultEnv('WA_WEBHOOK_OUTBOX_ENABLED', 'false')
    break
  default:
    console.error(`Modo de runtime inválido: "${mode}". Use connections-only, api-webhook ou stateless.`)
    process.exit(1)
}

await import('../dist/index.js')
