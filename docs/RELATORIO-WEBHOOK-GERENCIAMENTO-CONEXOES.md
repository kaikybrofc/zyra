# Relatório técnico: adaptação do Zyra para gerenciamento de conexões via webhook

## Objetivo

Este documento descreve, em nível arquitetural e operacional, o que precisa mudar no Zyra para que o gerenciamento das conexões deixe de depender apenas do boot do processo e do pairing por terminal, passando a aceitar controle externo por webhook.

A ideia central é transformar o runtime atual em um **gerenciador de conexões controlável por API/webhook**, permitindo que outro sistema dispare ações como:

- criar ou registrar uma conexão
- iniciar pairing
- consultar status
- reconectar
- desconectar
- pausar
- reativar
- remover sessão
- receber eventos de mudança de estado

---

## Resumo executivo

Hoje o projeto já suporta **multi-conexão por `connection_id`**, mas o ciclo de vida dessas conexões ainda é fortemente orientado a:

1. variáveis de ambiente (`WA_CONNECTION_ID`, `WA_CONNECTION_IDS`)
2. descoberta inicial no MySQL (`auth_creds`)
3. restart do processo para incorporar novas sessões
4. pairing feito por terminal (`npm run session:pair`)

Para aceitar gerenciamento por webhook, o sistema precisa evoluir em 6 frentes:

1. **expor uma camada HTTP de controle**
2. **separar o gerenciamento de runtime em um service dedicado**
3. **persistir estado administrativo da conexão além das credenciais do Baileys**
4. **introduzir máquina de estados operacional por conexão**
5. **proteger o webhook com autenticação, idempotência e auditoria**
6. **opcionalmente emitir callbacks/webhooks de saída para sincronizar o painel externo**

A principal mudança conceitual é esta:

> `auth_creds` hoje prova que uma sessão existe; no novo modelo isso não basta. O sistema também precisa saber se a sessão está habilitada, pausada, em pairing, em erro, aguardando reconexão, removida ou bloqueada por política.

---

## Estado atual da arquitetura

### 1. Como o boot funciona hoje

O bootstrap atual valida ambiente e chama `start()`:

- `src/index.ts`
- `src/bootstrap/start.ts`

No `start()`:

- o schema MySQL é garantido
- as conexões iniciais são resolvidas
- para cada `connection_id` é criado um runtime em memória
- a reconexão inicial chama `replaceSocket()`

### 2. De onde vêm as conexões iniciais

Hoje as conexões sobem a partir desta prioridade:

1. `WA_CONNECTION_IDS`
2. `auth_creds.connection_id` no MySQL
3. `WA_CONNECTION_ID`

Isso significa que o sistema **descobre sessões salvas**, mas não mantém um cadastro administrativo explícito de conexões.

### 3. Como uma conexão existe em memória

Em `src/bootstrap/start.ts`, cada conexão tem um runtime com:

- `connectionId`
- `activeSocket`
- `reconnectPromise`
- `socketGeneration`
- `lastReconnectAt`

Esse runtime é útil, mas ainda é interno ao bootstrap. Ele não foi desenhado como uma API de controle reutilizável por webhook.

### 4. Como o socket é criado

Em `src/core/connection/socket.ts`, `createSocket(connectionId, logger)`:

- resolve auth state
- resolve a versão do Baileys
- cria store
- monta o socket
- registra listeners de `connection.update`
- agenda persistência de credenciais
- registra shutdown gracioso

Esse arquivo já concentra bem a criação do socket, o que é ótimo. O problema é que **o gerenciamento de alto nível do ciclo de vida ainda está espalhado entre `start.ts`, `register.ts` e `pair.ts`**.

### 5. Como o pairing funciona hoje

O pairing atual está em:

- `src/core/connection/pair.ts`

Fluxo atual:

1. recebe `--connection <id>`
2. exige `MYSQL_URL`
3. cria socket temporário
4. espera QR / login / abertura
5. persiste creds
6. valida a sessão subindo outro socket
7. reinicia o PM2 para incluir a conexão

Esse modelo funciona, mas depende de terminal e de restart operacional. Isso não é ideal para um cenário controlado por webhook.

### 6. O que já existe de HTTP

O projeto já usa `node:http` no endpoint de métricas do anti-ban:

- `src/observability/antiban-metrics.ts`

Ou seja, já existe um padrão interno compatível com servidor HTTP nativo, sem precisar introduzir Express por obrigação.

### 7. Lacuna principal

Existe configuração de health (`WA_HEALTH_*`) em `src/config/index.ts`, mas não há um plano central de API administrativa para conexão.

Conclusão:

