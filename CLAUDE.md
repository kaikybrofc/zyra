# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Environment and setup

- Node.js 20+ is required (`package.json` engines says `>=20`; CI tests Node 20.x and 22.x).
- Package manager is npm (`package-lock.json` is committed).
- Install dependencies with `npm ci` when you want a clean CI-like install, or `npm install` for local iteration.
- This repo installs entirely from public dependencies. If install fails, treat it as a normal npm/network/cache/dependency-resolution issue.
- `.npmrc` contains `legacy-peer-deps=true`.

## Common commands

### Development

- `npm run dev` — run the bot in watch mode via `tsx watch src/index.ts`
- `npm run start` — run the TypeScript entrypoint once via `tsx src/index.ts`
- `npm run build` — compile TypeScript to `dist/`
- `npm run start:prod` — run the compiled app from `dist/index.js`

### Quality

- `npm run lint` — run ESLint
- `npm run lint:fix` — run ESLint with autofix
- `npm run typecheck` — run TypeScript no-emit check plus Vitest typecheck
- `npm test` — run the full Vitest suite once
- `npm run test:watch` — run Vitest in watch mode

### Single-test workflows

- `npx vitest run tests/router.test.ts` — run one test file
- `npx vitest run tests/router.test.ts -t "should ..."` — run one named test inside a file
- `npx vitest watch tests/router.test.ts` — watch one test file

### Database and maintenance

- `npm run db:init` — create/update required MySQL schema objects
- `npm run db:verify` — verify table integrity / record counts
- `npm run db:delete-session` — remove a session’s persisted data from MySQL/Redis
- `npm run db:backfill` — run the backfill worker entrypoint
- `npm run db:repair-group-participants` — repair group participant data
- `npm run db:nulls` — generate null/inconsistency reports

Useful one-shot backfill pattern:

- `WA_BACKFILL_ONCE=true npm run db:backfill`

### PM2 production process management

- `npm run pm2:start`
- `npm run pm2:restart`
- `npm run pm2:logs`
- `npm run pm2:stop`
- `npm run pm2:delete`
- `npm run pm2:save`
- `npm run pm2:startup`

PM2 starts two processes from `ecosystem.config.cjs`:

- `zyra` — main bot runtime
- `zyra-backfill` — continuous DB backfill worker

### Docker / compose

- `DOCKER_BUILDKIT=1 docker build -t zyra:local .`
- `docker compose up -d --build`
- `docker compose logs -f zyra`
- `docker compose logs -f backfill`
- `docker compose down`

The compose stack includes:

- `zyra` main app
- `backfill` worker
- `mysql` 8.0
- `redis` 7

## Architecture overview

### Entry flow

- `src/index.ts` is the bootstrap entrypoint.
- It loads `.env`, validates a large set of WhatsApp/MySQL/Redis/antiban/runtime settings, then calls `start()` from `src/bootstrap/start.ts`.
- `start()` ensures MySQL schema init runs once, manages socket replacement/reconnect generation state, and optionally starts the antiban Prometheus metrics server.

### Core runtime shape

The runtime is split into four main layers:

1. **Connection/auth boot** — create socket, choose auth backend, register graceful shutdown.
2. **Event ingestion** — central Baileys event registration and auditing.
3. **State/persistence** — in-memory store with optional Redis and MySQL persistence.
4. **Command execution** — parse incoming messages, enforce moderation rules, run modular commands.

### Socket creation and auth strategy

`src/core/connection/socket.ts` is the main factory for a WhatsApp socket.

Key behaviors:

- Resolves auth state through `src/core/auth/state.ts`.
- Auth backend priority is:
  1. MySQL
  2. Redis
  3. local filesystem (`useMultiFileAuthState`)
- If centralized auth resolution throws, socket boot falls back to local filesystem auth so the bot can still start.
- Baileys version is fetched dynamically and cached in memory for 24h.
- Credential persistence is debounced (`WA_CREDS_DEBOUNCE_MS`) and can be flushed immediately before restart/shutdown.
- Graceful shutdown persists creds and antiban warm-up state for all active sockets.

### Multi-instance model

This codebase is built around `WA_CONNECTION_ID`.

