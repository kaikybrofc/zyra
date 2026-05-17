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
- `WA_CONNECTION_ID` único por instância lógica
- proteção adequada para `.env`, portas de health e métricas

## Fluxo de deploy com PM2

Exemplo comum:

```bash
git pull
npm install
npm run pm2:restart
```

`pm2:restart` já recompila o projeto antes de reiniciar os processos.

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

Fluxo recomendado para persistência no boot do servidor:

```bash
npm run pm2:start
npm run pm2:save
npm run pm2:startup
```

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