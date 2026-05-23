# Produção

Esta página documenta o modelo operacional recomendado para executar o Zyra em produção, seja com PM2 ou com Docker Compose.

## Topologia recomendada

### PM2

O ecossistema PM2 do projeto sobe dois processos:

- `zyra` — runtime principal do bot
- `zyra-backfill` — worker contínuo de backfill

Esses processos são definidos em `ecosystem.config.cjs`.

### Docker Compose

A stack padrão inclui:

- `zyra`
- `backfill`
- `mysql`
- `redis`

Essa topologia está definida em `docker-compose.yml`.

## Dependências reais de produção

Para operação estável, o ambiente precisa de:

- MySQL estável e monitorado
- Redis recomendado para melhor performance
- disco com capacidade para logs e, se habilitado, mídia local
- estratégia clara de boot: `WA_CONNECTION_IDS`, descoberta em `auth_creds` ou fallback `WA_CONNECTION_ID`
- proteção adequada para `.env`, portas de health e métricas

## Estratégia de boot em produção

O processo principal `zyra` pode subir uma ou várias sessões no mesmo runtime.

A prioridade de resolução é:

1. `WA_CONNECTION_IDS`
2. descoberta automática no MySQL via `auth_creds`
3. `WA_CONNECTION_ID`

Recomendações práticas:

- use `WA_CONNECTION_IDS` quando quiser controlar exatamente quais sessões o processo deve subir
- use descoberta automática quando o MySQL já for a fonte de verdade das sessões persistidas
- mantenha `WA_CONNECTION_ID` como modo simples ou fallback operacional
- em qualquer modo, logs, reconnect e métricas passam a representar múltiplos `connection_id` dentro do mesmo processo

## Fluxo de deploy com PM2

Exemplo comum:

```bash
git pull
npm install
npm run pm2:restart
```

`pm2:restart` já recompila o projeto antes de reiniciar os processos.

Em restart/deploy, o conjunto de sessões sobe de acordo com a estratégia ativa no ambiente naquele momento. Se você usa `WA_CONNECTION_IDS`, o resultado do restart acompanha exatamente a lista informada; se usa descoberta automática, o processo reabre as sessões presentes em `auth_creds`.

## Comandos operacionais com PM2

```bash
npm run pm2:start
npm run pm2:restart
npm run pm2:logs
npm run pm2:stop
npm run pm2:delete
npm run pm2:save
npm run pm2:startup
```

Para parear uma nova conexão via QR no terminal:

```bash
npm run session:pair -- --connection loja2
npm run pm2:restart
```

Para remover uma conexão específica sem trocar `WA_CONNECTION_ID` no ambiente:

```bash
npm run db:delete-session -- --connection loja2
```

Fluxo recomendado para persistência no boot do servidor:

```bash
npm run pm2:start
npm run pm2:save
npm run pm2:startup
```

Se a operação precisar adicionar sessões novas por QR sem editar a lista manualmente, mantenha o processo principal em modo de descoberta MySQL, sem `WA_CONNECTION_IDS` fixo.

## Fluxo com Docker Compose

### Subir a stack

```bash
docker compose up -d --build
```

### Ver estado e logs

```bash
docker compose ps
docker compose logs -f zyra
docker compose logs -f backfill
```

### Parar a stack

```bash
docker compose down
```

## Logs, métricas e health

### Logs

A operação depende de logs estruturados e arquivos rotativos. Em cenários típicos, acompanhe:

- logs de aplicação
- logs de aviso
- logs de erro

Esses artefatos são fundamentais para troubleshooting após restart, falha de conexão ou degradação operacional.

### Métricas

Quando habilitadas, as métricas do antiban ficam expostas em endpoint dedicado, separado do health. O padrão de produção já usa a porta `9108`.

No modo multi-conexão, o endpoint operacional expõe séries e snapshots por `connection_id`, permitindo acompanhar sockets ativos e reconnects isoladamente dentro do mesmo processo.

### Health

O endpoint de health pode ser habilitado por configuração e deve ser protegido/monitorado conforme a topologia do ambiente.

## Checklist operacional mínimo

### Antes de considerar o ambiente saudável

- processos PM2 ou serviços Docker estão ativos
- build TypeScript atual sobe sem erro
- MySQL responde normalmente
- Redis está acessível quando configurado
- logs não mostram burst contínuo de exceções
- métricas e health respondem quando habilitados
- backfill está em execução normal

## Rotinas recomendadas

- backup recorrente do MySQL
- revisão de uso de disco em `logs/` e `data/media`
- acompanhamento do restart count no PM2
- revisão de falhas recorrentes em comando, mídia e auth
- validação periódica com `npm run db:verify`

## Hardening mínimo

- operar atrás de firewall
- evitar execução como root quando possível
- restringir permissões do `.env`
- monitorar portas de métricas e health
- manter segredos fora do código e fora de logs

## Leituras relacionadas

- [Configuração](Configuração)
- [Persistência](Persistência)
- [Backfill](Backfill)
- [Troubleshooting](Troubleshooting)

---

**Zyra Wiki** • Última atualização: 17/05/2026