import { loadEnv } from './bootstrap/env.js'
import { start } from './bootstrap/start.js'

loadEnv()

start().catch((error) => {
  console.error('falha ao iniciar o bot', error)
  process.exitCode = 1
})
