# Zyra System

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PM2 Ready](https://img.shields.io/badge/pm2-ready-2B037A?logo=pm2&logoColor=white)](https://pm2.keymetrics.io/)

Motor de bot para WhatsApp construído com [Baileys](https://github.com/WhiskeySockets/Baileys), com foco em operação multi-instância, persistência híbrida, observabilidade e execução segura em produção.

O projeto foi desenhado para manter sessões resilientes, auditar eventos do WhatsApp, processar comandos modulares e operar com múltiplas conexões isoladas por `connection_id`.

## Sumário

- [Visão Geral](#visão-geral)
- [Principais Capacidades](#principais-capacidades)
- [Arquitetura](#arquitetura)
- [Pré-requisitos](#pré-requisitos)
- [Instalação](#instalação)
- [Configuração](#configuração)
- [Como Executar](#como-executar)
- [API REST e Webhooks](#api-rest-e-webhooks)
- [Comandos de Desenvolvimento](#comandos-de-desenvolvimento)
- [Docker](#docker)
- [Produção com PM2](#produção-com-pm2)
- [Manutenção e Banco](#manutenção-e-banco)
- [Documentação](#documentação)
- [Contribuidores](#contribuidores)
- [Licença](#licença)

## Visão Geral

O Zyra combina cinco responsabilidades principais em uma única plataforma:

- conexão e autenticação de sessões WhatsApp via Baileys
- persistência de estado e auditoria em MySQL, Redis e disco
- execução de comandos desacoplados do transporte
- API REST e dashboard para operações remotas e automação externa
- suporte operacional para produção, incluindo backfill, logs estruturados e métricas do antiban

A aplicação suporta tanto uso local simples quanto cenários distribuídos com múltiplas instâncias compartilhando infraestrutura.

## Principais Capacidades

- **Boot multi-conexão nativo** com várias sessões ativas no mesmo processo e isolamento por `connection_id`
- **Persistência híbrida** com prioridade para MySQL, Redis e fallback local em disco
- **Arquitetura modular de comandos** com `CommandContext` e camada de runtime dedicada
- **Store de alta performance** para chats, contatos, grupos e mensagens
- **Identidade unificada** com reconciliação entre JID, PN, LID e aliases
- **Auditoria completa** de eventos, mensagens, comandos, grupos, newsletters e falhas
- **Backfill contínuo** para completar colunas derivadas e reparar consistência histórica
- **Proteção antiban** com warm-up persistente, detecção de sessão surda e endpoint de métricas
- **Suporte a newsletters/canais** com snapshot, eventos, participantes e refresh de mídia
- **API REST operacional** com health checks, runtime profile, dashboard web e gerenciamento remoto de conexões

## Arquitetura

### Fluxo principal

1. `src/index.ts` carrega o ambiente, valida a configuração e inicia o bootstrap.
2. `src/bootstrap/start.ts` garante schema MySQL, resolve quais conexões devem subir e gerencia ciclo de socket/reconexão por conexão.
3. `src/core/connection/socket.ts` cria o socket Baileys com auth, store, antiban e shutdown gracioso.
4. `src/events/register.ts` registra os handlers centrais dos eventos do WhatsApp.
5. `src/router/index.ts` enfileira o processamento por chat.
6. `src/core/command-runtime/processor.ts` aplica regras transversais, executa comandos e registra auditoria.

### Camadas principais

- **Connection/Auth**: criação do socket, estratégia de autenticação, persistência de credenciais e reconexão
- **Events**: ingestão centralizada de eventos do Baileys, incluindo grupos, mensagens, blocklist e newsletters
- **Store/Persistência**: cache em memória com expansão opcional para Redis e MySQL
- **Commands**: runtime desacoplado do socket bruto, com contexto estável para os comandos

### Estratégia de persistência

O projeto separa claramente dois tipos de persistência:

- **Sessão/Auth**: credenciais e chaves do Signal para manter a conta conectada
- **Domínio/Auditoria**: mensagens, chats, grupos, eventos, labels, blocklist, stickers, newsletters e métricas operacionais

Prioridade de auth:

1. MySQL
2. Redis
3. Disco local

Para estado operacional, a leitura normalmente segue:

1. memória
2. Redis
3. MySQL

### Multi-instância

O sistema é orientado por `connection_id`.

Isso afeta:

- sessão autenticada
- chaves Redis
- dados e auditoria no MySQL
- checkpoints do backfill
- configuração por grupo
- mapeamento de identidade

Recursos novos devem preservar esse isolamento.

## Pré-requisitos

- **Node.js**: 20 ou superior
- **npm**: gerenciador padrão do projeto
- **MySQL 8.0+**: recomendado para persistência durável e recursos de auditoria
- **Redis 6.0+**: recomendado para cache quente e performance

## Instalação

### 1. Clonar o repositório

```bash
git clone https://github.com/kaikybrofc/zyra.git
cd zyra
```

### 2. Instalar dependências

```bash
npm install
```

Para reproduzir o ambiente da CI com mais fidelidade:

```bash
npm ci
```

### 3. Observação sobre dependências

O projeto não depende mais de pacotes privados para instalação padrão.

Se `npm install` ou `npm ci` falhar, trate como falha local de rede, cache ou resolução de dependências públicas.

## Configuração

Crie o arquivo `.env` a partir do exemplo:

```bash
cp .env.example .env
```

Variáveis centrais:

- `WA_CONNECTION_ID`: identificador lógico para boot simples de uma sessão ou fallback legado
- `WA_CONNECTION_IDS`: lista CSV para subir várias conexões no mesmo processo
- `MYSQL_URL`: persistência SQL, auditoria e descoberta automática via `auth_creds`
- `WA_REDIS_URL`: cache quente e apoio à store/auth
- `WA_AUTH_DIR`: diretório local de fallback para sessão
- `WA_COMMAND_PREFIX`: prefixo de comandos
- `WA_ANTIBAN_ENABLED`: ativa proteção antiban
- `WA_MEDIA_AUTO_DOWNLOAD`: baixa mídias recebidas para disco
- `WA_API_ENABLED`: habilita o servidor HTTP da API REST
- `WA_API_HOST` e `WA_API_PORT`: host/porta de bind da API
- `WA_API_KEY`: exige `Authorization: Bearer <chave>` quando definida
- `WA_BOOTSTRAP_CONNECTIONS_ENABLED`: define se este processo também gerencia sockets/conexões
- `WA_WEBHOOK_SHARED_SECRET`: ativa autenticação HMAC do ingress `POST /webhooks/connections`
- `WA_WEBHOOK_ALLOWED_TARGETS`: lista CSV de URLs permitidas para webhooks de saída

### Estratégia de startup das conexões

O processo principal resolve quais conexões devem subir nesta ordem:

1. `WA_CONNECTION_IDS` — override explícito em CSV
2. descoberta automática no MySQL via `auth_creds`
3. fallback legado para `WA_CONNECTION_ID`

Isso permite operar de três formas:

- **simples**: uma sessão fixa com `WA_CONNECTION_ID=default`
- **multi-conexão explícita**: uma lista como `WA_CONNECTION_IDS=default,loja1,loja2`
- **descoberta automática**: com `MYSQL_URL` configurado e sem `WA_CONNECTION_IDS`, o bootstrap recupera os `connection_id` já persistidos em `auth_creds`

Depois da configuração inicial do banco:

```bash
npm run db:init
```

## Como Executar

### Desenvolvimento

```bash
npm run dev
```

### Execução simples sem watch

```bash
npm run start
```

### Produção

```bash
npm run build
npm run start:prod
```

### Exemplos de uso

#### 1. Uma conexão explícita

```env
WA_CONNECTION_ID=default
MYSQL_URL=mysql://user:pass@127.0.0.1:3306/zyra
WA_REDIS_URL=redis://127.0.0.1:6379
```

Use esse modo quando quiser um processo principal subindo apenas uma sessão lógica.

#### 2. Múltiplas conexões explícitas no mesmo processo

```env
WA_CONNECTION_IDS=default,loja1,loja2
MYSQL_URL=mysql://user:pass@127.0.0.1:3306/zyra
WA_REDIS_URL=redis://127.0.0.1:6379
```

Nesse modo, o processo `zyra` sobe todas as conexões listadas e mantém reconexão isolada por `connection_id`.

#### 3. Descoberta automática via `auth_creds`

```env
MYSQL_URL=mysql://user:pass@127.0.0.1:3306/zyra
WA_REDIS_URL=redis://127.0.0.1:6379
# WA_CONNECTION_IDS ausente
# WA_CONNECTION_ID usado apenas como fallback se nenhuma sessão for encontrada
```

Esse modo é útil quando as sessões já foram persistidas no MySQL e você quer que o bootstrap descubra automaticamente quais conexões devem subir.

## API REST e Webhooks

### Habilitação básica

```env
WA_API_ENABLED=true
WA_API_HOST=0.0.0.0
WA_API_PORT=3000
# WA_API_KEY=sua-chave-secreta
```

Quando `WA_API_KEY` estiver definida, os endpoints protegidos exigem:

```http
Authorization: Bearer sua-chave-secreta
```

Exceções: `GET /health/*` e `POST /webhooks/connections` usam fluxo operacional próprio e não dependem de `WA_API_KEY`.

### Endpoints principais

| Método | Rota | Uso |
|---|---|---|
| `GET` | `/dashboard` | Interface web para operações de conexão/webhook |
| `GET` | `/system/runtime` | Perfil do processo (`full`, `connections-only`, `api-webhook`, `stateless`) |
| `GET` | `/health/live` | Liveness para orquestradores |
| `GET` | `/health/ready` | Readiness de MySQL/Redis/control-plane |
| `GET` | `/health/connections` | Resumo dos estados por `connection_id` |
| `POST` | `/connections` | Criar instância |
| `POST` | `/connections/:id/connect` | Iniciar conexão (gera QR) |
| `GET` | `/connections/:id/qr` | Ler QR atual |
| `GET` | `/connections/:id/status` | Estado resumido (`created`, `connecting`, `qr`, `open`, `closed`, `error`) |
| `POST` | `/connections/:id/messages/send` | Enviar texto/mídia |
| `GET` | `/connections/:id/groups` | Listar grupos da instância |
| `POST` | `/connections/:id/webhooks` | Cadastrar webhook da instância |
| `POST` | `/webhooks` | Cadastrar webhook global (todas as instâncias) |
| `POST` | `/webhooks/connections` | Ingress assinado por HMAC para comandos de conexão |

### Modo managed (API separada do processo de conexões)

Com `WA_BOOTSTRAP_CONNECTIONS_ENABLED=false`, o processo atende API/webhooks, mas não controla sockets locais.

Nesse modo:

- `POST /connections/:id/connect`, `disconnect`, `restart` e endpoints de pairing retornam `409`
- `POST /connections/:id/webhook/start` passa a ser o caminho recomendado para iniciar conexão
- `GET /connections`, `GET /connections/:id` e `GET /system/runtime` continuam disponíveis

### Segurança do ingress de conexões

O endpoint `POST /webhooks/connections` usa assinatura HMAC SHA-256 sobre `${timestamp}.${rawBody}`.

Variáveis relacionadas:

```env
WA_WEBHOOK_SHARED_SECRET=troque-este-segredo
WA_WEBHOOK_MAX_BODY_BYTES=262144
WA_WEBHOOK_TIMESTAMP_TOLERANCE_MS=300000
```

Para payloads completos, exemplos `curl` e coleção Postman, veja a seção [Documentação](#documentação).

## Comandos de Desenvolvimento

### Qualidade

```bash
npm run lint
npm run lint:fix
npm run typecheck
npm test
npm run test:watch
```

### Rodar testes específicos

```bash
npx vitest run tests/router.test.ts
npx vitest run tests/router.test.ts -t "nome do teste"
npx vitest watch tests/router.test.ts
```

### O que a CI executa

O workflow de testes roda esta sequência:

```bash
npm ci
npm run typecheck
npm run lint
npm run build
npm test
```

Se a alteração for ampla, esse é o melhor smoke test local.

## Docker

O repositório inclui `Dockerfile` multi-stage e `docker-compose.yml` com:

- `zyra` — aplicação principal
- `backfill` — worker de backfill
- `mysql` — MySQL 8
- `redis` — Redis 7

### Build da imagem

Build local da imagem:

```bash
DOCKER_BUILDKIT=1 docker build -t zyra:local .
```

### Subir a stack

```bash
docker compose up -d --build
```

### Logs e status

```bash
docker compose ps
docker compose logs -f zyra
docker compose logs -f backfill
```

### Parar a stack

```bash
docker compose down
```

Observações:

- sessões e mídias são persistidas no volume `zyra-data`
- as métricas do antiban ficam expostas na porta `9108`
- o serviço `zyra` pode subir uma única sessão com `WA_CONNECTION_ID` ou várias sessões com `WA_CONNECTION_IDS`
- sem `WA_CONNECTION_IDS`, a stack pode descobrir conexões já persistidas em `auth_creds` quando `MYSQL_URL` estiver configurado
- para expor a API REST via Docker, habilite `WA_API_ENABLED=true` e publique a porta `3000:3000`

## Produção com PM2

O ecossistema PM2 sobe três processos:

- `zyra` (conexões/sockets)
- `zyra-api-webhook` (API REST, dashboard e workers de webhook)
- `zyra-backfill`

Comandos principais:

```bash
npm run pm2:start
npm run pm2:restart
npm run pm2:logs
npm run pm2:stop
npm run pm2:delete
npm run pm2:save
npm run pm2:startup
npm run session:pair -- --connection loja2
```

Fluxo recomendado para manter o serviço persistente no servidor:

```bash
npm run pm2:start
npm run pm2:save
npm run pm2:startup
```

Notas operacionais:

- o processo `zyra` pode manter múltiplas sessões ativas ao mesmo tempo
- o processo `zyra-api-webhook` roda com `WA_BOOTSTRAP_CONNECTIONS_ENABLED=false` e atua como control-plane HTTP
- prefira `WA_CONNECTION_IDS` quando quiser controle explícito do conjunto de sessões
- prefira descoberta via MySQL quando `auth_creds` já for a fonte de verdade das sessões persistidas
- para parear uma nova conta via QR no terminal, use `npm run session:pair -- --connection <id>`
- após o pairing, reinicie o PM2 para o boot redescobrir a nova sessão via `auth_creds`
- se quiser esse fluxo dinâmico, deixe `WA_CONNECTION_IDS` ausente no processo principal
- logs e métricas passam a representar o runtime agregado do processo, com snapshots por `connection_id`

## Manutenção e Banco

Scripts utilitários disponíveis:

```bash
npm run db:init
npm run db:verify
npm run db:delete-session -- --connection loja2
npm run db:backfill
npm run db:repair-group-participants
npm run db:nulls
```

### Backfill

O backfill é parte importante da arquitetura operacional.

Ele preenche colunas derivadas, reconcilia identidades, repara relacionamentos e completa dados históricos após evolução de schema ou gravações parciais.

Para rodar apenas uma passada:

```bash
WA_BACKFILL_ONCE=true npm run db:backfill
```

## Documentação

### Wiki local do projeto

- [Home da Wiki](docs/wiki/Home.md)
- [Instalação](docs/wiki/Instalação.md)
- [Configuração](docs/wiki/Configuração.md)
- [Comandos](docs/wiki/Comandos.md)
- [Eventos](docs/wiki/Eventos.md)
- [Produção](docs/wiki/Produção.md)
- [Troubleshooting](docs/wiki/Troubleshooting.md)
- [Banco de Dados](docs/wiki/Banco-de-Dados.md)
- [Persistência](docs/wiki/Persistência.md)
- [Backfill](docs/wiki/Backfill.md)

### Guias complementares

- [Arquitetura de comandos e visão técnica](docs/README-COMMANDS.md)
- [Guia da API REST (endpoints, payloads e fluxo completo)](docs/README-API.md)
- [Guia de Webhooks (filtros, assinaturas e retentativas)](docs/README-WEBHOOKS.md)
- [Coleção Postman da API](docs/zyra-api.postman_collection.json)

## Contribuidores

- **@kaikybrofc** — mantenedor do projeto
- **@kobie3717** — integração do `baileys-antiban`

## Licença

Este projeto está licenciado sob a **MIT License**.

Consulte [LICENSE](LICENSE) para detalhes.
