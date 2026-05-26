# Webhooks — Guia de Configuração

Webhooks permitem que o Zyra notifique sistemas externos em tempo real sempre que um evento ocorrer em uma conexão do WhatsApp (nova mensagem, atualização de grupo, mudança de status de conexão, etc.).

---

## Pré-requisitos

O servidor REST deve estar habilitado no `.env`:

```env
WA_API_ENABLED=true
WA_API_PORT=3000
WA_API_HOST=0.0.0.0

# Opcional — autenticação por Bearer token
WA_API_KEY=sua-chave-secreta
```

---

## Variáveis de configuração do webhook

| Variável | Padrão | Descrição |
|---|---|---|
| `WA_WEBHOOK_TIMEOUT_MS` | `10000` | Tempo máximo (ms) para aguardar resposta do endpoint receptor |
| `WA_WEBHOOK_MAX_ATTEMPTS` | `4` | Número máximo de tentativas antes de marcar como `dead_letter` |

Exemplo de configuração completa:

```env
WA_API_ENABLED=true
WA_API_PORT=3000
WA_API_KEY=minha-chave

WA_WEBHOOK_TIMEOUT_MS=8000
WA_WEBHOOK_MAX_ATTEMPTS=4
```

---

## Eventos suportados

| Evento | Descrição |
|---|---|
| `connection.update` | Mudança de status da conexão (conectando, aberto, fechado) |
| `messages.upsert` | Nova mensagem recebida ou enviada |
| `messages.update` | Atualização de status de mensagem (lida, entregue, etc.) |
| `messages.delete` | Mensagem deletada |
| `message-receipt.update` | Atualização de recibo de leitura/entrega |
| `messages.reaction` | Reação adicionada ou removida de mensagem |
| `groups.upsert` | Novo grupo criado ou metadados recebidos |
| `groups.update` | Atualização de metadados de grupo |
| `group-participants.update` | Entrada, saída ou promoção de participante |

### Filtros de evento

O campo `eventsFilter` aceita:

- **Evento específico**: `["messages.upsert"]`
- **Grupo de eventos**: `["messages"]` (equivale a todos os 5 eventos de mensagens)
- **Grupos disponíveis**: `connection`, `messages`, `groups`
- **Wildcard**: `["*"]` (todos os eventos)
- **Combinação**: `["connection.update", "messages.upsert"]`

---

## Criando um webhook

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/webhooks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{
    "url": "https://meu-sistema.com/webhook",
    "eventsFilter": ["*"]
  }' | jq
```

**Resposta `201`:**
```json
{
  "id": "wh_abc123",
  "connectionId": "minha-sessao",
  "url": "https://meu-sistema.com/webhook",
  "eventsFilter": ["*"],
  "active": true,
  "secret": null,
  "createdAt": 1716768000000,
  "updatedAt": 1716768000000
}
```

### Com assinatura HMAC

Para verificar a autenticidade dos payloads no receptor, forneça um `secret`:

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/webhooks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{
    "url": "https://meu-sistema.com/webhook",
    "eventsFilter": ["messages.upsert", "connection.update"],
    "secret": "meu-segredo-hmac"
  }' | jq
```

Cada requisição enviada ao seu endpoint incluirá o header:

```
x-webhook-signature: sha256=<hmac-hex>
```

---

## Estrutura do payload

Todo evento entregue tem o mesmo envelope:

```json
{
  "event": "messages.upsert",
  "connectionId": "minha-sessao",
  "timestamp": 1716768000000,
  "data": { ... }
}
```

| Campo | Tipo | Descrição |
|---|---|---|
| `event` | string | Nome do evento Baileys |
| `connectionId` | string | ID da conexão de origem |
| `timestamp` | number | Unix timestamp em milissegundos |
| `data` | object | Payload original do evento (estrutura varia por evento) |

### Headers enviados pelo Zyra

| Header | Descrição |
|---|---|
| `content-type` | `application/json` |
| `x-webhook-event` | Nome do evento (ex: `messages.upsert`) |
| `x-webhook-delivery` | ID único da entrega |
| `x-webhook-signature` | `sha256=<hmac>` — presente apenas quando `secret` foi configurado |

