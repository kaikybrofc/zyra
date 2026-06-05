# API REST — Guia de Referência

A API REST permite gerenciar instâncias do WhatsApp, enviar mensagens e consultar grupos de forma programática, sem acesso direto ao terminal.

## Configuração

Habilite o servidor no `.env`:

```env
WA_API_ENABLED=true
WA_API_PORT=3000
WA_API_HOST=0.0.0.0

# Opcional — se definido, todas as requisições exigem o header abaixo
WA_API_KEY=sua-chave-secreta
```

### Autenticação

Quando `WA_API_KEY` está definida, toda requisição deve incluir:

```
Authorization: Bearer sua-chave-secreta
```

Sem o header (ou com valor incorreto), a resposta é `401 Unauthorized`.

### Webhook de Controle de Conexões (HMAC)

O endpoint `POST /webhooks/connections` usa autenticação própria por assinatura HMAC e **não exige** `WA_API_KEY`.

Configure no `.env`:

```env
WA_WEBHOOK_SHARED_SECRET=troque-este-segredo
WA_WEBHOOK_MAX_BODY_BYTES=262144
WA_WEBHOOK_TIMESTAMP_TOLERANCE_MS=300000
```

Headers obrigatórios:

- `x-zyra-signature`: HMAC SHA-256 de `${timestamp}.${rawBody}`
- `x-zyra-timestamp`: epoch em segundos ou milissegundos
- `x-zyra-delivery-id`: id de entrega único no sistema chamador

---

## Ciclo de vida de uma instância

```
POST /connections          → status: created
POST /connections/:id/connect  → status: connecting → qr → open
GET  /connections/:id/qr   → lê o QR code (escanear com WhatsApp)
POST /connections/:id/disconnect → status: closed
POST /connections/:id/restart   → closed → connecting → ...
DELETE /connections/:id    → remove permanentemente
```

---

## Endpoints

### Criar instância

Registra uma nova instância sem iniciar conexão com o WhatsApp.
O `connectionId` é o identificador único e imutável da instância.

```bash
curl -s -X POST http://localhost:3000/connections \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{"connectionId": "minha-sessao"}' | jq
```

**Resposta `201`:**

```json
{
  "connectionId": "minha-sessao",
  "label": null,
  "status": "created",
  "socketGeneration": 0,
  "lastReconnectAt": 0,
  "reconnectInFlight": false,
  "socketActive": false,
  "qrCode": null,
  "qrCodeAt": null
}
```

---

### Listar instâncias

Retorna todas as instâncias registradas no processo atual.

```bash
curl -s http://localhost:3000/connections \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:**

```json
[
  {
    "connectionId": "minha-sessao",
    "label": "Bot Principal",
    "status": "open",
    "socketGeneration": 1,
    "lastReconnectAt": 1748000000000,
    "reconnectInFlight": false,
    "socketActive": true,
    "qrCode": null,
    "qrCodeAt": null
  }
]
```

---

### Detalhes de uma instância

```bash
curl -s http://localhost:3000/connections/minha-sessao \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:** mesmo formato do item acima.
**Resposta `404`:** instância não existe.

---

### Atualizar label

Atribui um nome legível à instância (apenas metadado local, não afeta a conexão).

```bash
curl -s -X PATCH http://localhost:3000/connections/minha-sessao \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{"label": "Bot de Suporte"}' | jq
```

Para remover o label:

```bash
curl -s -X PATCH http://localhost:3000/connections/minha-sessao \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{"label": null}' | jq
```

**Resposta `200`:** dados atualizados da instância.
**Resposta `404`:** instância não existe.

---

### Conectar instância (gerar QR)

Inicia o processo de autenticação com o WhatsApp.
Após chamar este endpoint, consulte `/qr` para obter o QR code para escaneamento.

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/connect \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:** dados da instância com `status: "connecting"`.
**Resposta `404`:** instância não existe.

> Se a instância já estiver `open`, `connecting` ou `qr`, o connect é ignorado sem erro.

---

### Obter QR code

