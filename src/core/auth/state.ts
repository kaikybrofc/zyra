import { useMultiFileAuthState, type AuthenticationState } from '@whiskeysockets/baileys'
import { config } from '../../config/index.js'
import { resolveAuthDir } from './auth-dir.js'
import { useMysqlAuthState } from './mysql-auth-state.js'
import { useRedisAuthState } from './redis-auth-state.js'

/**
 * Interface genérica para o retorno das funções de estado de autenticação.
 * Garante que qualquer estratégia escolhida retorne a estrutura necessária para o Baileys.
 */
type AuthStateProvider =
  | ReturnType<typeof useMysqlAuthState>
  | ReturnType<typeof useRedisAuthState>
  | Promise<{
      state: AuthenticationState
      saveCreds: () => Promise<void>
    }>

/**
 * Fábrica de Estratégias de Autenticação (Authentication Strategy Factory).
 * * @remarks
 * Esta função é o ponto central de decisão para a persistência do bot.
 * Ela avalia as configurações disponíveis e seleciona o driver mais robusto na seguinte ordem:
 * * 1. **MySQL**: Se `mysqlUrl` estiver presente, utiliza a persistência em banco de dados SQL (Recomendado para produção distribuída).
 * 2. **Redis**: Se `redisUrl` estiver presente (e MySQL não), utiliza o Redis para alta performance e volatilidade controlada.
 * 3. **Local File System**: Caso nenhuma URL de banco seja fornecida, utiliza o driver padrão do Baileys para salvar em arquivos JSON locais.
 * * @param connectionId - Identificador único da sessão/instância. Essencial para isolar dados em ambientes multi-instância.
 * * @returns Uma promessa que resolve para um objeto contendo:
 * - `state`: O estado de autenticação (creds e keys) para injetar no `makeWASocket`.
 * - `saveCreds`: A função de callback para persistência de mudanças nas credenciais.
 * * @example
 * ```typescript
 * const { state, saveCreds } = await getAuthState('sessao_123');
 * const sock = makeWASocket({
 * auth: state,
 * // ... outras configs
 * });
 * * // Ouvir atualização de credenciais
 * sock.ev.on('creds.update', saveCreds);
 * ```
 */
export async function getAuthState(connectionId?: string): Promise<AuthStateProvider> {
  // 1ª Prioridade: MySQL (Persistência ACID e centralizada)
  if (config.mysqlUrl) {
    return useMysqlAuthState(connectionId)
  }

  // 2ª Prioridade: Redis (Persistência em memória com cache rápido)
  if (config.redisUrl) {
    return useRedisAuthState(connectionId)
  }

  // 3ª Prioridade/Fallback: Sistema de Arquivos Local (JSON)
  // Utilizado geralmente em ambiente de desenvolvimento ou instâncias únicas simples.
  const { state, saveCreds } = await useMultiFileAuthState(resolveAuthDir(connectionId))

  return {
    state,
    saveCreds,
  }
}
