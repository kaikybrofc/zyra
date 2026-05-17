# Eventos

Esta página resume como os eventos do Baileys entram no Zyra, quais são as categorias mais relevantes e quais efeitos colaterais operacionais o runtime produz.

A borda principal de entrada está em `src/events/register.ts`.

## Papel da camada de eventos

A camada de eventos é responsável por:

- receber eventos do WhatsApp via Baileys
- registrar auditoria e logs estruturados
- alimentar stores e persistência durável
- acionar o runtime de comandos quando aplicável
- disparar sincronizações e refreshes complementares

## Categorias principais de eventos

### Ciclo de conexão

- `connection.update`
- `creds.update`
- `messaging-history.set`

Esses eventos afetam bootstrap, reconexão, sync inicial, QR Code, persistência de credenciais e estabilização da sessão.

### Mensagens

- `messages.upsert`
- `messages.update`
- `messages.media-update`
- `messages.delete`
- `messages.reaction`
- `message-receipt.update`

`messages.upsert` é a principal porta de entrada do runtime de comandos quando o tipo é `notify`.

### Chats, contatos e presença

- `chats.upsert`
- `chats.update`
- `chats.delete`
- `contacts.upsert`
- `contacts.update`
- `presence.update`

Esses eventos mantêm estado operacional consistente em memória, Redis e SQL.

### Grupos e comunidades

- `groups.upsert`
- `groups.update`
- `group-participants.update`
- `group.join-request`
- `group.member-tag.update`

Além de auditoria, esses eventos atualizam participantes, papéis e visão relacional de grupos.

### Governança e suporte

- `blocklist.set`
- `blocklist.update`
- `labels.edit`
- `labels.association`
- `call`

### Newsletters / canais

- `newsletter.reaction`
- `newsletter.view`
- `newsletter-participants.update`
- `newsletter-settings.update`

A aplicação também tenta sincronizar metadados e tratar refresh de mídia de newsletters quando necessário.

## Pipeline de processamento

### Fluxo resumido

1. O evento chega ao `register.ts`.
2. O handler registra log estruturado e, quando aplicável, auditoria SQL.
3. Stores em memória/Redis/SQL são atualizadas.
4. Se for `messages.upsert` do tipo `notify`, a mensagem entra no router/runtime.
5. Tarefas adicionais podem ocorrer:
   - sync de grupos e comunidades
   - refresh de mídia
   - sync de newsletter metadata
   - persistência de falhas e snapshots auxiliares

## Efeitos colaterais operacionais importantes

### Auditoria SQL

A camada de eventos grava informações em estruturas como:

- `events_log`
- `message_events`
- `group_events`
- `newsletter_events`
- `message_failures`

Isso permite suporte, rastreamento e reconciliação posterior.

### Integração com comandos

A execução de comandos não nasce no módulo de comandos; ela começa aqui, a partir de `messages.upsert`, e depois segue para o router e processor.

### Grupos e comunidades

Na abertura da conexão, a aplicação tenta sincronizar grupos e comunidades para atualizar o estado conhecido logo após o login.

### Newsletters

Para newsletters/canais, o runtime pode:

- gravar snapshots
- registrar participantes e eventos
- sincronizar metadados com TTL/retry
- tentar refresh de mídia quando o payload chega incompleto

## Extensão segura da camada de eventos

Ao adicionar ou ajustar um handler:

- manter o comportamento idempotente sempre que possível
- preservar a auditoria e o logging estruturado
- evitar que falhas locais derrubem o fluxo global
- adicionar testes de cobertura próximos ao subsistema afetado

## Leituras relacionadas

- [Comandos](Comandos)
- [Persistência](Persistência)
- [Banco de Dados](Banco-de-Dados)

---

**Zyra Wiki** • Última atualização: 17/05/2026