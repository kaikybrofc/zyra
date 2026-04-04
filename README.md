# Zyra System

Zyra System — bot de WhatsApp em Node.js usando Baileys.

## Release v0.1.2 — MySQL Edition

```sql
-- Zyra 0.1.2 (MySQL Edition)
-- foco: backfill mais rápido e observável
```

Novidades incluídas nesta release:
- Cache em memória de `user_id` no backfill para reduzir consultas repetidas.
- Logs de progresso em grupos, participantes e mensagens durante o backfill.
- `WA_BACKFILL_BATCH_SIZE` para ajustar o tamanho do lote de mensagens.
- `WA_BACKFILL_GROUP_LOG_EVERY` para controlar o log de progresso de grupos.
- `WA_BACKFILL_PARTICIPANT_LOG_EVERY` para controlar o log de participantes.
- `WA_BACKFILL_MESSAGE_LOG_EVERY` para controlar o log de mensagens.
- `.codex` adicionado ao `.gitignore`.
- Dependências atualizadas via `npm update`.

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