- Every process/session is scoped by `connection_id`.
- MySQL persistence, Redis keys, audit logs, group config, backfill checkpoints, and user identity mapping all isolate by `connection_id`.
- Future work should preserve that tenant boundary; avoid writing features that assume a single global bot session.

### Event pipeline

`src/events/register.ts` is the event hub.

Important characteristics:

- It explicitly enumerates the Baileys events the app listens to and binds handlers from one central place.
- It creates a connection-scoped `SqlStore` and uses it for auditing and denormalized persistence.
- `messages.upsert` is the main live-message path:
  - for `notify` events it sends messages into the router/command pipeline
  - it also triggers newsletter media refresh handling
  - it records message failures when processing breaks
- Connection-open flow also syncs blocklist, groups, and communities.
- The file is also where newsletter/channel support is integrated: newsletter snapshots, participants, settings, reactions, views, metadata refresh, and media retry logic all live here.

### Router and command execution

The command stack is intentionally decoupled from raw Baileys APIs.

#### Queueing and backpressure

`src/router/index.ts` serializes processing per chat.

- Queue key is `connectionId:chatId`, so different chats stay independent even inside the same process.
- Each chat queue has a pending cap (`WA_ROUTER_MAX_PENDING_PER_QUEUE`) to protect memory.
- Command execution can be force-timed out with `WA_COMMAND_TIMEOUT_MS` so a stuck handler does not block the chat forever.

#### Command runtime

`src/core/command-runtime/processor.ts` is the real command engine.

It is responsible for:

- building a normalized message envelope from raw Baileys messages
- logging incoming messages for observability
- tracking recent messages per sender/chat
- enforcing antilink moderation before command execution
- creating a `CommandContext`
- executing the command and persisting command logs

`src/core/command-runtime/context.ts` is the stable API commands consume. Commands should use `ctx` helpers rather than raw socket operations when possible.

Command registry lives in `src/commands/index.ts`.

Current commands include:

- menu/ping
- sticker generation and conversion
- admin/group management commands
- antilink management command

### Antilink moderation path

Antilink is not just a simple command toggle; it is enforced inside the runtime processor.

Key behavior:

- `groupFeatureStore` controls whether a group has antilink enabled and stores allowed domains / own-invite exemptions.
- When enabled, the processor inspects text for links, skips approved domains, optionally allows the group’s own invite link, removes violators, attempts to cascade removal across linked community groups, and deletes recent messages from the sender.
- Group feature config persists with fallback layering:
  1. MySQL `group_config`
  2. Redis hash
  3. local file `.zyra-data/group-features.json`

### Persistence architecture

There are two different persistence concerns in the app:

#### 1. Auth/session persistence

Handled by `src/core/auth/*`.

This stores credentials and signal keys needed to keep the WhatsApp session alive.

#### 2. Store/audit/domain persistence

Handled mainly by:

- `src/store/baileys-store.ts`
- `src/store/redis-store.ts`
- `src/store/sql-store.ts`

`createBaileysStore()` is the state fan-out layer.

- In-memory Maps are the first-level hot cache.
- If enabled, Redis is used as a hot persisted cache.
- If enabled, MySQL is used as the durable system of record.
- Incoming Baileys events update these stores so message/group/contact/chat state stays queryable.

For reads, the general pattern is:

- memory first
- then Redis
- then MySQL

For writes, the store opportunistically fans out to Redis/MySQL when enabled.

### SQL store and identity model

`src/store/sql-store.ts` is one of the most important files in the repo.

It does much more than raw message storage:

- persists chats, contacts, groups, participants, blocklist, labels, newsletters, command logs, message failures, bot sessions, sticker templates, generated stickers, and media metadata
- records both high-level `events_log` entries and more message-specific `message_events`
- normalizes user identity across JID / PN / LID / username using `users`, `user_identifiers`, `user_aliases`, and `lid_mappings`
- auto-links message sender/mentioned/quoted/participant relationships into relational tables
- optionally downloads incoming media to disk and records `message_media`

A major design point here is that the database stores both:

- **raw payload JSON** for flexibility and auditability
- **derived columns / relational links** for queryability

