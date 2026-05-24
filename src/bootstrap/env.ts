import { config as loadDotEnv } from 'dotenv'

let envLoaded = false

/**
 * Carrega variáveis de ambiente do arquivo `.env` apenas uma vez por processo.
 *
 * @remarks
 * Chamadas subsequentes são ignoradas para evitar reload redundante.
 */
export function loadEnv(): void {
  if (envLoaded) return
  loadDotEnv()
  envLoaded = true
}
