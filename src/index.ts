import { loadEnv } from './bootstrap/env.js'
import { start } from './bootstrap/start.js'

loadEnv()

start().catch((error) => {
  console.error('failed to start bot', error)
  process.exitCode = 1
})
