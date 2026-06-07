# Zyra System

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PM2 Ready](https://img.shields.io/badge/pm2-ready-2B037A?logo=pm2&logoColor=white)](https://pm2.keymetrics.io/)

## Aviso legal

Este projeto não possui qualquer afiliação, associação, autorização, endosso ou vínculo oficial com o WhatsApp ou com a Meta Platforms, Inc. O Zyra é um projeto open source criado para fins de estudo, pesquisa e experimentação técnica.

Não incentivamos, apoiamos ou autorizamos o uso deste software para spam, abuso, fraude, violação de privacidade, automação indevida, evasão de limites, engenharia social ou qualquer atividade ilegal. O uso do projeto é de responsabilidade exclusiva de quem o executa, devendo respeitar leis aplicáveis, termos de serviço das plataformas envolvidas e boas práticas de segurança.

Motor de bot para WhatsApp construído com [Baileys](https://github.com/WhiskeySockets/Baileys), com foco em operação multi-instância, persistência híbrida, observabilidade e execução segura em produção.

O projeto foi desenhado para manter sessões resilientes, auditar eventos do WhatsApp, processar comandos modulares e operar com múltiplas conexões isoladas por `connection_id`.

## Sumário

- [Aviso legal](#aviso-legal)
- [Visão Geral](#visão-geral)
- [Principais Capacidades](#principais-capacidades)
- [Arquitetura](#arquitetura)
- [Pré-requisitos](#pré-requisitos)
- [Início Rápido](#início-rápido)
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

## Início Rápido

Este fluxo sobe o bot, a API REST, o dashboard e os workers de webhook no mesmo processo. Use em desenvolvimento, homologação ou em uma instalação simples.

```bash
cp .env.example .env
npm install
```

Edite o `.env` com os valores mínimos:

```env
WA_CONNECTION_ID=default
MYSQL_URL=mysql://user:pass@127.0.0.1:3306/zyra
WA_REDIS_URL=redis://127.0.0.1:6379

WA_API_ENABLED=true
WA_API_HOST=0.0.0.0
WA_API_PORT=3000
WA_API_KEY=sua-chave-secreta
WA_BOOTSTRAP_CONNECTIONS_ENABLED=true

WA_WEBHOOK_SHARED_SECRET=troque-este-segredo
WA_WEBHOOK_ALLOWED_TARGETS=https://seu-sistema.com/webhook
WA_WEBHOOK_RETRY_ENABLED=true
WA_WEBHOOK_OUTBOX_ENABLED=true
```

Inicialize o schema e suba tudo em modo desenvolvimento:

```bash
npm run db:init
npm run dev
```

Depois acesse o dashboard em:

```text
http://localhost:3000/dashboard
```

Fluxo mínimo pela API:

```bash
BASE="http://localhost:3000"
TOKEN="sua-chave-secreta"
ID="default"

curl -s -X POST "$BASE/connections" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"connectionId\":\"$ID\",\"label\":\"Bot Principal\"}"

curl -s -X POST "$BASE/connections/$ID/connect" \
  -H "Authorization: Bearer $TOKEN"

curl -s "$BASE/connections/$ID/qr" \
  -H "Authorization: Bearer $TOKEN"

curl -s "$BASE/connections/$ID/status" \
  -H "Authorization: Bearer $TOKEN"
```

Quando o status estiver `open`, envie uma mensagem:

```bash
curl -s -X POST "$BASE/connections/$ID/messages/send" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "type": "text",
    "to": "5511999999999@s.whatsapp.net",
    "text": "Mensagem enviada via API do Zyra."
  }'
```

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
- `WA_ANTIBAN_PRESET`: preset base da lib (`conservative`, `moderate`, `aggressive`, `high-volume`)
- `WA_ANTIBAN_GROUP_OP_GUARD_ENABLED`: limita operações sensíveis de grupo, como add/remove/create/invite
- `WA_ANTIBAN_LEGITIMACY_SIGNALS_ENABLED`: ativa sinais humanos da lib, como pausas e variações de envio
- `WA_ANTIBAN_INSTANCE_COORDINATOR_ENABLED`: coordena limites agregados em multi-conexões/processos
- `WA_MEDIA_AUTO_DOWNLOAD`: baixa mídias recebidas para disco
- `WA_API_ENABLED`: habilita o servidor HTTP da API REST
- `WA_API_HOST` e `WA_API_PORT`: host/porta de bind da API
- `WA_API_KEY`: exige `Authorization: Bearer <chave>` quando definida
- `WA_API_MEDIA_DIR`: diretório local para arquivos enviados via `POST /media`
- `WA_API_MEDIA_MAX_BYTES`: tamanho máximo por upload em bytes
- `WA_BOOTSTRAP_CONNECTIONS_ENABLED`: define se este processo também gerencia sockets/conexões
- `WA_WEBHOOK_SHARED_SECRET`: ativa autenticação HMAC do ingress `POST /webhooks/connections` e permite `POST /connections/:id/webhook/start`
- `WA_WEBHOOK_ALLOWED_TARGETS`: lista CSV de URLs permitidas para webhooks de saída; a URL cadastrada precisa existir exatamente nessa lista
- `WA_WEBHOOK_RETRY_ENABLED`: liga o worker legado de retentativas da tabela `webhook_deliveries`
- `WA_WEBHOOK_OUTBOX_ENABLED`: liga o worker/outbox de eventos administrativos de webhook
- `WA_WEBHOOK_TIMEOUT_MS` e `WA_WEBHOOK_MAX_ATTEMPTS`: controlam timeout e tentativas de entrega de webhooks

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

### Desenvolvimento local

```bash
npm run dev
```

Com `WA_API_ENABLED=true`, o mesmo processo expõe a API e o dashboard em `http://localhost:<WA_API_PORT>`. Com `WA_BOOTSTRAP_CONNECTIONS_ENABLED=true`, ele também gerencia os sockets WhatsApp em memória.

### Execução simples sem watch

```bash
npm run start
```

### Build e produção manual

```bash
npm run build
npm run start:prod
```

### Iniciar tudo com PM2

```bash
npm run pm2:start
npm run pm2:logs
```

O `ecosystem.config.cjs` inicia:

- `zyra`: processo de conexões/sockets, com API habilitada em `127.0.0.1:3021` por padrão do PM2
- `zyra-api-webhook`: control-plane HTTP, dashboard e workers de webhook, sem gerenciar sockets locais; usa `WA_API_PORT` do `.env` ou `3000` quando não definido
- `zyra-backfill`: worker contínuo de backfill do banco

Como o `.env` é carregado no boot, valores que não estiverem sobrescritos no `ecosystem.config.cjs` continuam vindo do `.env`. Mantenha o `WA_API_PORT` do `.env` diferente de `3021` se for usar o processo `zyra-api-webhook` junto com o processo `zyra`.

Após validar a subida:

```bash
npm run pm2:save
npm run pm2:startup
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

### Base, dashboard e autenticação

Habilite a API no `.env`:

```env
WA_API_ENABLED=true
WA_API_HOST=0.0.0.0
WA_API_PORT=3000
WA_API_KEY=sua-chave-secreta
```

Com isso, a base local fica em `http://localhost:3000` e o dashboard em:

```text
http://localhost:3000/dashboard
```

Quando `WA_API_KEY` estiver definida, todos os endpoints protegidos exigem:

```http
Authorization: Bearer sua-chave-secreta
```

Exceções:

- `GET /health/*`: health checks operacionais
- `POST /webhooks/connections`: ingress de comandos com autenticação HMAC própria

### Endpoints principais

| Método | Rota                                                   | Uso                                                                         |
| ------ | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `GET`  | `/dashboard`                                           | Interface web para conexões, QR, mensagens e webhooks                       |
| `GET`  | `/system/runtime`                                      | Perfil do processo (`full`, `connections-only`, `api-webhook`, `stateless`) |
| `GET`  | `/health/live`                                         | Liveness para orquestradores                                                |
| `GET`  | `/health/ready`                                        | Readiness de MySQL, Redis e control-plane                                   |
| `GET`  | `/health/connections`                                  | Resumo de estados por `connection_id`                                       |
| `POST` | `/connections`                                         | Criar instância                                                             |
| `GET`  | `/connections`                                         | Listar instâncias                                                           |
| `GET`  | `/connections/:id`                                     | Detalhar instância                                                          |
| `PATCH` | `/connections/:id`                                     | Atualizar label                                                             |
| `POST` | `/connections/:id/connect`                             | Iniciar conexão diretamente no processo atual                               |
| `POST` | `/connections/:id/webhook/start`                       | Iniciar conexão via ingress HMAC local                                      |
| `GET`  | `/connections/:id/qr`                                  | Ler QR atual                                                                |
| `GET`  | `/connections/:id/status`                              | Estado resumido (`created`, `connecting`, `qr`, `open`, `closed`, `error`)  |
| `POST` | `/connections/:id/messages/send`                       | Enviar texto, mídia ou payload Baileys bruto                                |
| `GET`  | `/connections/:id/messages`                            | Histórico de mensagens enviadas pela API                                    |
| `GET`  | `/connections/:id/messages/:messageId`                 | Status de mensagem enviada pela API                                         |
| `POST` | `/media`                                               | Upload de mídia para reutilizar no envio via `mediaId`                      |
| `GET`  | `/connections/:id/groups`                              | Listar grupos da instância                                                  |
| `POST` | `/connections/:id/groups/:groupJid/admin`              | Ações administrativas em grupo                                              |
| `POST` | `/connections/:id/webhooks`                            | Criar webhook específico da instância                                       |
| `POST` | `/webhooks`                                            | Criar webhook global para todas as instâncias                               |
| `POST` | `/webhooks/connections`                                | Receber comandos administrativos assinados por HMAC                         |

### Fluxo de conexão via API

```bash
BASE="http://localhost:3000"
TOKEN="sua-chave-secreta"
ID="minha-sessao"

curl -s -X POST "$BASE/connections" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"connectionId\":\"$ID\",\"label\":\"Bot Principal\"}"

curl -s -X POST "$BASE/connections/$ID/connect" \
  -H "Authorization: Bearer $TOKEN"

curl -s "$BASE/connections/$ID/qr" \
  -H "Authorization: Bearer $TOKEN"

curl -s "$BASE/connections/$ID/status" \
  -H "Authorization: Bearer $TOKEN"
```

O QR pode ser lido pela API ou pelo dashboard. Depois que a conexão ficar `open`, envie mensagem:

```bash
curl -s -X POST "$BASE/connections/$ID/messages/send" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: pedido-123" \
  -d '{
    "type": "text",
    "clientMessageId": "pedido-123",
    "to": "5511999999999@s.whatsapp.net",
    "text": "Olá! Mensagem enviada pela API."
  }'
```

O envio aceita `clientMessageId` no body ou `Idempotency-Key` no header. Repetir a mesma chave com o mesmo payload retorna o resultado já registrado e evita envio duplicado.

Consulte histórico e status:

```bash
curl -s "$BASE/connections/$ID/messages?to=5511999999999@s.whatsapp.net&status=sent&limit=20" \
  -H "Authorization: Bearer $TOKEN"

curl -s "$BASE/connections/$ID/messages/pedido-123" \
  -H "Authorization: Bearer $TOKEN"
```

O endpoint de envio aceita atalhos (`text`, `image`, `video`, `audio`, `document`, `sticker`, `contacts`, `location`, `react`, `poll`, `event`, `forward`, `delete`, entre outros) e também `type: "raw"` para payloads nativos do Baileys. Use JIDs no formato `5511999999999@s.whatsapp.net` para contatos, `120363000000000000@g.us` para grupos e `status@broadcast` para status.

Para enviar mídia sem depender de URL externa, faça upload em JSON/base64 e use o `mediaId` retornado:

```bash
curl -s -X POST "$BASE/media" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "fileName": "foto.png",
    "mimetype": "image/png",
    "base64": "iVBORw0KGgo..."
  }'

curl -s -X POST "$BASE/connections/$ID/messages/send" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "type": "image",
    "to": "5511999999999@s.whatsapp.net",
    "mediaId": "media_xxxxx",
    "caption": "Arquivo enviado via POST /media"
  }'
```

### Webhooks de saída

Webhooks de saída notificam sistemas externos quando eventos do WhatsApp ou do ciclo administrativo acontecem. Configure destinos permitidos antes de cadastrar webhooks:

```env
WA_WEBHOOK_ALLOWED_TARGETS=https://seu-sistema.com/webhook,https://hooks.exemplo.com/zyra
WA_WEBHOOK_TIMEOUT_MS=10000
WA_WEBHOOK_MAX_ATTEMPTS=4
WA_WEBHOOK_RETRY_ENABLED=true
WA_WEBHOOK_OUTBOX_ENABLED=true
```

Por segurança, a URL enviada na API precisa existir exatamente em `WA_WEBHOOK_ALLOWED_TARGETS`.

Criar webhook para uma conexão:

```bash
curl -s -X POST "$BASE/connections/$ID/webhooks" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "url": "https://seu-sistema.com/webhook",
    "eventsFilter": ["messages.upsert", "connection.update"],
    "secret": "segredo-do-receptor"
  }'
```

Criar webhook global para todas as conexões:

```bash
curl -s -X POST "$BASE/webhooks" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "url": "https://hooks.exemplo.com/zyra",
    "eventsFilter": ["*"]
  }'
```

Eventos suportados incluem `connection.update`, `messages.upsert`, `messages.update`, `messages.delete`, `message-receipt.update`, `messages.reaction`, `groups.upsert`, `groups.update` e `group-participants.update`. O campo `eventsFilter` aceita eventos específicos, grupos (`connection`, `messages`, `groups`) ou `["*"]`.

O payload entregue ao receptor segue este envelope:

```json
{
  "event": "messages.upsert",
  "connectionId": "minha-sessao",
  "timestamp": 1716768000000,
  "data": {}
}
```

Quando o webhook tem `secret`, o Zyra envia `x-webhook-signature: sha256=<hmac-hex>`. O HMAC é calculado sobre o body bruto recebido pelo seu endpoint.

### Webhook de entrada para comandos de conexão

O endpoint `POST /webhooks/connections` recebe comandos administrativos assinados por HMAC. Ele é útil para automações externas e também é usado internamente pelo dashboard e por `POST /connections/:id/webhook/start`.

Configure:

```env
WA_WEBHOOK_SHARED_SECRET=troque-este-segredo
WA_WEBHOOK_MAX_BODY_BYTES=262144
WA_WEBHOOK_TIMESTAMP_TOLERANCE_MS=300000
```

Headers obrigatórios:

- `x-zyra-timestamp`: epoch em segundos ou milissegundos
- `x-zyra-signature`: HMAC SHA-256 de `${timestamp}.${rawBody}`
- `x-zyra-delivery-id`: ID único da entrega no sistema chamador

Payload base:

```json
{
  "event": "connection.command",
  "version": "2026-05-27",
  "command_id": "uuid-unico",
  "sent_at": "2026-05-29T18:00:00.000Z",
  "connection": {
    "id": "minha-sessao",
    "display_name": "Bot Principal"
  },
  "action": {
    "type": "start",
    "reason": "motivo-opcional"
  },
  "options": {
    "force": false
  }
}
```

Ações aceitas: `register`, `start`, `reconnect`, `disconnect`, `pause`, `resume`, `delete_soft`, `delete_hard`, `sync_status`, `pairing_start` e `pairing_cancel`.

Para iniciar pelo fluxo de webhook sem montar a assinatura manualmente, use o endpoint protegido por Bearer:

```bash
curl -s -X POST "$BASE/connections/$ID/webhook/start" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"label":"Bot Principal"}'
```

Esse endpoint exige `WA_WEBHOOK_SHARED_SECRET`, cria ou atualiza a conexão e despacha internamente um comando `start` assinado para `/webhooks/connections`.

### Modo API/Webhook separado do processo de conexões

Com `WA_BOOTSTRAP_CONNECTIONS_ENABLED=false`, o processo atende API, dashboard e webhooks, mas não controla sockets WhatsApp localmente. Nesse perfil:

- `POST /connections`, `GET /connections`, `GET /connections/:id`, `PATCH /connections/:id` e `DELETE /connections/:id` operam sobre o registro persistido
- `POST /connections/:id/connect`, `disconnect`, `restart` e endpoints de pairing retornam `409`
- `POST /connections/:id/webhook/start` é o caminho recomendado para pedir que o processo de conexões inicie a sessão
- `GET /system/runtime` mostra o perfil atual e as capacidades habilitadas

No PM2, esse é o papel do processo `zyra-api-webhook`; o processo `zyra` fica responsável pelos sockets/conexões.

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
- no PM2, `zyra` força `WA_API_PORT=3021`; deixe o `WA_API_PORT` do `.env` em outra porta para o `zyra-api-webhook`, como `3000`
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
- **@grazionale** — apoio no sistema de API
- **@kobie3717** — integração do `baileys-antiban`

## Licença

Este projeto está licenciado sob a **MIT License**.

Consulte [LICENSE](LICENSE) para detalhes.
