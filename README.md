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

3. Configure as variáveis de ambiente:

`WA_AUTH_DIR`: caminho para os arquivos de sessão do WhatsApp (padrão: `data/auth`).

`WA_PRINT_QR`: `true` ou `false` para imprimir o QR no terminal.

`LOG_LEVEL`: nível de log (`trace|debug|info|warn|error|fatal`).

`WA_REDIS_URL`: URL do Redis para cache quente da sessão e da store (opcional).

`WA_REDIS_PREFIX`: prefixo das chaves no Redis (padrão: `zyra:conexao`).

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