- a base multi-instância já existe
- o isolamento por `connection_id` já existe
- a persistência de auth já existe
- a auditoria operacional já existe parcialmente
- falta a **camada de controle administrativo online**

---

## Meta de arquitetura

A meta recomendada é esta:

```text
Sistema externo
   |
   | POST /webhooks/connections
   v
Control API / Webhook Ingress
   |
   v
Connection Manager Service
   |
   +--> Runtime Registry (memória)
   +--> Socket Lifecycle Service
   +--> Pairing Service
   +--> Connection State Store (MySQL)
   +--> Event Outbox / Callback Dispatcher
```

O ponto mais importante é introduzir um **Connection Manager Service** como orquestrador único.

---

## O que precisa mudar

# 1. Criar uma camada HTTP de webhook

## Problema atual

O runtime não expõe um endpoint administrativo para receber comandos externos.

## Mudança necessária

Criar um servidor HTTP interno para controle operacional.

## Recomendação

Como o projeto já usa `node:http`, o caminho mais consistente é começar com servidor HTTP nativo, sem adicionar framework agora. Se depois o volume de rotas crescer, aí sim faz sentido migrar para Fastify.

## Estrutura sugerida

Criar algo como:

- `src/http/server.ts`
- `src/http/router.ts`
- `src/http/handlers/connection-webhook.ts`
- `src/http/handlers/connection-query.ts`
- `src/http/middleware/auth.ts`
- `src/http/middleware/idempotency.ts`

## Endpoints mínimos

### Inbound webhook de comando

- `POST /webhooks/connections`

### Consulta de status

- `GET /connections`
- `GET /connections/:id`

### Ações administrativas diretas

- `POST /connections/:id/start`
- `POST /connections/:id/reconnect`
- `POST /connections/:id/disconnect`
- `POST /connections/:id/pairing/start`
- `POST /connections/:id/pairing/cancel`
- `DELETE /connections/:id`

## Observação importante

Mesmo que o nome pedido seja “webhook”, vale separar:

- **webhook de entrada**: recebe ordem de outro sistema
- **API administrativa interna**: consulta e ações específicas

Na prática, o webhook pode só traduzir o payload em comandos internos.

---

# 2. Extrair o gerenciamento de conexões do `start.ts` para um serviço dedicado

## Problema atual

O `src/bootstrap/start.ts` gerencia:

- registry em memória
- create/replace socket
- reconnect sequencing
- startup loading

Isso dificulta reutilizar a mesma lógica para requisições vindas do webhook.

## Mudança necessária

Extrair um serviço, por exemplo:

- `src/core/connection/manager.ts`

## Responsabilidades desse manager

Ele deve virar a única interface para:

- registrar conexão
- iniciar conexão
- parar conexão
- reconectar conexão
- iniciar pairing
- concluir pairing
- remover conexão
- consultar status
- listar conexões
- aplicar política de auto-reconnect
- atualizar estado persistido

## Interface sugerida

```ts
interface ConnectionManager {
  bootstrap(): Promise<void>
  ensureRegistered(connectionId: string, input?: RegisterConnectionInput): Promise<void>
  startConnection(connectionId: string, reason: string): Promise<void>
  reconnectConnection(connectionId: string, reason: string): Promise<void>
  disconnectConnection(connectionId: string, reason: string): Promise<void>
  pauseConnection(connectionId: string, reason: string): Promise<void>
  resumeConnection(connectionId: string, reason: string): Promise<void>
  removeConnection(connectionId: string, mode: 'soft' | 'hard'): Promise<void>
  getConnectionStatus(connectionId: string): Promise<ConnectionStatusView | null>
  listConnections(): Promise<ConnectionStatusView[]>
}
```

## Resultado esperado

O `start.ts` deixa de ser “dono” da lógica de conexão e passa a ser apenas o bootstrap inicial do manager.

---

# 3. Introduzir persistência administrativa de conexões

## Problema atual

Hoje a existência da sessão é inferida de:

- `auth_creds`
- `signal_keys`
- eventualmente `WA_CONNECTION_IDS`

Isso não resolve necessidades administrativas como:

- conexão cadastrada mas ainda não pareada
- conexão pausada por decisão externa
- conexão removida logicamente
- conexão bloqueada por política
- conexão em processo de pairing
- última origem da ação administrativa

## Mudança necessária

Criar uma tabela administrativa nova, por exemplo:

## Tabela `managed_connections`

Campos sugeridos:

- `connection_id` PK
- `display_name`
- `status`
- `desired_state`
- `enabled`
- `pairing_state`
- `pairing_code`
- `last_seen_at`
- `last_connected_at`
- `last_disconnected_at`
- `last_disconnect_code`
- `last_error`
- `webhook_source`
- `metadata_json`
- `created_at`
- `updated_at`