Retorna o QR code mais recente disponível para escaneamento.
Chame este endpoint repetidamente após `/connect` até receber o código.

```bash
curl -s http://localhost:3000/connections/minha-sessao/qr \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:**

```json
{
  "connectionId": "minha-sessao",
  "qrCode": "2@ABC123...",
  "qrCodeAt": 1748000000000
}
```

**Resposta `404`:** QR ainda não disponível (instância pode estar ainda iniciando) ou já foi escaneado.

> O QR code expira em ~60 segundos. O Baileys emite automaticamente um novo código — basta consultar o endpoint novamente.

---

### Verificar status

Retorna apenas o status resumido da instância, sem os demais campos.

```bash
curl -s http://localhost:3000/connections/minha-sessao/status \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:**

```json
{
  "connectionId": "minha-sessao",
  "status": "open",
  "socketActive": true
}
```

**Valores possíveis de `status`:**

| Status       | Descrição                     |
| ------------ | ----------------------------- |
| `created`    | Instância criada, sem socket  |
| `connecting` | Socket sendo iniciado         |
| `qr`         | Aguardando escaneamento do QR |
| `open`       | Autenticada e conectada       |
| `closed`     | Desconectada explicitamente   |
| `error`      | Falha durante a conexão       |

---

### Desconectar instância

Encerra o socket sem remover a instância do manager.
A instância pode ser reconectada novamente via `/connect`.

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/disconnect \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:** dados da instância com `status: "closed"`.
**Resposta `404`:** instância não existe.

---

### Pausar instância

Encerra o socket ativo e marca a conexão como pausada administrativamente.

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/pause \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:** dados atualizados da instância com `admin.desired_state: "paused"`.
**Resposta `404`:** instância não existe.

---

### Retomar instância pausada

Volta o `desired_state` para `running` e agenda a reconexão da sessão.

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/resume \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:** dados atualizados da instância.
**Resposta `404`:** instância não existe.

---

### Reiniciar conexão

Desconecta e reconecta automaticamente. Útil para forçar um novo ciclo de autenticação.

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/restart \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:** dados da instância com `status: "connecting"`.
**Resposta `404`:** instância não existe.

---

### Iniciar pairing remoto

Inicia o fluxo de pareamento sem terminal e retorna estado inicial (`pending` ou `qr_ready`).

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/pairing/start \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `202`:**

```json
{
  "connectionId": "minha-sessao",
  "status": "pending",
  "qrCode": null
}
```

---

### Consultar estado do pairing

```bash
curl -s http://localhost:3000/connections/minha-sessao/pairing \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:** inclui `status`, `qrCode`, `qrUpdatedAt` e `qrExpiresAt`.

---

### Cancelar pairing

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/pairing/cancel \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:** estado final do pairing com `status: "cancelled"`.

---

### Deletar instância

Remove a instância permanentemente do manager. Se houver socket ativo, ele é encerrado antes.

```bash
curl -s -X DELETE http://localhost:3000/connections/minha-sessao \
  -H "Authorization: Bearer sua-chave-secreta"
```

**Resposta `204`:** sem corpo — instância removida.
**Resposta `404`:** instância não existe.

---

### Hard delete da instância

Remove a instância e tenta limpar artefatos persistidos de sessão, incluindo auth e estado auxiliar.

Use:

- query obrigatória: `?force=true`
- header obrigatório quando `WA_WEBHOOK_HARD_DELETE_TOKEN` **não** estiver configurado:
  `x-zyra-hard-delete-confirm: true`
- header obrigatório quando `WA_WEBHOOK_HARD_DELETE_TOKEN` estiver configurado:
  `x-zyra-hard-delete-token: <token>`

```bash
curl -s -X DELETE "http://localhost:3000/connections/minha-sessao/hard?force=true" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -H "x-zyra-hard-delete-confirm: true" -i
```

**Resposta `204`:** hard delete aceito e concluído.
**Resposta `422`:** proteção `force`/confirmação não atendida.
**Resposta `403`:** token adicional inválido.
**Resposta `404`:** instância não encontrada.

---

### Iniciar conexão via webhook (dashboard)

Cria ou atualiza a instância e despacha um comando `start` para o ingress de webhook interno. Útil quando o processo atual não gerencia conexões diretamente (`WA_BOOTSTRAP_CONNECTIONS_ENABLED=false`).

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/webhook/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{"label": "Bot Principal"}' | jq
```

