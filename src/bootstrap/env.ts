import { config as loadDotEnv } from 'dotenv'

let envLoaded = false

/**
 * Carrega variaveis de ambiente do arquivo .env.
 */
export function loadEnv(): void {
  if (envLoaded) return
  loadDotEnv()
  envLoaded = true
}
