import makeWASocket, {
  Browsers,
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type SignalRepositoryWithLIDStore,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { config } from '../../config/index.js'
import type { AppLogger } from '../../observability/logger.js'
import { createBaileysLogger } from '../../observability/baileys-logger.js'
import { createBaileysStore } from '../../store/baileys-store.js'
import { getAuthState } from '../auth/state.js'
import { allowHistorySyncOnceForNewLogin, initHistorySyncPolicy, shouldSyncHistoryMessageOnce } from './history-sync.js'

/** * Extensão de tipo para acessar repositórios internos de LID (Linked Identity) do Baileys. 
 * @internal 
 */
type SocketWithSignalRepository = {
  signalRepository?: SignalRepositoryWithLIDStore
}

/** Tipo que representa o formato da versão do protocolo do WhatsApp (ex: [2, 3000, 101]) */
type SocketVersion = typeof DEFAULT_CONNECTION_CONFIG.version

/** Tempo de vida do cache da versão do Baileys (24 horas) */
const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000
/** Timeout máximo para shutdown gracioso antes de forçar saída */
const SHUTDOWN_TIMEOUT_MS = Math.max(0, Number(process.env.WA_SHUTDOWN_TIMEOUT_MS ?? 10_000))
/** Debounce para evitar tempestade de gravações em creds.update */
const CREDS_DEBOUNCE_MS = Math.max(0, Number(process.env.WA_CREDS_DEBOUNCE_MS ?? 1_500))

/** Cache volátil para evitar requisições excessivas à API de versões */
let cachedVersion: { version: SocketVersion; fetchedAt: number } | null = null

/**
 * Resolve a versão ideal do WhatsApp Web para a conexão.
 * @remarks
 * Implementa cache em memória para evitar gargalos no boot de múltiplas instâncias.
 * Se a busca falhar, utiliza a última versão em cache ou a constante padrão da biblioteca.
 * @param logger - Instância do logger para registro de alertas de versão.
 * @returns Promessa com a versão [major, minor, patch].
 */
async function resolveBaileysVersion(logger: AppLogger): Promise<SocketVersion> {
  const cached = cachedVersion
  if (cached && Date.now() - cached.fetchedAt < VERSION_CACHE_TTL_MS) {
    return cached.version
  }
  try {
    const latest = await fetchLatestBaileysVersion()
    if ('error' in latest && latest.error) {
      logger.warn('falha ao buscar a última versão do Baileys, usando fallback', { err: latest.error })
      return cached?.version ?? DEFAULT_CONNECTION_CONFIG.version
    }

    if (!latest.isLatest) {
      logger.warn('versão do Baileys desatualizada detectada', { version: latest.version })
    }

    cachedVersion = { version: latest.version, fetchedAt: Date.now() }
    return latest.version
  } catch (error) {
    logger.warn('erro ao buscar versão, usando padrão', { err: error })
    return cached?.version ?? DEFAULT_CONNECTION_CONFIG.version
  }
}

/**
 * Inicializa o estado de autenticação com base nas configurações de infraestrutura.
 * @remarks
 * Tenta utilizar a estratégia centralizada (MySQL/Redis). 
 * Em caso de erro crítico, regride para o sistema de arquivos local (Disco) para garantir a disponibilidade.
 * @param connectionId - ID único da conexão.
 * @param logger - Logger para rastro de falhas de autenticação.
 */
async function resolveAuthState(connectionId: string, logger: AppLogger) {
  try {
    return await getAuthState(connectionId)
  } catch (error) {
    logger.error('falha ao resolver auth state, ativando fallback local', { err: error })
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
    return { state, saveCreds }
  }
}

/**
 * Define o contrato para objetos registrados para encerramento gracioso.
 */
type ShutdownTarget = {
  /** Instância ativa do socket Baileys */
  sock: ReturnType<typeof makeWASocket>
  /** Repositório de dados vinculado à conexão */
  store: ReturnType<typeof createBaileysStore>
  /** Função de persistência de credenciais */
  saveCreds: () => Promise<void>
  /** Logger da aplicação */
  logger: AppLogger
  /** ID da conexão */
  connectionId: string
}

/** Coleção de instâncias ativas para gerenciamento de encerramento */
const shutdownTargets = new Set<ShutdownTarget>()
/** Flag para garantir que o listener de sinal do processo seja registrado uma única vez */
let shutdownRegistered = false
/** Flag de controle para evitar múltiplas execuções do fluxo de shutdown */
let shutdownInProgress = false

/**
 * Registra os listeners de sinais do SO (SIGINT, SIGTERM) para encerramento limpo.
 * @remarks
 * Quando um sinal é recebido, a função percorre todos os sockets ativos, 
 * persiste as credenciais pendentes e limpa as referências antes de fechar o processo.
 * @internal
 */
const registerGracefulShutdown = () => {
  if (shutdownRegistered) return
  shutdownRegistered = true

  const handler = async (signal: string) => {
    if (shutdownInProgress) return
    shutdownInProgress = true
    const targets = Array.from(shutdownTargets)
    shutdownTargets.clear()

    const baseLogger = targets[0]?.logger ?? null
    const forceExit =
      SHUTDOWN_TIMEOUT_MS > 0
        ? setTimeout(() => {
            if (baseLogger) {
              baseLogger.error('shutdown demorou demais, forçando encerramento', { signal })
            } else {
              console.error('shutdown demorou demais, forçando encerramento', { signal })
            }
            process.exit(1)
          }, SHUTDOWN_TIMEOUT_MS)
        : null

    try {
      await Promise.all(
        targets.map(async ({ sock, saveCreds, logger, connectionId }) => {
          logger.warn('executando shutdown gracioso do socket', { signal, connectionId })
          try {
            await saveCreds()
          } catch (error) {
            logger.error('falha ao persistir credenciais durante o encerramento', { err: error })
          }
          if (typeof sock.end === 'function') {
            await sock.end(undefined)
          }
        })
      )
    } catch (error) {
      if (baseLogger) {
        baseLogger.error('falha durante shutdown gracioso', { err: error })
      } else {
        console.error('falha durante shutdown gracioso', { err: error })
      }
    } finally {
      if (forceExit) clearTimeout(forceExit)
    }
    // Opcional: process.exit(0) se este for o único serviço
  }

  process.once('SIGINT', () => void handler('SIGINT'))
  process.once('SIGTERM', () => void handler('SIGTERM'))
}

/**
 * Fábrica (Factory) para criação e configuração completa do Socket Baileys.
 * * @remarks
 * Esta função orquestra diversos componentes vitais:
 * 1. **Auth**: Carrega a estratégia definida (MySQL, Redis, Disco).
 * 2. **Version**: Resolve a versão do protocolo com caching.
 * 3. **Sync**: Configura políticas de sincronização de histórico para evitar consumo excessivo de memória.
 * 4. **Store**: Vincula o repositório de mensagens e metadados ao barramento de eventos.
 * 5. **Graceful Shutdown**: Registra a instância para persistência segura em caso de encerramento do processo.
 * * @example
 * ```typescript
 * const sock = await createSocket('instancia-1', logger);
 * ```
 * * @param connectionId - Identificador único da sessão (connection_id).
 * @param logger - Instância do logger para monitoramento.
 * @returns Uma instância configurada de `WASocket`.
 */
export async function createSocket(connectionId: string, logger: AppLogger) {
  const store = createBaileysStore(connectionId)
  const strategy = config.mysqlUrl ? 'mysql' : config.redisUrl ? 'redis' : 'disco'
  
  logger.info('inicializando setup do socket', { strategy, connectionId })
  
  const { state, saveCreds } = await resolveAuthState(connectionId, logger)
  const version = await resolveBaileysVersion(logger)
  
  // Inicializa política de histórico (evita travamentos de buffer em logins antigos)
  initHistorySyncPolicy(state.creds)

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu('Zyra System'),
    logger: createBaileysLogger(logger),
    emitOwnEvents: true,
    fireInitQueries: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: shouldSyncHistoryMessageOnce,
    getMessage: store.getMessage,
    cachedGroupMetadata: store.getGroupMetadata,
    msgRetryCounterCache: store.caches.msgRetryCounterCache,
    callOfferCache: store.caches.callOfferCache,
    placeholderResendCache: store.caches.placeholderResendCache,
    userDevicesCache: store.caches.userDevicesCache,
    mediaCache: store.caches.mediaCache,
  })

  // Sincronização inicial do JID do bot
  store.setSelfJid(sock.user?.id ?? null)

  sock.ev.on('connection.update', (update) => {
    if (update.connection === 'open') {
      store.setSelfJid(sock.user?.id ?? null)
      logger.info('status da conexao: aberta', { connectionId })
    }
    
    if (update.isNewLogin) {
      allowHistorySyncOnceForNewLogin()
    }
    
    if (update.connection === 'close') {
      const statusCode = (update.lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      logger.warn('status da conexao: encerrada', { connectionId, statusCode })
      
      if (statusCode === DisconnectReason.loggedOut) {
        logger.error('sessao invalidada/removida, requer re-pareamento', { connectionId })
        store.setSelfJid(null)
      }
    }
  })

  // Vincula repositório de LIDs se disponível (WhatsApp Multi-Device v2)
  const lidMappingStore = (sock as SocketWithSignalRepository).signalRepository?.lidMapping
  if (lidMappingStore) {
    store.bindLidMappingStore(lidMappingStore)
  }

  // Acopla a store ao fluxo de eventos do socket
  store.bind(sock.ev)

  // Escuta atualizações de chaves criptográficas e tokens
  let credsSaveTimer: NodeJS.Timeout | null = null
  let credsSaveInFlight = false
  let credsSaveQueued = false

  const flushCredsSave = async () => {
    if (credsSaveInFlight) {
      credsSaveQueued = true
      return
    }
    credsSaveInFlight = true
    try {
      await saveCreds()
    } catch (error) {
      logger.error('erro ao salvar credenciais durante ciclo de vida', { err: error })
    } finally {
      credsSaveInFlight = false
    }
    if (credsSaveQueued) {
      credsSaveQueued = false
      void flushCredsSave()
    }
  }

  const scheduleCredsSave = () => {
    if (CREDS_DEBOUNCE_MS <= 0) {
      void flushCredsSave()
      return
    }
    if (credsSaveTimer) clearTimeout(credsSaveTimer)
    credsSaveTimer = setTimeout(() => {
      credsSaveTimer = null
      void flushCredsSave()
    }, CREDS_DEBOUNCE_MS)
  }

  sock.ev.on('creds.update', scheduleCredsSave)

  // Registro para encerramento seguro do processo
  shutdownTargets.add({ sock, store, saveCreds, logger, connectionId })
  registerGracefulShutdown()

  return sock
}