---

## Verificando a assinatura HMAC (Node.js)

```js
import { createHmac } from 'node:crypto'

function verifySignature(body, secret, signatureHeader) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  return signatureHeader === expected
}

// Em um servidor Express:
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-webhook-signature']
  if (!verifySignature(req.body, 'meu-segredo-hmac', sig)) {
    return res.status(401).send('Assinatura inválida')
  }
  const payload = JSON.parse(req.body)
  console.log('Evento recebido:', payload.event)
  res.sendStatus(200)
})
```

---

## Retentativas automáticas

Quando o endpoint receptor retorna um status não-2xx (ou não responde no tempo limite), o Zyra reagendará a entrega automaticamente:

| Tentativa | Aguarda |
|---|---|
| 1ª falha | 30 segundos |
| 2ª falha | 5 minutos |
| 3ª falha | 30 minutos |
| 4ª falha | marcado como `dead_letter` |

O número máximo de tentativas é controlado por `WA_WEBHOOK_MAX_ATTEMPTS` (padrão: `4`).

### Ciclo de vida de uma entrega

```
pending → (primeira tentativa)
  ├── ok (2xx)    → delivered
  └── falha       → failed → (retry worker agenda nova tentativa)
                      ├── ok (2xx)    → delivered
                      └── falha × N  → dead_letter
```

---

## Gerenciando webhooks via API

### Listar webhooks de uma conexão

```bash
curl -s http://localhost:3000/connections/minha-sessao/webhooks \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

### Buscar webhook por ID

```bash
curl -s http://localhost:3000/connections/minha-sessao/webhooks/wh_abc123 \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

### Atualizar webhook

```bash
curl -s -X PATCH http://localhost:3000/connections/minha-sessao/webhooks/wh_abc123 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{"active": false}' | jq
```

Campos atualizáveis: `url`, `eventsFilter`, `active`, `secret`.

### Desativar temporariamente

```bash
curl -s -X PATCH http://localhost:3000/connections/minha-sessao/webhooks/wh_abc123 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{"active": false}' | jq
```

### Deletar webhook

```bash
curl -s -X DELETE http://localhost:3000/connections/minha-sessao/webhooks/wh_abc123 \
  -H "Authorization: Bearer sua-chave-secreta"
# 204 No Content
```

---

## Histórico de entregas

### Listar entregas de um webhook

```bash
curl -s http://localhost:3000/connections/minha-sessao/webhooks/wh_abc123/deliveries \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta:**
```json
[
  {
    "id": "del_xyz789",
    "webhookId": "wh_abc123",
    "connectionId": "minha-sessao",
    "eventType": "messages.upsert",
    "payload": { ... },
    "status": "delivered",
    "attempts": 1,
    "lastAttemptAt": 1716768005000,
    "nextRetryAt": null,
    "responseStatus": 200,
    "responseBody": "ok",
    "createdAt": 1716768000000
  }
]
```

### Status possíveis de uma entrega

| Status | Significado |
|---|---|
| `pending` | Aguardando primeira tentativa |
| `delivered` | Entregue com sucesso (2xx) |
| `failed` | Falhou, mas ainda há tentativas disponíveis |
| `dead_letter` | Esgotou todas as tentativas |

### Retentar manualmente uma entrega

Útil para reprocessar entregas `failed` ou `dead_letter`:

```bash
curl -s -X POST \
  http://localhost:3000/connections/minha-sessao/webhooks/wh_abc123/deliveries/del_xyz789/retry \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

---

## Referência rápida de endpoints

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/connections/:id/webhooks` | Lista todos os webhooks da conexão |
| `POST` | `/connections/:id/webhooks` | Cria um novo webhook |
| `GET` | `/connections/:id/webhooks/:wid` | Busca um webhook |
| `PATCH` | `/connections/:id/webhooks/:wid` | Atualiza um webhook |
| `DELETE` | `/connections/:id/webhooks/:wid` | Remove um webhook |
| `GET` | `/connections/:id/webhooks/:wid/deliveries` | Histórico de entregas |
| `POST` | `/connections/:id/webhooks/:wid/deliveries/:did/retry` | Reprocessa uma entrega |