O campo `label` é opcional. A resposta espelha o retorno do ingress de webhook:

```json
{
  "ok": true,
  "command_id": "uuid-gerado",
  "connection_id": "minha-sessao",
  "accepted": true,
  "action": "start",
  "current_state": "connecting",
  "desired_state": "running"
}
```

**Resposta `503`:** `WA_WEBHOOK_SHARED_SECRET` não configurado.
**Resposta `502`:** falha ao acionar o ingress interno.

---

### Diagnóstico ampliado da conexão

Retorna uma visão consolidada do runtime e do estado administrativo persistido.

```bash
curl -s http://localhost:3000/connections/minha-sessao/diagnostics \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:**

```json
{
  "connectionId": "minha-sessao",
  "label": "Bot Principal",
  "status": "open",
  "runtime": {
    "socketGeneration": 3,
    "socketActive": true,
    "reconnectInFlight": false,
    "qrCodeAvailable": false,
    "qrCodeAt": null,
    "lastReconnectAt": "2026-06-05T02:00:00.000Z"
  },
  "admin": {
    "desired_state": "running",
    "pairing_state": "not_required",
    "last_error": null
  },
  "capabilities": {
    "managerCanExecuteRuntimeActions": true,
    "webhookIngressConfigured": true
  }
}
```

---

### Eventos administrativos da conexão

Lista a trilha de auditoria persistida em `connection_admin_events`.

```bash
curl -s "http://localhost:3000/connections/minha-sessao/events?limit=50" \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:**

```json
{
  "connectionId": "minha-sessao",
  "count": 2,
  "limit": 50,
  "events": [
    {
      "eventType": "connection.resumed",
      "source": "manager.resume"
    }
  ]
}
```

---

### Comandos webhook da conexão

Lista comandos recebidos para uma conexão específica, úteis para rastrear automações e integrações.

```bash
curl -s "http://localhost:3000/connections/minha-sessao/commands?limit=20" \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:**

```json
{
  "connectionId": "minha-sessao",
  "count": 1,
  "limit": 20,
  "commands": [
    {
      "commandId": "cmd-123",
      "actionType": "pause",
      "status": "accepted"
    }
  ]
}
```

Para consultar um comando específico:

```bash
curl -s http://localhost:3000/connections/commands/cmd-123 \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `404`:** comando não encontrado.

---

### Enviar mensagens

A instância precisa estar com `status: "open"`.

O endpoint `POST /connections/:id/messages/send` aceita dois modos:

1. Tipos atalho da API: `text`, `image`, `video`, `audio`, `document`, `sticker`, `contacts`, `location`, `react`, `poll`, `event`, `buttonReply`, `groupInvite`, `listReply`, `pin`, `sharePhoneNumber`, `requestPhoneNumber`, `forward`, `delete`, `disappearingMessagesInChat` e `limitSharing`.
2. `type: "raw"` para enviar um `AnyMessageContent` nativo do Baileys, útil para payloads avançados ou tipos ainda não cobertos por atalho.

**Resposta `200`:** objeto `WAMessage` retornado pelo Baileys.

**Campos-base do payload:**

| Campo     | Tipo     | Obrigatório | Descrição                                                                  |
| --------- | -------- | ----------- | -------------------------------------------------------------------------- |
| `type`    | string   | sim         | Tipo da mensagem ou `raw`                                                  |
| `to`      | string   | sim         | JID do destino (`@s.whatsapp.net`, `@g.us` ou `status@broadcast`)          |
| `options` | object   | não         | Opções extras do Baileys para envio, inclusive `quoted`, `statusJidList` e `broadcast` |

**Campos mais usados por tipo:**

