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

| Status | Descrição |
|--------|-----------|
| `created` | Instância criada, sem socket |
| `connecting` | Socket sendo iniciado |
| `qr` | Aguardando escaneamento do QR |
| `open` | Autenticada e conectada |
| `closed` | Desconectada explicitamente |
| `error` | Falha durante a conexão |

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

### Reiniciar conexão

Desconecta e reconecta automaticamente. Útil para forçar um novo ciclo de autenticação.

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/restart \
  -H "Authorization: Bearer sua-chave-secreta" | jq
```

**Resposta `200`:** dados da instância com `status: "connecting"`.
**Resposta `404`:** instância não existe.

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

### Enviar mensagem de texto

A instância precisa estar com `status: "open"`.

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

Para grupos, use o JID do grupo como `to`:

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

**Resposta `200`:** objeto `WAMessage` retornado pelo Baileys.

---

### Enviar imagem

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/messages/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{
    "type": "image",
    "to": "5511999999999@s.whatsapp.net",
    "url": "https://example.com/imagem.jpg",
    "caption": "Legenda opcional"
  }' | jq
```

---

### Enviar vídeo

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/messages/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{
    "type": "video",
    "to": "5511999999999@s.whatsapp.net",
    "url": "https://example.com/video.mp4",
    "caption": "Legenda opcional"
  }' | jq
```

---

### Enviar áudio

```bash
curl -s -X POST http://localhost:3000/connections/minha-sessao/messages/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sua-chave-secreta" \
  -d '{
    "type": "audio",
    "to": "5511999999999@s.whatsapp.net",
    "url": "https://example.com/audio.mp3"
  }' | jq
```

---

### Enviar documento

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

**Campos do payload de mensagem:**

| Campo | Tipos | Obrigatório | Descrição |
|-------|-------|-------------|-----------|
| `type` | `text` \| `image` \| `video` \| `audio` \| `document` | sim | Tipo da mensagem |
| `to` | string | sim | JID do destinatário (`@s.whatsapp.net` ou `@g.us`) |
| `text` | string | para `text` | Conteúdo textual |
| `url` | string | para mídia | URL pública acessível pelo servidor WhatsApp |
| `caption` | string | não | Legenda (image/video) |
| `fileName` | string | não | Nome exibido (document) |
| `mimetype` | string | não | MIME type (document — padrão: `application/octet-stream`) |

**Erros possíveis:**

| Código | Motivo |
|--------|--------|
| `400` | Body inválido ou campo obrigatório ausente |
| `404` | Instância não encontrada |
| `409` | Instância não está `open` |
| `500` | Falha no envio pelo Baileys |

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

## Formato do JID

O WhatsApp identifica contatos e grupos por JID (Jabber ID):

| Tipo | Formato | Exemplo |
|------|---------|---------|
| Contato | `{ddi}{ddd}{numero}@s.whatsapp.net` | `5511999999999@s.whatsapp.net` |
| Grupo | `{id}@g.us` | `120363000000000001@g.us` |
| Newsletter | `{id}@newsletter` | `120363111111111111@newsletter` |

> O número deve incluir o código do país (55 para Brasil) sem o `+`.

---

## Respostas de erro padrão

Todos os erros seguem o formato:

```json
{ "error": "mensagem descritiva" }
```

| Código | Situação |
|--------|----------|
| `400` | Parâmetros inválidos ou ausentes |
| `401` | Token de autenticação ausente ou incorreto |
| `404` | Recurso não encontrado |
| `409` | Operação inválida para o estado atual |
| `500` | Erro interno do servidor |

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