That dual-write pattern is intentional; do not “simplify” it away without understanding the analytics/backfill consequences.

### LID/PN handling

WhatsApp identity reconciliation is a core concern in this repo.

- The store tracks PN↔LID mappings in memory, Redis, and MySQL.
- `sql-store.ts` contains conflict detection and isolation logic when PN/LID mappings imply conflicting user identities.
- `baileys-store.ts` also harvests LID/PN mappings from messaging history and group metadata.
- Antiban can canonicalize outbound JIDs (`WA_ANTIBAN_LID_CANONICAL`, usually `pn`).

When touching identity code, preserve both the multi-identifier model and the conflict-isolation behavior.

### Newsletter/channel support

Newsletter support is first-class, not an afterthought.

The system persists:

- newsletter snapshots
- participants/roles/status
- events such as reactions, views, and settings updates
- metadata refresh state with TTL/retry
- media refresh retries for newsletter media that arrives without enough material to download immediately

Most of that behavior lives in `src/events/register.ts`, with durable storage in `src/store/sql-store.ts`.

### Backfill worker

`src/core/db/backfill.ts` is a long-running maintenance worker, not just a one-off script.

Purpose:

- repair/fill derived relational columns after schema evolution or partial writes
- populate user links, display names, group/chat relationships, label associations, newsletter event users, media metadata, and event references
- maintain per-step checkpoints in `backfill_checkpoints`
- run continuously in production or once via `WA_BACKFILL_ONCE=true`

This means the database model intentionally tolerates some derived data being completed asynchronously. When adding new derived columns/tables, think about whether they need a backfill path as well as live-write logic.

### Observability

Observability is a built-in subsystem, not just console logging.

Relevant modules:

- `src/observability/logger.ts`
- `src/observability/baileys-logger.ts`
- `src/observability/antiban-metrics.ts`

Notable behaviors:

- application logs are structured
- Baileys logging is adapted into the app logger
- antiban metrics can be exposed on a separate Prometheus endpoint (default port 9108)
- command executions, message failures, bot sessions, and raw event classes are persisted to MySQL for audit/troubleshooting

### Media and stickers

Sticker/media support is deeper than a single command.

- `src/utils/sticker.ts` and `src/utils/sticker-convert.ts` handle transformation logic.
- `processor.ts` can resolve sticker source media from the current message, quoted message, recent in-memory messages, or locally downloaded media recorded in SQL.
- `sql-store.ts` persists sticker templates and generated sticker metadata for later reuse.
- Optional automatic incoming media download is controlled by `WA_MEDIA_AUTO_DOWNLOAD` and related storage limits.

## Test shape

The test suite is broad and organized mostly by subsystem, not by feature folders.

Notable coverage areas under `tests/`:

- auth backends
- router / command runtime
- event registration
- store layers (Baileys/Redis/SQL/cache)
- history sync
- sticker/media flows
- raw SQL query fixtures in `tests/queries/`

When changing store/event/auth logic, run the nearest subsystem test file first, then the full suite if the change is broad.

## Important files to read first for common tasks

- **Boot / reconnect issues**: `src/index.ts`, `src/bootstrap/start.ts`, `src/core/connection/socket.ts`
- **Baileys event behavior**: `src/events/register.ts`
- **Command behavior**: `src/core/command-runtime/processor.ts`, `src/core/command-runtime/context.ts`, `src/commands/`
- **Persistence / schema-facing work**: `src/store/sql-store.ts`, `src/core/db/init.ts`, `src/core/db/backfill.ts`
- **Caching / read-through store behavior**: `src/store/baileys-store.ts`, `src/store/redis-store.ts`
- **Group feature flags / antilink config**: `src/store/group-feature-store.ts`
- **Environment surface area**: `.env.example`, `src/config/index.ts`

## External docs in this repo worth consulting

- `README.md` — operational overview and main setup paths
- `docs/README-COMMANDS.md` — command-platform architecture and data model overview
- `docs/wiki/` — repo wiki mirrored into the codebase

## CI facts

GitHub Actions in `.github/workflows/test.yml` runs, in order:

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run build`
5. `npm test`
6. Docker image build

If you want to match CI confidence locally for a broad change, run that same sequence.
