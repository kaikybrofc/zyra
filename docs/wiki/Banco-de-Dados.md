# Banco de Dados

Esta página apresenta o mapa de domínio do banco do Zyra. O MySQL 8 é a camada durável do sistema e a fonte de verdade para histórico, auditoria e relacionamentos operacionais.

A definição completa do schema está em `docs/exemplodbmodel.md`.

## Papel do MySQL no sistema

O MySQL é responsável por:

- persistência de credenciais e chaves de sessão
- histórico de mensagens e mídia
- auditoria de eventos, comandos e falhas
- reconciliação de identidade entre JID, PN, LID e aliases
- armazenamento durável para grupos, contatos, newsletters e blocklist
- suporte ao backfill e à recuperação de consistência derivada

## Boundary principal: `connection_id`

A maioria das entidades relevantes é isolada por `connection_id`.

Isso permite:

- múltiplas instâncias compartilhando o mesmo banco
- segregação por tenant/sessão
- auditoria por conexão
- execução segura de backfill e manutenção sem misturar dados entre bots

## Padrão importante de modelagem

O desenho do Zyra combina duas coisas ao mesmo tempo:

- **payload bruto** em JSON para flexibilidade e auditoria
- **colunas derivadas e relacionais** para consulta, indexação e uso operacional

Esse padrão é intencional. Parte da consistência relacional pode ser enriquecida ou corrigida mais tarde pelo worker de backfill.

## Blocos principais do schema

### Conexão e autenticação

- `connections`
- `auth_creds`
- `signal_keys`

Essas tabelas mantêm a identidade da conexão e o material necessário para preservar a sessão do WhatsApp.

### Identidade de usuário

- `users`
- `user_identifiers`
- `user_aliases`
- `lid_mappings`
- `user_devices`

Esse bloco resolve o problema de identidade unificada, conectando PN, LID, JID, aliases visíveis e dispositivos a um mesmo `user_id` lógico.

### Chats, mensagens e mídia

- `chats`
- `messages`
- `message_media`
- `message_text_index`
- `message_users`
- `chat_users`
- `message_events`
- `message_failures`

Esse conjunto suporta histórico, indexação textual, metadados de mídia, relações entre usuários e trilhas de falha.

### Grupos e governança social

- `groups`
- `group_participants`
- `group_events`
- `group_join_requests`
- `group_config`

### Auditoria e operação

- `events_log`
- `events_log_archive`
- `commands_log`
- `bot_sessions`
- `blocklist`
- `labels`
- `label_associations`

### Newsletters / canais

- `newsletters`
- `newsletter_participants`
- `newsletter_events`

### Recursos auxiliares

- `user_sticker_templates`
- `user_generated_stickers`
- `backfill_checkpoints`

## Tabelas especialmente importantes

### `messages`

Tabela central do histórico. Guarda identidade da mensagem, dados derivados e payload serializado.

### `message_media`

Armazena metadados de mídia, incluindo `local_path` quando o download automático está habilitado.

### `user_identifiers`

Camada central da reconciliação de identidade. Sem ela, JID, PN e LID ficariam desconectados e a auditoria perderia valor analítico.

### `events_log`

Registro de eventos amplos do runtime, útil para suporte, troubleshooting e trilhas operacionais.

### `commands_log`

Auditoria de execução de comandos no runtime.

### `backfill_checkpoints`

Permite que o worker contínuo retome processamento incremental sem reiniciar o trabalho inteiro.

## O que o banco resolve que memória e Redis não resolvem

- histórico durável
- auditoria completa
- relacionamento consistente entre entidades
- busca e análise posteriores
- recuperação após restart ou falha de processo
- base para backfill e reconciliação

Memória e Redis ajudam a performance; o MySQL preserva o estado de longo prazo e a rastreabilidade.

## Inicialização e manutenção

Comandos mais relevantes:

```bash
npm run db:init
npm run db:verify
npm run db:nulls
npm run db:backfill
npm run db:delete-session
npm run db:repair-group-participants
```

## Evolução de schema

O projeto privilegia:

- init idempotente para criar o que falta
- mudanças não destrutivas por padrão
- compatibilidade operacional em produção
- suporte posterior a enriquecimento via backfill

## Leituras relacionadas

- [Persistência](Persistência)
- [Backfill](Backfill)
- [Produção](Produção)
- `docs/exemplodbmodel.md`

---

**Zyra Wiki** • Última atualização: 17/05/2026
