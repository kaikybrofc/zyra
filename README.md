# Zyra System

Zyra System — bot de WhatsApp em Node.js usando Baileys, com persistência em MySQL e suporte a múltiplas conexões.

## Visão geral

- Conexões isoladas por `connection_id`, permitindo múltiplas instâncias no mesmo banco.
- Persistência de credenciais e chaves do Baileys, evitando login recorrente.
- Store persistente para chats, mensagens, grupos e caches auxiliares.
- Rastreamento de eventos e histórico para auditoria e troubleshooting.

## Sistema de conexão

O módulo `src/core/connection` centraliza a criação e o ciclo de vida do socket do WhatsApp.

- `createSocket(connectionId, logger)` cria uma conexão isolada por `connection_id`.
- Carrega credenciais via `getAuthState` e salva atualizações com `creds.update`.
- Resolve a versão do Baileys com fallback seguro e logs de aviso quando necessário.
- Inicializa a política de sincronização de histórico para evitar reprocessamento.
- Configura o socket com store e caches, e liga o store aos eventos do Baileys.
- Atualiza o `selfJid` quando a conexão abre e libera um único sync completo após novo login.

A política de sync em `src/core/connection/history-sync.ts` libera a sincronização completa apenas:

- No primeiro login (quando `accountSyncCounter` indica conta nova).
- Em um novo login detectado pelo Baileys.

Isso reduz carga, evita travamentos no buffer e mantém o histórico sob controle.

## Modelo do banco

O modelo completo está documentado em `docs/exemplodbmodel.md` (inclui diagrama e DDL MySQL 8).

Principais entidades e responsabilidades:

- `connections`: raiz de isolamento por conexão.
- `auth_creds` e `signal_keys`: persistência das credenciais e chaves do Baileys.
- `users` e `user_identifiers`: identidade única por usuário com múltiplos identificadores (`pn`, `lid`, `jid`, `username`).
- Store persistente: `chats`, `messages`, `groups`, `wa_contacts_cache`.
- Relacionamentos e suporte: `chat_users`, `group_participants`, `message_users`, `message_media`.
- Observabilidade e histórico: `events_log`, `message_events`, `message_failures`, `commands_log`.

## Vantagens do modelo

- Multi-tenant real: cada `connection_id` isola dados, credenciais e store.
- Identidade de usuário consistente, mesmo com múltiplos identificadores.
- Facilidade de auditoria e depuração com logs e eventos persistidos.
- Persistência confiável de credenciais e store, reduzindo re-login e inconsistência.
- Estrutura extensível para features futuras (labels, bloqueios, newsletters, etc.).

## Requisitos

- Node.js LTS (>=20)
- npm

## Instalação rápida

1. Instale as dependências:

```bash
npm install
```

2. Crie o arquivo `.env` a partir do `.env.example`:

```bash
cp .env.example .env
```

3. Configure as variáveis de ambiente (lista completa):

- `WA_AUTH_DIR`: caminho para os arquivos de sessão do WhatsApp (padrão: `data/auth`).
- `WA_PRINT_QR`: `true` ou `false` para imprimir o QR no terminal (padrão: `true`).
- `LOG_LEVEL`: nível de log (`trace|debug|info|warn|error|fatal`) (padrão: `info`).
- `WA_REDIS_URL`: URL do Redis para cache quente da sessão e da store (opcional).
- `WA_REDIS_PREFIX`: prefixo das chaves no Redis (padrão: `zyra:conexao`).
- `MYSQL_URL`: URL de conexão MySQL para persistência (opcional).
- `WA_DB_URL`: alias legado para `MYSQL_URL` (opcional).
- `WA_CONNECTION_ID`: identificador da conexão no banco (padrão: `default`).
- `WA_ACCEPT_OWN_MESSAGES`: aceita mensagens da própria conta (padrão: `false`).
- `WA_DELETE_SESSION_TIMEOUT_MS`: timeout do script de delete-session (ms) (padrão: `15000`).
- `WA_DELETE_SESSION_REDIS_MAX_MS`: limite do scan no Redis (ms) (padrão: `60000`).
- `WA_BACKFILL_LOG_SAMPLE`: amostra de logs detalhados do backfill (padrão: `20`).
- `WA_BACKFILL_BATCH_SIZE`: tamanho do lote de mensagens no backfill (padrão: `500`).
- `WA_BACKFILL_GROUP_LOG_EVERY`: log de progresso de grupos a cada N grupos (padrão: `25`).
- `WA_BACKFILL_PARTICIPANT_LOG_EVERY`: log de progresso de participantes a cada N registros (padrão: `200`).
- `WA_BACKFILL_MESSAGE_LOG_EVERY`: log de progresso de mensagens a cada N registros (padrão: `1000`).

Exemplo completo (igual ao `.env.example`):

```dotenv
WA_AUTH_DIR=data/auth
WA_PRINT_QR=true
LOG_LEVEL=info
WA_REDIS_URL=redis://localhost:6379
WA_REDIS_PREFIX=zyra:conexao
MYSQL_URL=mysql://user:password@localhost:3306/zyra
# WA_DB_URL=mysql://user:password@localhost:3306/zyra
WA_CONNECTION_ID=default
WA_ACCEPT_OWN_MESSAGES=false
WA_DELETE_SESSION_TIMEOUT_MS=15000
WA_DELETE_SESSION_REDIS_MAX_MS=60000
WA_BACKFILL_LOG_SAMPLE=20
WA_BACKFILL_BATCH_SIZE=500
WA_BACKFILL_GROUP_LOG_EVERY=25
WA_BACKFILL_PARTICIPANT_LOG_EVERY=200
WA_BACKFILL_MESSAGE_LOG_EVERY=1000
```

## Como rodar

Desenvolvimento:

```bash
npm run dev
```

Produção:

```bash
npm run build
npm start
```

Nota: o QR aparece no terminal no primeiro login quando `WA_PRINT_QR=true`. Se não aparecer, já existe uma sessão salva em `data/auth`.
