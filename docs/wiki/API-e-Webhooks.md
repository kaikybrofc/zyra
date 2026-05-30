# API e Webhooks

Guia completo para consumir a API REST e os endpoints de Webhook do Zyra.

## Pré-requisitos

No `.env`:

```env
WA_API_ENABLED=true
WA_API_HOST=0.0.0.0
WA_API_PORT=3000

# opcional (recomendado em produção)
WA_API_KEY=sua-chave

# obrigatório para /webhooks/connections e /connections/:id/webhook/start
WA_WEBHOOK_SHARED_SECRET=segredo-hmac

# obrigatório para cadastro/entrega de webhooks de saída
# (lista CSV exata de URLs permitidas)
WA_WEBHOOK_ALLOWED_TARGETS=https://meu-sistema.com/webhook,https://hooks.exemplo.com/zyra
```

Base URL local (exemplo): `http://localhost:3000`

## Autenticação

- Rotas REST: `Authorization: Bearer <WA_API_KEY>` quando `WA_API_KEY` estiver configurada.
- Exceção: `POST /webhooks/connections` usa autenticação HMAC própria (não usa Bearer).
- Dashboard (`/` e `/dashboard`) é servido sem Bearer.

## Padrão de respostas

- Erros seguem formato:

```json
{ "error": "mensagem" }
```

- Sucesso retorna JSON do recurso, exceto endpoints `204 No Content`.

## Estados de conexão

- `created`: criada, sem socket ativo.
- `connecting`: conectando.
- `qr`: aguardando leitura do QR.
- `open`: conectada/autenticada.
- `closed`: desconectada.
- `error`: falha de conexão.

## Endpoints de Conexão

### POST `/connections`

Cria uma instância sem conectar.

Body:

```json
{ "connectionId": "minha-sessao", "label": "Bot Suporte" }
```

Respostas:

- `201`: conexão criada.
- `400`: `connectionId é obrigatório`.
- `409`: `connectionId já existe`.

### GET `/connections`

Lista conexões (runtime + fallback managed).

Respostas:

- `200`: array de conexões.

### GET `/connections/:id`

Detalha uma conexão.

Respostas:

- `200`: conexão encontrada.
- `404`: `conexão não encontrada`.

### PATCH `/connections/:id`

Atualiza label.

Body:

```json
{ "label": "Novo nome" }
```

Para limpar:

```json
{ "label": null }
```

Respostas:

- `200`: conexão atualizada.
- `404`: `conexão não encontrada`.

### DELETE `/connections/:id`

Remove conexão.

Respostas:

- `204`: removida.
- `404`: `conexão não encontrada`.

### POST `/connections/:id/connect`

Alias: `POST /connections/:id/start`.

Inicia conexão/socket.

Respostas:

- `200`: conexão em `connecting`.
- `404`: `conexão não encontrada`.
- `409`: `operação indisponível neste processo (WA_BOOTSTRAP_CONNECTIONS_ENABLED=false)`.

### POST `/connections/:id/disconnect`

Desconecta.

Respostas:

- `200`: status atualizado.
- `404`: `conexão não encontrada`.
- `409`: manager indisponível.

### POST `/connections/:id/restart`

Alias: `POST /connections/:id/reconnect`.

Respostas:

- `200`: status atualizado (normalmente `connecting`).
- `404`: `conexão não encontrada`.
- `409`: manager indisponível.

### GET `/connections/:id/status`

Resumo operacional (inclui visão `admin`).

Respostas:

- `200`: status resumido.
- `404`: `conexão não encontrada`.

### GET `/connections/:id/qr`

Retorna QR atual.

Respostas:

- `200`: `{ connectionId, qrCode, qrCodeAt }`.
- `404`: `conexão não encontrada` ou `QR code não disponível`.

### POST `/connections/:id/pairing/start`

Inicia pareamento remoto.

Respostas:

- `202`: estado inicial (`pending`/`qr_ready`).
- `409`: manager indisponível.

### POST `/connections/:id/pairing/cancel`

Cancela pareamento remoto.

Respostas:

- `200`: estado final do pairing.
- `404`: `conexão não encontrada`.
- `409`: manager indisponível.

### GET `/connections/:id/pairing`

Consulta estado do pairing.

Respostas:

- `200`: inclui `status`, `qrCode`, `qrUpdatedAt`, `qrExpiresAt`.
- `404`: `conexão não encontrada`.
- `409`: manager indisponível.

### POST `/connections/:id/webhook/start`

Cria/atualiza conexão e despacha comando `start` via webhook assinado interno.

Body:

```json
{ "label": "Bot Principal" }
```

Respostas:

- `200`: comando aceito.
- `502`: falha ao acionar webhook de conexão.
- `503`: `WA_WEBHOOK_SHARED_SECRET` não configurado.

## Endpoints de Mensagens e Grupos

### POST `/connections/:id/messages/send`

Pré-condição: conexão deve estar `open`.

Body `text`:

```json
{ "type": "text", "to": "5511999999999@s.whatsapp.net", "text": "Olá" }
```

Body `image|video|audio|document`:

```json
{
  "type": "document",
  "to": "5511999999999@s.whatsapp.net",
  "url": "https://exemplo.com/arquivo.pdf",
  "fileName": "arquivo.pdf",
  "mimetype": "application/pdf"
}
```

Respostas:

- `200`: resposta bruta do `sendMessage` (Baileys).
- `400`: payload inválido/campos obrigatórios.
- `404`: `conexão não encontrada`.
- `409`: instância não conectada ou socket indisponível.
- `500`: falha ao enviar.

### GET `/connections/:id/groups`

Pré-condição: conexão `open`.

Respostas:

- `200`: mapa de grupos retornado por `groupFetchAllParticipating`.
- `404`: `conexão não encontrada`.
- `409`: instância não conectada ou socket indisponível.
- `500`: falha ao buscar grupos.

## Webhooks por Conexão

Antes de criar webhooks, configure `WA_WEBHOOK_ALLOWED_TARGETS` com os destinos autorizados.
Sem isso, a API retorna erro: `nenhum destino autorizado configurado. defina WA_WEBHOOK_ALLOWED_TARGETS`.

### POST `/connections/:id/webhooks`

Cria webhook de uma conexão.

Body:

```json
{
  "url": "https://meu-sistema.com/webhook",
  "eventsFilter": ["messages", "connection.update"],
  "secret": "segredo-opcional"
}
```

`eventsFilter` aceita:

- `*`
- eventos diretos: `connection.update`, `messages.upsert`, `messages.update`, `messages.delete`, `message-receipt.update`, `messages.reaction`, `groups.upsert`, `groups.update`, `group-participants.update`
- grupos: `connection`, `messages`, `groups`

Respostas:

- `201`: webhook criado.
- `400`: body inválido, `url` inválida, `eventsFilter` vazio ou URL não permitida.
- `500`: falha ao criar.

### GET `/connections/:id/webhooks`

Lista webhooks da conexão.

Respostas:

- `200`: array de webhooks.

### GET `/connections/:id/webhooks/:webhookId`

Respostas:

- `200`: webhook.
- `404`: `webhook não encontrado`.

### PATCH `/connections/:id/webhooks/:webhookId`

Body parcial:

```json
{
  "url": "https://novo-endpoint.com/hook",
  "eventsFilter": ["messages.upsert"],
  "active": true,
  "secret": null
}
```

Respostas:

- `200`: webhook atualizado.
- `400`: body/url inválido(a).
- `404`: `webhook não encontrado`.

### DELETE `/connections/:id/webhooks/:webhookId`

Respostas:

- `204`: removido.
- `404`: `webhook não encontrado`.

### GET `/connections/:id/webhooks/:webhookId/deliveries`

Lista histórico de entregas.

Respostas:

- `200`: array de entregas.
- `404`: `webhook não encontrado`.

### POST `/connections/:id/webhooks/:webhookId/deliveries/:deliveryId/retry`

Força nova tentativa de entrega.

Respostas:

- `200`: entrega atualizada.
- `404`: webhook ou entrega não encontrada.
- `500`: falha ao retentar.

## Webhooks Globais

Mesmo contrato dos webhooks por conexão, mas para todas as conexões:

- `GET /webhooks`
- `POST /webhooks`
- `GET /webhooks/:webhookId`
- `PATCH /webhooks/:webhookId`
- `DELETE /webhooks/:webhookId`
- `GET /webhooks/:webhookId/deliveries`
- `POST /webhooks/:webhookId/deliveries/:deliveryId/retry`