## Semântica recomendada

### `status`

Estado observado do runtime:

- `inactive`
- `starting`
- `connecting`
- `open`
- `closing`
- `closed`
- `pairing`
- `error`
- `paused`
- `deleted`

### `desired_state`

Estado desejado pela camada administrativa:

- `running`
- `stopped`
- `paused`
- `deleted`

### `pairing_state`

- `not_required`
- `pending`
- `qr_ready`
- `paired`
- `expired`
- `failed`

## Benefício

Isso elimina a dependência de usar `auth_creds` como catálogo de conexões.

---

# 4. Adicionar máquina de estados por conexão

## Problema atual

Hoje há eventos operacionais, mas não uma máquina de estados formal.

Sem isso, o webhook corre risco de disparar ações inconsistentes, por exemplo:

- reconectar algo que está em pairing
- deletar enquanto `replaceSocket()` está em andamento
- iniciar duas reconexões concorrentes
- receber `start` para uma conexão pausada por política

## Mudança necessária

Formalizar transições válidas.

## Estado sugerido

```text
inactive -> starting -> connecting -> open
open -> closing -> closed
closed -> starting
closed -> pairing
pairing -> qr_ready
qr_ready -> paired
paired -> starting
any -> error
any -> paused
paused -> starting
any -> deleted
```

## Regras operacionais importantes

1. só pode haver **uma operação mutável por conexão por vez**
2. cada conexão precisa de um **lock lógico**
3. o estado persistido precisa refletir o observado pelo socket
4. o estado desejado precisa guiar o auto-reconnect

## Implementação sugerida

Dentro do manager, cada runtime passa a ter algo como:

- `operationPromise`
- `operationType`
- `desiredState`
- `observedState`
- `lastCommandId`

---

# 5. Separar “socket runtime” de “controle administrativo”

## Problema atual

O socket reage a `connection.update`, mas as decisões administrativas não estão centralizadas.

## Mudança necessária

Criar duas camadas:

### A. Camada de runtime

Responsável por:

- criar socket
- bindar store
- ouvir eventos do Baileys
- salvar creds
- encerrar socket

### B. Camada de controle

Responsável por:

- decidir se reconecta
- decidir se pausa
- decidir se tenta pairing
- aplicar comandos do webhook
- atualizar `managed_connections`
- emitir eventos para sistemas externos

## Efeito prático

`registerEvents()` e `socket.ts` continuam sendo runtime Baileys.
O manager vira o cérebro administrativo.

---

# 6. Adaptar o fluxo de pairing para uso remoto

## Problema atual

O pairing depende de terminal e de QR renderizado localmente.

## Mudança necessária

Criar um **Pairing Service** compatível com webhook.

## Cenários possíveis

### Cenário A: pairing por QR remoto

Fluxo:

1. sistema externo chama `POST /connections/:id/pairing/start`
2. Zyra cria socket em modo pairing
3. QR é capturado de `connection.update`
4. QR é salvo temporariamente
5. QR é devolvido na resposta ou emitido via callback
6. cliente escaneia
7. Zyra detecta `isNewLogin` / `open`
8. creds são persistidas
9. manager faz transição para `running`

### Cenário B: pairing por phone-number / code

Se o stack suportar código de pareamento além de QR, o fluxo pode expor esse código da mesma forma.

## O que precisa mudar no código

O conteúdo de `src/core/connection/pair.ts` não deve continuar acoplado a CLI.

Extrair:

- `src/core/connection/pairing-service.ts`

Esse serviço deve oferecer algo como:

```ts
interface PairingService {
  startPairing(connectionId: string): Promise<PairingStartResult>
  getPairingState(connectionId: string): Promise<PairingStateView>
  cancelPairing(connectionId: string): Promise<void>
}
```

## O que sai do CLI

O script `session:pair` pode continuar existindo, mas apenas como cliente desse serviço interno, e não como implementação principal.

---

# 7. Não depender mais de restart do PM2 para novas conexões

## Problema atual

No pairing atual, depois de validar a sessão, o script tenta reiniciar o PM2 para atualizar `WA_CONNECTION_IDS`.

Isso é um forte indício de que a fonte de verdade ainda é o ambiente do processo.

## Mudança necessária

Depois que houver `managed_connections`, novas conexões devem ser incorporadas **online**, sem reiniciar o processo.

## Nova regra

- `WA_CONNECTION_IDS` pode continuar como seed inicial opcional
- `managed_connections` passa a ser a fonte de verdade operacional
- `auth_creds` continua sendo fonte de verdade das credenciais

## No boot

O manager deve carregar conexões de:

1. `managed_connections` onde `desired_state = running`
2. opcionalmente `WA_CONNECTION_IDS` que ainda não existam no cadastro
3. opcionalmente `auth_creds`, mas só se quiser migrar sessões legadas

## Recomendação de compatibilidade

Durante a transição:

- se `managed_connections` estiver vazia, usar o comportamento legado
- depois da migração, promover `managed_connections` como principal

---

# 8. Criar contrato de webhook robusto

## Problema atual

Ainda não existe contrato formal de payload.

## Mudança necessária

Definir payload versionado, idempotente e explícito.

## Payload de entrada sugerido

```json
{
  "event": "connection.command",
  "version": "2026-05-24",
  "command_id": "cmd_01JXXXX",
  "sent_at": "2026-05-24T21:00:00Z",
  "connection": {
    "id": "loja-001",
    "display_name": "Loja 001"
  },
  "action": {
    "type": "start",
    "reason": "ativacao-no-painel"
  },
  "options": {
    "force": false
  },
  "metadata": {
    "tenant_id": "tenant_123",
    "requested_by": "painel-admin"
  }
}
```

## Tipos de ação sugeridos

- `register`
- `start`
- `reconnect`
- `disconnect`
- `pause`
- `resume`
- `pairing_start`
- `pairing_cancel`
- `delete_soft`
- `delete_hard`
- `sync_status`

## Resposta sugerida

```json
{
  "ok": true,
  "command_id": "cmd_01JXXXX",
  "connection_id": "loja-001",
  "accepted": true,
  "current_state": "starting",
  "desired_state": "running"
}
```

## Importante

A resposta HTTP deve indicar:

- comando aceito
- comando rejeitado
- comando duplicado
- comando inválido para o estado atual

---

# 9. Implementar idempotência e deduplicação

## Problema atual

Webhooks podem ser reenviados.

Sem deduplicação, o sistema pode:

- iniciar duas conexões ao mesmo tempo
- disparar dois pairings
- sobrescrever estado por replay

## Mudança necessária

Criar uma tabela, por exemplo `webhook_commands`:

- `command_id` PK
- `connection_id`
- `action_type`
- `payload_json`
- `status`
- `response_json`
- `received_at`
- `processed_at`

## Regra

Se chegar o mesmo `command_id` novamente:

- não reexecutar
- devolver o resultado anterior

---

# 10. Adicionar autenticação forte no webhook

## Problema atual

Um endpoint que controla conexão do WhatsApp tem impacto alto. Não pode aceitar chamadas sem autenticação forte.

## Mudança necessária

Implementar no mínimo um destes modelos:

### Modelo recomendado para começar

- header `x-zyra-signature`
- HMAC SHA-256 do corpo bruto
- timestamp em header
- tolerância pequena de replay, por exemplo 5 minutos

### Headers sugeridos

- `x-zyra-signature`
- `x-zyra-timestamp`
- `x-zyra-delivery-id`

## Validações obrigatórias

1. assinatura válida
2. timestamp dentro da janela
3. delivery id não repetido
4. content-type esperado
5. tamanho máximo do body

## Se houver painel interno confiável

Pode também usar:

- bearer token interno
- allowlist de IP
- mTLS

Mas HMAC continua sendo a melhor base para webhook puro.

---

# 11. Persistir auditoria administrativa separada da auditoria Baileys

## Problema atual

`events_log` e `message_events` registram o mundo do Baileys e das mensagens, mas não substituem auditoria de controle.

## Mudança necessária

Criar algo como `connection_admin_events`.

Campos sugeridos:

- `id`
- `connection_id`
- `event_type`
- `actor`
- `source`
- `old_state`
- `new_state`
- `payload_json`
- `created_at`

## Eventos úteis

- `webhook.received`
- `connection.registered`
- `connection.started`
- `connection.opened`
- `connection.closed`
- `connection.reconnect_scheduled`
- `connection.paused`
- `connection.resumed`
- `pairing.started`
- `pairing.qr_ready`
- `pairing.completed`
- `pairing.failed`
- `connection.deleted`

---

# 12. Emitir webhooks de saída para sincronizar o sistema externo

## Problema atual

Se o sistema externo só envia comando, mas não recebe retorno assíncrono, ele fica cego para eventos como:

- QR disponível
- conexão aberta
- sessão invalidada
- reconnect falhou
- pairing concluído

## Mudança necessária

Criar **event callbacks** de saída.

## Eventos recomendados

- `connection.status.changed`
- `connection.qr.updated`
- `connection.pairing.completed`
- `connection.pairing.failed`
- `connection.auth.logged_out`
- `connection.error`

## Estrutura sugerida

