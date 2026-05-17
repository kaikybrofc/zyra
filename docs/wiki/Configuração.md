# Configuração

Esta página documenta as variáveis de ambiente e decisões de configuração que afetam runtime, persistência, mídia, antiban, backfill e operação multi-instância.

A referência de defaults está em `.env.example`. A leitura em runtime é centralizada em `src/config/index.ts`, com validações adicionais no bootstrap de `src/index.ts`.

## Princípio central: multi-instância

O Zyra é desenhado para operar com isolamento por conexão.

Use esta convenção ao ler a documentação:

- `WA_CONNECTION_ID`: variável de ambiente
- `connection_id`: chave de partição no banco e em parte da persistência
- `connectionId`: naming interno do runtime

Cada instância deve ter um `WA_CONNECTION_ID` único. Esse valor afeta:

- auth e sessão
- chaves Redis
- tabelas e auditoria no MySQL
- checkpoints do backfill
- configuração por grupo
- reconciliação de identidade

## Estratégia de autenticação e persistência de sessão

A escolha da fonte de auth segue esta prioridade:

1. **MySQL**
2. **Redis**
3. **Disco local**

Se a resolução da estratégia centralizada falhar durante o bootstrap, o socket pode cair para o fallback local em disco para preservar disponibilidade.

## Variáveis essenciais

### Identidade e comportamento geral

- `WA_CONNECTION_ID`: identificador lógico da instância
- `WA_COMMAND_PREFIX`: prefixo dos comandos
- `WA_PRINT_QR`: controla exibição do QR no terminal
- `LOG_LEVEL`: nível de log
- `WA_ACCEPT_OWN_MESSAGES`: processa mensagens enviadas pela própria conta
- `WA_IGNORE_STATUS_BROADCAST`: ignora `status@broadcast`

### Persistência e auth

- `MYSQL_URL`: persistência SQL principal
- `WA_DB_URL`: alias legado para `MYSQL_URL`
- `WA_REDIS_URL`: endpoint Redis
- `WA_REDIS_PREFIX`: prefixo de chaves Redis
- `WA_AUTH_DIR`: diretório local de credenciais
- `WA_AUTH_PERSIST_KEYS`: persiste chaves de auth também em disco

### Router e runtime de comandos

- `WA_COMMAND_TIMEOUT_MS`: timeout máximo de execução de comando
- `WA_ROUTER_MAX_PENDING_PER_QUEUE`: limite de mensagens pendentes por fila
- `WA_MAX_CACHED_MESSAGES`: limite do cache local em memória

Essas variáveis controlam o comportamento do pipeline por `connectionId:chatId`, incluindo proteção contra filas saturadas e comandos travados.

### Mídia

- `WA_MEDIA_AUTO_DOWNLOAD`: download automático de mídia
- `WA_MEDIA_DOWNLOAD_DIR`: diretório local da mídia baixada
- `WA_MEDIA_MAX_BYTES`: cota máxima local
- `WA_MEDIA_RETENTION_DAYS`: retenção em dias

### Antiban, métricas e estabilidade de sessão

- `WA_ANTIBAN_ENABLED`
- `WA_ANTIBAN_LOGGING`
- `WA_ANTIBAN_MAX_PER_MINUTE`
- `WA_ANTIBAN_MAX_PER_HOUR`
- `WA_ANTIBAN_MAX_PER_DAY`
- `WA_ANTIBAN_MIN_DELAY_MS`
- `WA_ANTIBAN_MAX_DELAY_MS`
- `WA_ANTIBAN_NEW_CHAT_DELAY_MS`
- `WA_ANTIBAN_IDENTICAL_WINDOW_MS`
- `WA_ANTIBAN_DEAF_SESSION_ENABLED`
- `WA_ANTIBAN_DEAF_SESSION_TIMEOUT_MS`
- `WA_ANTIBAN_DEAF_SESSION_MIN_UPTIME_MS`
- `WA_ANTIBAN_DEAF_SESSION_AUTO_RECONNECT`
- `WA_ANTIBAN_JID_CANONICALIZER_ENABLED`
- `WA_ANTIBAN_LID_CANONICAL`
- `WA_ANTIBAN_METRICS_ENABLED`
- `WA_ANTIBAN_METRICS_HOST`
- `WA_ANTIBAN_METRICS_PORT`
- `WA_ANTIBAN_METRICS_PATH`

### Health e runtime interno

- `WA_HEALTH_ENABLED`
- `WA_HEALTH_HOST`
- `WA_HEALTH_PORT`
- `WA_SHUTDOWN_TIMEOUT_MS`
- `WA_CREDS_DEBOUNCE_MS`
- `WA_RECONNECT_BASE_DELAY_MS`
- `WA_RECONNECT_MAX_DELAY_MS`
- `WA_RECONNECT_MAX_ATTEMPTS`
- `WA_MYSQL_RETRY_MS`

### Backfill

- `WA_BACKFILL_INTERVAL_MS`
- `WA_BACKFILL_ONCE`
- `WA_BACKFILL_BATCH_SIZE`
- `WA_BACKFILL_MAX_FAILURES`
- `WA_BACKFILL_FAILURE_BACKOFF_MS`

## Configurações por cenário

### Ambiente local simples

Use quando quiser subir uma única instância com menos dependências:

- `WA_CONNECTION_ID=default`
- `MYSQL_URL` configurado
- `WA_REDIS_URL` opcional
- `WA_PRINT_QR=true`
- `LOG_LEVEL=debug` ou `info`

### Ambiente compartilhado / multi-instância

Use quando múltiplas sessões compartilham a mesma infraestrutura:

- `WA_CONNECTION_ID` único por sessão
- `MYSQL_URL` obrigatório
- `WA_REDIS_URL` recomendado
- disciplina de prefixo e segregação operacional por conexão

### Produção com PM2

Recomendado para servidores persistentes:

- `LOG_LEVEL=info`
- `WA_PRINT_QR=false` após sessão estabilizada
- `WA_ANTIBAN_ENABLED=true`
- `WA_ANTIBAN_METRICS_ENABLED=true` quando houver observabilidade externa
- `WA_HEALTH_ENABLED=true`

### Docker Compose

A stack padrão já injeta:

- `WA_CONNECTION_ID=default`
- `WA_REDIS_URL=redis://redis:6379`
- `MYSQL_URL=mysql://zyra:zyra@mysql:3306/zyra`

Ajuste `.env` conforme o ambiente, mantendo a mesma lógica de isolamento.

## Exemplo mínimo de `.env`

```env
WA_CONNECTION_ID=default
WA_COMMAND_PREFIX=!
MYSQL_URL=mysql://user:pass@127.0.0.1:3306/zyra
WA_REDIS_URL=redis://127.0.0.1:6379
LOG_LEVEL=info
WA_MEDIA_AUTO_DOWNLOAD=true
WA_MEDIA_DOWNLOAD_DIR=data/media
```

## Verificações recomendadas

Depois de alterar configuração:

```bash
npm run db:verify
npm run build
npm test
```

Também valide:

- logs de bootstrap
- estratégia de auth realmente escolhida
- visibilidade de métricas e health quando habilitados
- processos PM2 ou serviços Docker alinhados com a configuração desejada

## Leituras relacionadas

- [Instalação](Instalação)
- [Persistência](Persistência)
- [Produção](Produção)
- [Troubleshooting](Troubleshooting)

---

**Zyra Wiki** • Última atualização: 17/05/2026