## Payload enviado para destino de webhook

Formato:

```json
{
  "event": "messages.upsert",
  "connectionId": "minha-sessao",
  "timestamp": 1780000000000,
  "data": {}
}
```

Headers de entrega:

- `content-type: application/json`
- `x-webhook-event: <nome-do-evento>`
- `x-webhook-delivery: <id-da-entrega>`
- `x-webhook-signature: sha256=<hmac>` quando `secret` foi configurado no webhook.

Status de entrega persistido:

- `pending`
- `delivered`
- `failed`
- `dead_letter`

## Webhook de Comandos (HMAC)

Endpoint:

- `POST /webhooks/connections`

Headers obrigatórios:

- `content-type: application/json`
- `x-zyra-timestamp`
- `x-zyra-signature`
- `x-zyra-delivery-id`

Regra da assinatura:

- HMAC SHA-256 sobre `"<timestamp>.<rawBody>"` usando `WA_WEBHOOK_SHARED_SECRET`.
- Aceita `x-zyra-signature` com ou sem prefixo `sha256=`.

Payload:

```json
{
  "event": "connection.command",
  "version": "2026-05-27",
  "command_id": "uuid",
  "sent_at": "2026-05-30T16:00:00.000Z",
  "connection": { "id": "minha-sessao", "display_name": "Bot X" },
  "action": { "type": "start", "reason": "dashboard.qr" },
  "options": { "force": false },
  "metadata": { "source": "sistema-externo" }
}
```

Ações válidas (`action.type`):

- `register`
- `start`
- `reconnect`
- `disconnect`
- `pause`
- `resume`
- `delete_soft`
- `delete_hard`
- `sync_status`
- `pairing_start`
- `pairing_cancel`

Resposta de sucesso:

```json
{
  "ok": true,
  "command_id": "uuid",
  "connection_id": "minha-sessao",
  "accepted": true,
  "action": "start",
  "current_state": "connecting",
  "desired_state": "running"
}
```

Regras importantes:

- Idempotência por `command_id` (duplicado pode retornar `duplicate: true`).
- `delete_hard` exige `options.force=true`.
- Sem `WA_WEBHOOK_HARD_DELETE_TOKEN`, também exige header `x-zyra-hard-delete-confirm=true`.
- Com `WA_WEBHOOK_HARD_DELETE_TOKEN`, exige `x-zyra-hard-delete-token` igual ao token configurado.

Erros comuns:

- `400`: payload/event/fields inválidos.
- `401`: headers de auth ausentes, timestamp inválido/fora da janela, assinatura inválida.
- `405`: método diferente de `POST`.
- `413`: payload acima do limite.
- `415`: content-type inválido.
- `422`: ação inválida ou regra de hard delete não atendida.
- `500`: erro interno ao processar comando.

## Runtime e Health

### GET `/system/runtime`

Retorna perfil e capacidades do processo:

- `profile`: `full`, `connections-only`, `api-webhook`, `stateless`
- `capabilities`, `api`, `webhook`, `process`

### GET `/health/live`

Liveness simples do processo.

Resposta:

- `200`: `{ ok: true, live: true, now, uptime_sec }`

### GET `/health/ready`

Readiness (MySQL/Redis/control-plane).

Respostas:

- `200`: pronto.
- `503`: dependência não pronta.

### GET `/health/connections`

Resumo por conexão + contadores agregados (`open`, `connecting`, `paused`, `error`).

## Exemplo de fluxo completo (API)

1. `POST /connections`
2. `POST /connections/:id/connect`
3. Poll em `GET /connections/:id/qr` até vir `200` com `qrCode`
4. Poll em `GET /connections/:id/status` até `status=open`
5. `POST /connections/:id/messages/send`

## Exemplo rápido de cURL

```bash
BASE="http://localhost:3000"
TOKEN="sua-chave"
ID="sessao-demo"

curl -s -X POST "$BASE/connections" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"connectionId\":\"$ID\"}" | jq

curl -s -X POST "$BASE/connections/$ID/connect" \
  -H "Authorization: Bearer $TOKEN" | jq

curl -s "$BASE/connections/$ID/qr" \
  -H "Authorization: Bearer $TOKEN" | jq
```