| Tipo | Campos principais |
| ---- | ----------------- |
| `text` | `text` |
| `image` | `url`, `caption` |
| `video` | `url`, `caption`, `gifPlayback`, `ptv` |
| `audio` | `url`, `ptt`, `seconds` |
| `document` | `url`, `fileName`, `mimetype`, `caption` |
| `sticker` | `url`, `isAnimated` |
| `contacts` | `contacts.displayName`, `contacts.contacts[]` |
| `location` | `latitude`/`longitude` ou `degreesLatitude`/`degreesLongitude` |
| `react` | `text`, `messageKey` |
| `poll` | `name`, `values[]`, `selectableCount` |
| `event` | `name`, `startDate`, `endDate`, `description`, `location`, `call` |
| `pin` | `messageKey`, `time` (`86400`, `604800` ou `2592000`) |
| `forward` | `message`, `force` |
| `delete` | `messageKey` |
| `disappearingMessagesInChat` | `value` |
| `limitSharing` | `value` |
| `raw` | `content` com o payload Baileys completo |

**Opções suportadas em `options`:**

| Campo | Tipo | Descrição |
| ----- | ---- | --------- |
| `messageId` | string | ID customizado da mensagem |
| `quoted` | object | `WAMessage` usado como resposta |
| `ephemeralExpiration` | number \| string | Expiração efêmera |
| `mediaUploadTimeoutMs` | number | Timeout de upload |
| `statusJidList` | string[] \| string | Lista de contatos que verão um `status@broadcast` |
| `backgroundColor` | string | Cor de fundo para status |
| `font` | number | Fonte para status de texto |
| `broadcast` | boolean | Força envio como broadcast |

#### Exemplo: texto

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/messages/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{
    "type": "text",
    "to": "5511999999999@s.whatsapp.net",
    "text": "Olá! Mensagem enviada via API."
  }' | jq
```

#### Exemplo: grupo

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/messages/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{
    "type": "text",
    "to": "120363000000000000@g.us",
    "text": "Mensagem para o grupo."
  }' | jq
```

#### Exemplo: mídia

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/messages/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{
    "type": "document",
    "to": "5511999999999@s.whatsapp.net",
    "url": "https://example.com/arquivo.pdf",
    "fileName": "relatorio.pdf",
    "mimetype": "application/pdf"
  }' | jq
```

#### Exemplo: status

Para status, use `to: "status@broadcast"` e informe `options.statusJidList`.

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/messages/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{
    "type": "text",
    "to": "status@broadcast",
    "text": "Status enviado pela API",
    "options": {
      "statusJidList": ["5511999999999", "5511888888888@s.whatsapp.net"],
      "backgroundColor": "#102030",
      "font": 3
    }
  }' | jq
```

#### Exemplo: payload bruto do Baileys

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/messages/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{
    "type": "raw",
    "to": "5511999999999@s.whatsapp.net",
    "content": {
      "sharePhoneNumber": true
    }
  }' | jq
```

**Erros possíveis:**

| Código | Motivo |
| ------ | ------ |
| `400`  | Body inválido, tipo desconhecido ou campo obrigatório ausente |
| `404`  | Instância não encontrada |
| `409`  | Instância não está `open` ou socket indisponível |
| `500`  | Falha no envio pelo Baileys |

---

### Listar grupos

Retorna todos os grupos em que a instância participa, no formato original do Baileys (`Record<string, GroupMetadata>`).

```bash
curl -s http://localhost:3000/connections/minha-sessao/groups \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:**

```json
{
  "120363000000000001@g.us": {
    "id": "120363000000000001@g.us",
    "subject": "Nome do Grupo",
    "subjectOwner": "5511999999999@s.whatsapp.net",
    "subjectTime": 1700000000,
    "creation": 1700000000,
    "owner": "5511999999999@s.whatsapp.net",
    "participants": [
      { "id": "5511999999999@s.whatsapp.net", "admin": "superadmin" },
      { "id": "5511888888888@s.whatsapp.net", "admin": null }
    ],
    "announce": false,
    "restrict": false
  }
}
```

Para obter apenas os JIDs dos grupos:

```bash
curl -s http://localhost:3000/connections/minha-sessao/groups \
  -H "Authorization: Bearer sua-chave-secreta" | jq 'keys'
```

**Resposta `409`:** instância não está `open`.

---

### Administração de grupo

Executa ações administrativas diretamente em um grupo específico pela rota:

```text
POST /connections/:id/groups/:groupJid/admin
```

O `groupJid` deve estar no formato completo `...@g.us`.

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/groups/120363000000000001%40g.us/admin \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{
    "action": "ban",
    "participants": ["5511999999999", "5511888888888@s.whatsapp.net"]
  }' | jq
```

**Ações suportadas:**

| `action` | Campos extras | Descrição |
| -------- | ------------- | --------- |
| `add` | `participants` | Adiciona participantes ao grupo |
| `kick` | `participants` | Remove participantes |
| `remove` | `participants` | Alias explícito de remoção |
| `ban` | `participants` | Alias de remoção para banimento |
| `promote` | `participants` | Promove participantes para admin |
| `demote` | `participants` | Remove privilégios de admin |
| `announcementMode` | `enabled: boolean` | `true` fecha o grupo para só admins enviarem |
| `lockedMode` | `enabled: boolean` | `true` trava edição de info para não-admins |
| `subject` | `subject: string` | Atualiza o nome do grupo |
| `description` | `description: string \| null` | Atualiza ou limpa a descrição |
| `ephemeral` | `expirationSeconds: number` | Define mensagens temporárias (`0` desativa) |
| `getInviteCode` | nenhum | Retorna o código/link atual do grupo |
| `revokeInvite` | nenhum | Revoga o convite atual e retorna o novo |
| `memberAddMode` | `mode: "admin_add" \| "all_member_add"` | Define quem pode adicionar membros diretamente |
| `joinApprovalMode` | `mode: "on" \| "off"` | Liga/desliga aprovação de entrada |
| `listJoinRequests` | nenhum | Lista solicitações pendentes de entrada |
| `approveJoinRequests` | `participants` | Aprova solicitações pendentes |
| `rejectJoinRequests` | `participants` | Rejeita solicitações pendentes |

**Formato de `participants`:**

- aceita string única (`"5511999999999"`)
- aceita CSV (`"5511999999999,5511888888888"`)
- aceita array (`["5511999999999", "5511888888888@s.whatsapp.net"]`)

**Exemplo: aprovar solicitações pendentes**

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/groups/120363000000000001%40g.us/admin \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{
    "action": "approveJoinRequests",
    "participants": "5511999999999,5511888888888"
  }' | jq
```

**Resposta `200` para mutações:**

```json
{
  "ok": true,
  "action": "promote",
  "participants": ["5511999999999@s.whatsapp.net"],
  "result": [{ "status": "200" }]
}
```

**Resposta `200` para leituras:**

```json
{
  "ok": true,
  "action": "listJoinRequests",
  "requests": [
    {
      "jid": "5511999999999@s.whatsapp.net"
    }
  ]
}
```

**Erros possíveis:**

| Código | Motivo |
| ------ | ------ |
| `400` | `groupJid` inválido, body inválido ou campos obrigatórios ausentes |
| `404` | Instância não encontrada |
| `409` | Instância não está `open` |
| `500` | Falha ao executar a ação administrativa no WhatsApp |

---

### Informações do runtime

Retorna metadados operacionais do processo atual: perfil de execução, capacidades habilitadas e estado do processo.

