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
- [Comandos de Desenvolvimento](#comandos-de-desenvolvimento)
- [Docker](#docker)
- [Produção com PM2](#produção-com-pm2)
- [Manutenção e Banco](#manutenção-e-banco)
- [Documentação](#documentação)
- [Contribuidores](#contribuidores)
- [Licença](#licença)

## Visão Geral

O Zyra combina quatro responsabilidades principais em uma única plataforma:

- conexão e autenticação de sessões WhatsApp via Baileys
- persistência de estado e auditoria em MySQL, Redis e disco
- execução de comandos desacoplados do transporte
- suporte operacional para produção, incluindo backfill, logs estruturados e métricas do antiban

A aplicação suporta tanto uso local simples quanto cenários distribuídos com múltiplas instâncias compartilhando infraestrutura.

## Principais Capacidades

- **Multi-instância nativa** com isolamento por `WA_CONNECTION_ID`
- **Persistência híbrida** com prioridade para MySQL, Redis e fallback local em disco
- **Arquitetura modular de comandos** com `CommandContext` e camada de runtime dedicada
- **Store de alta performance** para chats, contatos, grupos e mensagens
- **Identidade unificada** com reconciliação entre JID, PN, LID e aliases
- **Auditoria completa** de eventos, mensagens, comandos, grupos, newsletters e falhas
- **Backfill contínuo** para completar colunas derivadas e reparar consistência histórica
- **Proteção antiban** com warm-up persistente, detecção de sessão surda e endpoint de métricas
- **Suporte a newsletters/canais** com snapshot, eventos, participantes e refresh de mídia

## Arquitetura

### Fluxo principal

1. `src/index.ts` carrega o ambiente, valida a configuração e inicia o bootstrap.
2. `src/bootstrap/start.ts` garante schema MySQL, gerencia ciclo de socket e reconexão.
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

### 3. Observação sobre dependência privada

O projeto utiliza o pacote `@kaikybrofc/logger-module` via GitHub Packages.

Se a instalação falhar nessa dependência, verifique autenticação no registry do GitHub antes de prosseguir.

## Configuração

Crie o arquivo `.env` a partir do exemplo:

```bash
cp .env.example .env
```

Variáveis centrais:

- `WA_CONNECTION_ID`: identificador lógico da instância
- `MYSQL_URL`: persistência SQL e auditoria
- `WA_REDIS_URL`: cache quente e apoio à store/auth
- `WA_AUTH_DIR`: diretório local de fallback para sessão
- `WA_COMMAND_PREFIX`: prefixo de comandos
- `WA_ANTIBAN_ENABLED`: ativa proteção antiban
- `WA_MEDIA_AUTO_DOWNLOAD`: baixa mídias recebidas para disco

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

O build usa secret para autenticar no GitHub Packages:

```bash
export NPM_TOKEN=seu_token_aqui
DOCKER_BUILDKIT=1 docker build --secret id=npm_token,env=NPM_TOKEN -t zyra:local .
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

## Produção com PM2

O ecossistema PM2 sobe dois processos:

- `zyra`
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
```

Fluxo recomendado para manter o serviço persistente no servidor:

```bash
npm run pm2:start
npm run pm2:save
npm run pm2:startup
```

## Manutenção e Banco

Scripts utilitários disponíveis:

```bash
npm run db:init
npm run db:verify
npm run db:delete-session
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

## Contribuidores

- **@kaikybrofc** — mantenedor do projeto
- **@kobie3717** — integração do `baileys-antiban`

## Licença

Este projeto está licenciado sob a **MIT License**.

Consulte [LICENSE](LICENSE) para detalhes.
