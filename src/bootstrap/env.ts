import { config as loadDotEnv } from 'dotenv'

/**
 * Carrega variaveis de ambiente do arquivo .env.
 */
export function loadEnv(): void {
  loadDotEnv()
}