```json
{
  "event": "connection.status.changed",
  "version": "2026-05-24",
  "occurred_at": "2026-05-24T21:05:00Z",
  "connection": {
    "id": "loja-001"
  },
  "state": {
    "previous": "connecting",
    "current": "open",
    "desired": "running"
  },
  "details": {
    "status_code": null
  }
}
```

## Recomendação técnica

Não enviar callbacks diretamente no meio do handler do Baileys. Melhor usar **outbox**.

### Tabela `webhook_outbox`

- `id`
- `event_type`
- `connection_id`
- `target_url`
- `payload_json`
- `status`
- `attempt_count`
- `next_attempt_at`
- `last_error`
- `created_at`

Um worker entrega com retry e backoff.

---

# 13. Integrar `connection.update` à máquina de estados persistida

## Problema atual

Hoje `registerEvents()` reage a `connection.update` para log, restart e sync. Mas isso ainda não alimenta um estado administrativo persistente.

## Mudança necessária

Toda mudança relevante de `connection.update` deve atualizar `managed_connections`.

## Exemplos

### Quando `connection === 'open'`

Atualizar:

- `status = open`
- `last_connected_at = now`
- `last_seen_at = now`
- `last_error = null`

### Quando `connection === 'close'`

Atualizar:

- `status = closed` ou `error`
- `last_disconnected_at = now`
- `last_disconnect_code = statusCode`
- `last_error` se houver

### Quando `DisconnectReason.loggedOut`

Atualizar:

- `status = error`
- `pairing_state = pending`
- `desired_state = stopped` ou `paused`, conforme política

## Importante

A decisão “reconectar ou não” precisa sair de um if espalhado e passar a respeitar:

- `desired_state`
- `enabled`
- `paused`
- política anti-ban
- se há pairing em curso

---

# 14. Controlar reconexão com política explícita

## Problema atual

A reconexão hoje é automática, com trava contra paralelismo, mas sem política administrativa mais rica.

## Mudança necessária

Criar política por conexão, persistida, por exemplo em `metadata_json` ou colunas dedicadas:

- `auto_reconnect_enabled`
- `max_reconnect_attempts`
- `reconnect_backoff_base_ms`
- `reconnect_backoff_max_ms`
- `pause_on_logged_out`
- `pause_on_reachout_463`

## Regra recomendada

O manager decide reconectar apenas se:

- `desired_state = running`
- `enabled = true`
- `status != paused`
- `pairing_state` não estiver ativo
- não houver lock administrativo

---

# 15. Tratar QR e artefatos efêmeros corretamente

## Problema atual

Hoje o QR é renderizado no terminal.

## Mudança necessária

O QR precisa ser tratado como artefato efêmero e sensível.

## Requisitos

1. nunca persistir QR indefinidamente
2. salvar com TTL curto
3. invalidar QR anterior quando um novo chegar
4. não logar QR puro em texto em produção
5. opcionalmente expor como imagem base64 ou string crua conforme o cliente precisar

## Estrutura sugerida em memória

Por runtime:

- `currentQr`
- `qrUpdatedAt`
- `qrExpiresAt`

## Persistência opcional

Se precisar reintegrar com outro processo:

- Redis com TTL curto

---

# 16. Definir claramente o que é “deletar conexão”

## Problema atual

Hoje já existe `db:delete-session`, mas isso é um script destrutivo de manutenção, não uma ação administrativa online refinada.

## Mudança necessária

Separar dois modos:

### Soft delete

- marca como `deleted`
- encerra socket
- remove da operação normal
- preserva histórico
- pode preservar credenciais conforme política

### Hard delete

- encerra socket
- apaga `auth_creds`
- apaga `signal_keys`
- limpa caches Redis
- opcionalmente apaga diretório local de auth
- mantém ou não trilhas históricas conforme política do produto

## Importante

Hard delete deve exigir proteção extra no webhook.

---

# 17. Criar um repositório/DAO para conexões gerenciadas

## Problema atual

A lógica de persistência administrativa ficaria espalhada se for escrita diretamente nos handlers.

## Mudança necessária

Criar algo como:

- `src/store/connection-admin-store.ts`

## Responsabilidades

- CRUD de `managed_connections`
- gravação de `connection_admin_events`
- gravação/leitura de `webhook_commands`
- gravação de `webhook_outbox`

## Benefício

Mantém o padrão do projeto, que já usa stores para SQL, Redis e recursos de grupo.

---

# 18. Atualizar o schema MySQL

## Problema atual

`initMysqlSchema()` hoje prepara o schema principal e `group_config`, mas não contempla controle administrativo de webhook.

## Mudança necessária

Adicionar DDL para:

- `managed_connections`
- `connection_admin_events`
- `webhook_commands`
- `webhook_outbox`

## Recomendação

Como `initMysqlSchema()` consome o modelo a partir de `docs/exemplodbmodel.md`, existem duas opções:

### Opção A

Atualizar `docs/exemplodbmodel.md` com as novas tabelas.

### Opção B

Manter o modelo principal como está e criar complementos imperativos em `initMysqlSchema()`.

## Recomendação prática

Para consistência do projeto, a melhor direção é:

- refletir essas tabelas também no documento de schema
- garantir criação incremental em `initMysqlSchema()`

---

# 19. Revisar o boot para coexistir com o modo legado e o modo webhook

## Problema atual

O sistema atual sobe tudo no boot com base em env/MySQL auth.

## Mudança necessária

Adicionar um modo configurável, por exemplo:

- `WA_CONNECTION_CONTROL_MODE=legacy|managed|hybrid`

## Semântica

### `legacy`

Comportamento atual.

### `managed`

Só sobe conexões marcadas em `managed_connections`.

### `hybrid`

Usa `managed_connections` como prioridade, mas ainda importa sessões legadas detectadas em `auth_creds`.

## Melhor estratégia de rollout

Começar com `hybrid`.

---

# 20. Criar regras de concorrência por conexão

## Problema atual

Já existe proteção parcial via `reconnectPromise`, mas o novo modelo terá mais comandos concorrentes.

## Mudança necessária

Cada `connection_id` precisa de serialização explícita para operações administrativas.

## Ações que devem ser serializadas

- start
- stop
- reconnect
- pairing_start
- pairing_cancel
- delete
- pause
- resume

## Solução simples

No manager, manter um mutex por `connection_id`.

## Solução mais robusta

- lock em memória por processo
- se houver múltiplos processos no futuro, lock distribuído em Redis/MySQL

Como hoje o PM2 roda `instances: 1`, lock em memória já resolve o caso imediato.

---

# 21. Expor status observável para painel externo

## Problema atual

Há métricas operacionais, mas não uma visão administrativa consolidada por conexão.

## Mudança necessária

Criar DTO de status administrativo.

## Payload sugerido de consulta

```json
{
  "connection_id": "loja-001",
  "display_name": "Loja 001",
  "enabled": true,
  "desired_state": "running",
  "status": "open",
  "pairing_state": "not_required",
  "socket_generation": 4,
  "reconnect_in_flight": false,
  "last_connected_at": "2026-05-24T21:03:00Z",
  "last_disconnected_at": null,
  "last_disconnect_code": null,
  "last_error": null
}
```

## Origem dos dados

- parte vem do runtime em memória
- parte vem de `managed_connections`
- parte vem dos eventos recentes do socket

---

# 22. Amarrar health e readiness ao novo modelo

## Problema atual

Existe configuração de health, mas a visão de prontidão por conexão ainda não está clara.

## Mudança necessária

Criar endpoints como:

- `GET /health/live`
- `GET /health/ready`
- `GET /health/connections`

## Semântica sugerida

### liveness

Processo está de pé.

### readiness

MySQL/Redis acessíveis e control plane pronto.

### connections

Resumo por conexão:

- quantas `open`
- quantas `connecting`
- quantas `paused`
- quantas `error`

---

# 23. Pensar em segurança operacional do QR e das credenciais

## Pontos críticos

### Credenciais

Nunca devolver `creds_json`, `signal_keys` ou dados equivalentes por webhook.

### QR

QR dá acesso à sessão. Deve ser tratado como segredo temporário.

### Logs

Não logar payloads sensíveis do webhook por completo se contiverem segredos.

### Delete hard

Exigir autenticação reforçada e, idealmente, dupla confirmação no sistema chamador.

---

# 24. Plano de mudanças por arquivo

## Arquivos que devem ser alterados

### `src/bootstrap/start.ts`

Hoje:

- resolve conexões
- mantém runtimes
- agenda reconnect

Depois:

- instancia `ConnectionManager`
- chama `manager.bootstrap()`
- não concentra mais as regras de negócio de conexão

### `src/core/connection/socket.ts`

Hoje:

- cria socket
- persiste creds
- ouve `connection.update`

Depois:

- continua sendo factory/runtime
- mas passa a notificar o manager por callbacks mais estruturados

### `src/events/register.ts`

Hoje:

- reage a `connection.update`
- decide parte do fluxo de reconexão

Depois:

- continua registrando eventos Baileys
- mas reconexão e estado administrativo devem depender do manager

### `src/core/connection/pair.ts`

Hoje:

- pairing via terminal
- validação
- restart do PM2

Depois:

- vira cliente de um `pairing-service`
- não precisa mais ser a implementação principal

### `src/core/db/init.ts`

Depois:

- cria as novas tabelas administrativas

### `src/config/index.ts`

Depois:

- novas configs para webhook/control plane
- secrets HMAC
- modo de controle
- URLs de callback

## Arquivos novos recomendados

- `src/core/connection/manager.ts`
- `src/core/connection/runtime-registry.ts`
- `src/core/connection/pairing-service.ts`
- `src/store/connection-admin-store.ts`
- `src/http/server.ts`
- `src/http/router.ts`
- `src/http/handlers/connection-webhook.ts`
- `src/http/handlers/connection-actions.ts`
- `src/http/handlers/connection-query.ts`
- `src/http/middleware/webhook-auth.ts`
- `src/http/middleware/idempotency.ts`
- `src/core/webhooks/outbox-dispatcher.ts`

---

# 25. Configurações novas sugeridas

Adicionar variáveis como:

- `WA_CONTROL_API_ENABLED=true`
- `WA_CONTROL_API_HOST=0.0.0.0`
- `WA_CONTROL_API_PORT=9110`
- `WA_CONTROL_API_BASE_PATH=/api`
- `WA_WEBHOOK_SHARED_SECRET=...`
- `WA_WEBHOOK_MAX_BODY_BYTES=262144`
- `WA_WEBHOOK_TIMESTAMP_TOLERANCE_MS=300000`
- `WA_CONNECTION_CONTROL_MODE=hybrid`
- `WA_WEBHOOK_OUTBOX_ENABLED=true`
- `WA_WEBHOOK_OUTBOX_BATCH_SIZE=50`
- `WA_WEBHOOK_OUTBOX_RETRY_BASE_MS=5000`
- `WA_WEBHOOK_OUTBOX_RETRY_MAX_MS=300000`

---

# 26. Etapas de implementação recomendadas

## Fase 1 — fundação administrativa

Objetivo: introduzir modelo sem quebrar o fluxo atual.

### Passos

1. criar `managed_connections`
2. criar `connection_admin_events`
3. criar `connection-admin-store`
4. extrair `ConnectionManager`
5. mover o registry de runtimes de `start.ts` para o manager
6. manter boot atual funcionando via manager

## Entrega esperada

Nada de webhook ainda, mas o código já fica preparado.

---

## Fase 2 — HTTP de controle

Objetivo: aceitar comandos externos simples.

### Passos

1. criar servidor HTTP nativo
2. criar rota `POST /webhooks/connections`
3. validar assinatura HMAC
4. validar payload e `command_id`
5. persistir `webhook_commands`
6. traduzir ação em chamada ao manager

## Entrega esperada

Já dá para:

- registrar conexão
- iniciar
- reconectar
- pausar
- consultar status

---

## Fase 3 — pairing remoto

Objetivo: remover dependência de terminal.

### Passos

1. extrair `pairing-service`
2. permitir pairing por endpoint
3. capturar QR do socket
4. armazenar QR efêmero
5. publicar QR para consulta/callback
6. concluir pairing e atualizar estado persistido

## Entrega esperada

Novo `connection_id` pode ser gerado e ativado sem restart do PM2.

---

## Fase 4 — callbacks de saída

Objetivo: integrar painel externo em tempo real.

### Passos

1. criar `webhook_outbox`
2. criar dispatcher com retry
3. emitir eventos de status
4. emitir QR atualizado
5. emitir erro e logout

## Entrega esperada

Sistema externo acompanha o ciclo sem polling pesado.

---

## Fase 5 — desligamento do legado operacional

Objetivo: reduzir dependência de env e CLI.

### Passos

1. promover `managed_connections` como fonte primária
2. reduzir uso de `WA_CONNECTION_IDS`
3. deixar `session:pair` como utilitário opcional
4. ajustar documentação operacional

---

# 27. Estratégia de migração dos dados atuais

## Situação atual

Existem sessões já persistidas em `auth_creds`.

## Estratégia recomendada

No primeiro boot em modo `hybrid`:

1. ler `managed_connections`
2. ler `auth_creds`
3. para cada `connection_id` em `auth_creds` que não existir em `managed_connections`, criar um registro automático com:
   - `status = inactive`
   - `desired_state = running`
   - `enabled = true`
   - `pairing_state = not_required`
   - `webhook_source = migration.auth_creds`
4. registrar evento administrativo de migração

## Benefício

Compatibilidade sem perder sessões existentes.

---

# 28. Testes que precisam existir

## Testes unitários

### Manager

- registra conexão nova
- impede start duplicado
- serializa reconnect concorrente
- respeita `desired_state`
- não reconecta conexão pausada