```bash
curl -s http://localhost:3000/system/runtime \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:**

```json
{
  "now": 1748000000000,
  "profile": "full",
  "capabilities": {
    "managesConnections": true,
    "servesApi": true,
    "managesWebhookRetry": true,
    "managesWebhookOutbox": true,
    "connectionWebhookIngress": true
  },
  "api": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 3000,
    "authRequired": true
  },
  "webhook": {
    "retryWorkerEnabled": true,
    "outboxWorkerEnabled": true,
    "timeoutMs": 10000,
    "maxAttempts": 4,
    "allowedTargetsCount": 2
  },
  "process": {
    "pid": 12345,
    "uptimeSec": 3600,
    "nodeVersion": "v20.0.0",
    "platform": "linux",
    "pm2": {
      "appName": "zyra",
      "processId": "0"
    }
  }
}
```

**Perfis possíveis de `profile`:**

| Perfil             | Condição                                                         |
| ------------------ | ---------------------------------------------------------------- |
| `full`             | `WA_BOOTSTRAP_CONNECTIONS_ENABLED=true` e `WA_API_ENABLED=true`  |
| `connections-only` | Apenas `WA_BOOTSTRAP_CONNECTIONS_ENABLED=true`                   |
| `api-webhook`      | Apenas `WA_API_ENABLED=true` (sem gerenciar conexões localmente) |
| `stateless`        | Nenhum dos dois habilitado                                       |

---

## Modo managed (multi-processo)

Quando `WA_BOOTSTRAP_CONNECTIONS_ENABLED=false`, o processo atual não gerencia sockets diretamente. Nesse modo:

- `POST /connections` persiste a instância no banco como `inactive` com `desiredState: running`.
- `PATCH /connections/:id` e `DELETE /connections/:id` operam sobre o registro persistido.
- `GET /connections` e `GET /connections/:id` fazem fallback para o banco quando a instância não está na memória local.
- `POST /connections/:id/connect`, `/disconnect`, `/restart` e endpoints de pairing retornam `409` com a mensagem `operação indisponível neste processo`.
- Use `POST /connections/:id/webhook/start` para acionar o início de conexão via ingress de webhook, que será processado pelo processo que gerencia conexões.

Endpoints que sempre funcionam independente do modo: `GET /connections`, `GET /connections/:id`, `GET /connections/:id/status`, `POST /connections`, `PATCH /connections/:id`, `DELETE /connections/:id`, `GET /system/runtime`.

---

## Formato do JID

O WhatsApp identifica contatos e grupos por JID (Jabber ID):

| Tipo       | Formato                             | Exemplo                         |
| ---------- | ----------------------------------- | ------------------------------- |
| Contato    | `{ddi}{ddd}{numero}@s.whatsapp.net` | `5511999999999@s.whatsapp.net`  |
| Grupo      | `{id}@g.us`                         | `120363000000000001@g.us`       |
| Newsletter | `{id}@newsletter`                   | `120363111111111111@newsletter` |

> O número deve incluir o código do país (55 para Brasil) sem o `+`.

---

## Respostas de erro padrão

Todos os erros seguem o formato:

```json
{ "error": "mensagem descritiva" }
```

| Código | Situação                                   |
| ------ | ------------------------------------------ |
| `400`  | Parâmetros inválidos ou ausentes           |
| `401`  | Token de autenticação ausente ou incorreto |
| `404`  | Recurso não encontrado                     |
| `409`  | Operação inválida para o estado atual      |
| `500`  | Erro interno do servidor                   |

---

## Exemplo de fluxo completo

```bash
BASE="http://localhost:3000"
TOKEN="sua-chave-secreta"
ID="sessao-principal"

# 1. Criar instância
curl -s -X POST $BASE/connections \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"connectionId\": \"$ID\"}" | jq .status

# 2. Iniciar conexão (gerar QR)
curl -s -X POST $BASE/connections/$ID/connect \
  -H "Authorization: Bearer $TOKEN" | jq .status

# 3. Aguardar QR (repetir até aparecer)
curl -s $BASE/connections/$ID/qr \
  -H "Authorization: Bearer $TOKEN" | jq .qrCode

# 4. Verificar status após escanear
curl -s $BASE/connections/$ID/status \
  -H "Authorization: Bearer $TOKEN" | jq .status
# → "open"

# 5. Enviar mensagem
curl -s -X POST $BASE/connections/$ID/messages/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"type":"text","to":"5511999999999@s.whatsapp.net","text":"Funcionando!"}' \
  | jq .key

# 6. Listar grupos
curl -s $BASE/connections/$ID/groups \
  -H "Authorization: Bearer $TOKEN" | jq 'keys'
```