### Webhook auth

- aceita assinatura válida
- rejeita assinatura inválida
- rejeita replay vencido

### Idempotência

- segundo envio do mesmo `command_id` não reexecuta

### Pairing service

- transita para `qr_ready`
- conclui com `paired`
- expira corretamente

## Testes de integração

- webhook `start` sobe conexão
- webhook `pause` impede auto-reconnect
- webhook `delete_hard` limpa auth state
- `connection.update=open` atualiza banco
- `DisconnectReason.loggedOut` muda para `pending pairing`

## Testes operacionais

- múltiplos comandos simultâneos na mesma conexão
- múltiplas conexões em paralelo
- restart do processo com estado persistido
- retry de callback de saída

---

# 29. Riscos e cuidados

## Risco 1 — conflito entre runtime e estado persistido

Se o socket fechar e o banco não refletir isso, o painel externo verá estado errado.

### Mitigação

- toda transição de estado deve passar por helper único
- persistir estado e evento administrativo no mesmo fluxo lógico

## Risco 2 — pairing concorrente

Dois pairings para o mesmo `connection_id` podem corromper o ciclo.

### Mitigação

- mutex por conexão
- `pairing_state` bloqueando segunda tentativa

## Risco 3 — replay de webhook

Pode repetir ação destrutiva.

### Mitigação

- `command_id`
- tabela de idempotência
- assinatura com timestamp

## Risco 4 — QR vazando em logs

### Mitigação

- não logar QR completo
- TTL curto
- callback seguro

## Risco 5 — hard delete apagar sessão ativa por engano

### Mitigação

- bloquear se socket estiver ativo, a menos que `force=true`
- exigir escopo administrativo maior

---

# 30. Proposta de ordem prática de execução no código

## Ordem ideal

1. criar tabelas administrativas
2. criar `connection-admin-store`
3. extrair `ConnectionManager`
4. adaptar `start.ts` para usar o manager
5. ligar `connection.update` ao estado persistido
6. criar servidor HTTP
7. criar autenticação HMAC
8. criar webhook de entrada
9. extrair `pairing-service`
10. adicionar pairing remoto
11. adicionar outbox de callbacks
12. expandir testes

---

## Checklist de implementação

### Banco

- [x] criar `managed_connections`
- [x] criar `connection_admin_events`
- [x] criar `webhook_commands`
- [x] criar `webhook_outbox`

### Core

- [x] criar `connection-admin-store`
- [x] extrair `ConnectionManager`
- [x] mover registry de runtimes para o manager
- [x] formalizar estados observados e desejados
- [x] adicionar lock por `connection_id`

### HTTP

- [x] subir servidor HTTP administrativo
- [x] implementar autenticação HMAC
- [x] implementar parsing seguro do body
- [x] implementar validação de payload

### Pairing

- [x] extrair `PairingService`
- [x] capturar QR sem terminal
- [x] expor QR por endpoint/callback
- [x] concluir pairing sem restart do PM2

### Observabilidade

- [x] persistir eventos administrativos
- [x] expor status consolidado por conexão
- [x] emitir callbacks de saída

### Compatibilidade

- [x] adicionar modo `hybrid`
- [x] migrar sessões legadas de `auth_creds`
- [x] manter CLI funcionando como fallback

---

# Conclusão

O Zyra já tem a parte mais difícil pronta:

- isolamento por `connection_id`
- suporte multi-conexão
- persistência de auth em MySQL/Redis/disco
- ciclo de reconnect
- auditoria operacional do Baileys

O que falta para aceitar gerenciamento por webhook não é refazer o motor de conexão, e sim adicionar um **plano de controle administrativo** sobre esse motor.

A mudança estrutural principal é:

1. sair de um modelo centrado em boot/env/CLI
2. entrar em um modelo centrado em **Connection Manager + estado persistido + webhook autenticado**

Se isso for implementado por fases, o sistema pode evoluir com baixo risco:

- primeiro organiza o core
- depois expõe webhook
- depois adiciona pairing remoto
- por fim sincroniza tudo com callbacks

Esse é o caminho mais seguro para transformar o Zyra em uma plataforma de conexões gerenciáveis remotamente, sem perder a robustez do runtime atual.

---

## Referências do código atual analisado

- `src/index.ts`
- `src/bootstrap/start.ts`
- `src/core/connection/socket.ts`
- `src/core/connection/pair.ts`
- `src/core/auth/state.ts`
- `src/core/auth/mysql-auth-state.ts`
- `src/events/register.ts`
- `src/observability/antiban-metrics.ts`
- `src/core/db/init.ts`
- `ecosystem.config.cjs`
