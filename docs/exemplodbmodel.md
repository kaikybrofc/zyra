# Modelo atual do banco (MySQL 8)

![Diagrama do banco](diagrama-db.svg)

Este arquivo descreve o schema do MySQL usado pelo Zyra para persistência e auditoria.
Ele também serve como **fonte da verdade** para a inicialização automática do schema via `npm run db:init` (o script lê este Markdown e cria as tabelas ausentes).

Observação importante: o `db:init` cria tabelas se não existirem, mas não faz migrações destrutivas (não remove colunas, não renomeia, não altera tipos). Mudanças estruturais precisam de um fluxo de migração.

## Estrutura de Dados (SQL)

```sql
CREATE TABLE connections (
  id VARCHAR(64) PRIMARY KEY,
  label VARCHAR(100) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE users (
  id BINARY(16) PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  display_name VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_conn (connection_id),
  CONSTRAINT fk_users_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_identifiers (
  connection_id VARCHAR(64) NOT NULL,
  user_id BINARY(16) NOT NULL,
  id_type ENUM('pn','lid','jid','username') NOT NULL,
  id_value VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, id_type, id_value),
  UNIQUE KEY uq_user_ident (connection_id, user_id, id_type, id_value),
  CONSTRAINT fk_user_ident_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_user_ident_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE auth_creds (
  connection_id VARCHAR(64) PRIMARY KEY,
  creds_json JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_auth_creds_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE signal_keys (
  connection_id VARCHAR(64) NOT NULL,
  key_type VARCHAR(64) NOT NULL,
  key_id VARCHAR(255) NOT NULL,
  value_json JSON NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, key_type, key_id),
  CONSTRAINT fk_signal_keys_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE chats (
  connection_id VARCHAR(64) NOT NULL,
  jid VARCHAR(128) NOT NULL,
  display_name VARCHAR(255) NULL,
  last_message_ts BIGINT NULL,
  unread_count INT NULL,
  data_json JSON NOT NULL,
  deleted_at TIMESTAMP NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, jid),
  CONSTRAINT fk_chats_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE wa_contacts_cache (
  connection_id VARCHAR(64) NOT NULL,
  jid VARCHAR(128) NOT NULL,
  user_id BINARY(16) NULL,
  display_name VARCHAR(255) NULL,
  data_json JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, jid),
  INDEX idx_contacts_cache_user (connection_id, user_id),
  CONSTRAINT fk_contacts_cache_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_contacts_cache_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE groups (
  connection_id VARCHAR(64) NOT NULL,
  jid VARCHAR(128) NOT NULL,
  subject VARCHAR(255) NULL,
  owner_user_id BINARY(16) NULL,
  announce TINYINT(1) NULL,
  `restrict` TINYINT(1) NULL,
  size INT NULL,
  data_json JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, jid),
  INDEX idx_groups_owner (connection_id, owner_user_id),
  CONSTRAINT fk_groups_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_groups_owner FOREIGN KEY (owner_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE group_participants (
  connection_id VARCHAR(64) NOT NULL,
  group_jid VARCHAR(128) NOT NULL,
  user_id BINARY(16) NOT NULL,
  participant_jid VARCHAR(128) NULL,
  role VARCHAR(16) NULL,
  is_admin TINYINT(1) NULL,
  is_superadmin TINYINT(1) NULL,
  data_json JSON NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, group_jid, user_id),
  INDEX idx_group_part_user (connection_id, user_id),
  CONSTRAINT fk_group_part_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_group_part_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  chat_jid VARCHAR(128) NOT NULL,
  message_id VARCHAR(128) NOT NULL,
  from_me TINYINT(1) NOT NULL,
  sender_user_id BINARY(16) NULL,
  timestamp BIGINT NULL,
  content_type VARCHAR(64) NULL,
  message_type VARCHAR(64) NULL,
  status VARCHAR(32) NULL,
  is_forwarded TINYINT(1) NULL,
  is_ephemeral TINYINT(1) NULL,
  text_preview VARCHAR(512) NULL,
  data_json JSON NOT NULL,
  deleted_at TIMESTAMP NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_message (connection_id, chat_jid, message_id, from_me),
  INDEX idx_messages_chat_time (connection_id, chat_jid, timestamp),
  INDEX idx_messages_feed (connection_id, chat_jid, id DESC),
  INDEX idx_messages_lookup (connection_id, message_id),
  INDEX idx_messages_sender (connection_id, sender_user_id, timestamp),
  INDEX idx_messages_conn_sender_id (connection_id, sender_user_id, id),
  CONSTRAINT fk_messages_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_messages_sender FOREIGN KEY (sender_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE lid_mappings (
  connection_id VARCHAR(64) NOT NULL,
  pn VARCHAR(64) NOT NULL,
  lid VARCHAR(64) NOT NULL,
  user_id BINARY(16) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, pn),
  UNIQUE KEY uq_lid (connection_id, lid),
  INDEX idx_lid_user (connection_id, user_id),
  CONSTRAINT fk_lid_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_lid_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE message_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  chat_jid VARCHAR(128) NOT NULL,
  message_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  actor_user_id BINARY(16) NULL,
  target_user_id BINARY(16) NULL,
  message_db_id BIGINT NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_events_msg (connection_id, chat_jid, message_id),
  INDEX idx_message_events_actor (connection_id, actor_user_id, created_at),
  CONSTRAINT fk_events_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_aliases (
  connection_id VARCHAR(64) NOT NULL,
  user_id BINARY(16) NOT NULL,
  alias_type ENUM('pushName','notify','username','display_name') NOT NULL,
  alias_value VARCHAR(255) NOT NULL,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, user_id, alias_type, alias_value),
  INDEX idx_alias_user (connection_id, user_id),
  CONSTRAINT fk_user_aliases_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_user_aliases_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE message_media (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  message_db_id BIGINT NOT NULL,
  media_type VARCHAR(32) NOT NULL,
  mime_type VARCHAR(128) NULL,
  file_sha256 VARCHAR(128) NULL,
  file_length BIGINT NULL,
  file_name VARCHAR(255) NULL,
  url TEXT NULL,
  local_path TEXT NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_media_message (connection_id, message_db_id),
  INDEX idx_media_hash (connection_id, file_sha256),
  CONSTRAINT fk_media_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_media_msg FOREIGN KEY (message_db_id) REFERENCES messages(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE message_text_index (
  connection_id VARCHAR(64) NOT NULL,
  message_db_id BIGINT NOT NULL,
  text_content LONGTEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, message_db_id),
  FULLTEXT KEY ft_message_text (text_content),
  CONSTRAINT fk_text_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_text_msg FOREIGN KEY (message_db_id) REFERENCES messages(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE message_users (
  connection_id VARCHAR(64) NOT NULL,
  message_db_id BIGINT NOT NULL,
  user_id BINARY(16) NOT NULL,
  relation_type ENUM('sender','mentioned','participant','quoted') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, message_db_id, user_id, relation_type),
  INDEX idx_message_users_user (connection_id, user_id, created_at),
  CONSTRAINT fk_message_users_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_message_users_msg FOREIGN KEY (message_db_id) REFERENCES messages(id),
  CONSTRAINT fk_message_users_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE chat_users (
  connection_id VARCHAR(64) NOT NULL,
  chat_jid VARCHAR(128) NOT NULL,
  user_id BINARY(16) NOT NULL,
  role VARCHAR(32) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, chat_jid, user_id),
  INDEX idx_chat_users_user (connection_id, user_id, created_at),
  CONSTRAINT fk_chat_users_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_chat_users_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE labels (
  connection_id VARCHAR(64) NOT NULL,
  label_id VARCHAR(64) NOT NULL,
  actor_user_id BINARY(16) NULL,
  name VARCHAR(255) NULL,
  color VARCHAR(16) NULL,
  data_json JSON NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, label_id),
  INDEX idx_labels_actor (connection_id, actor_user_id),
  CONSTRAINT fk_labels_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_labels_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE label_associations (
  connection_id VARCHAR(64) NOT NULL,
  label_id VARCHAR(64) NOT NULL,
  actor_user_id BINARY(16) NULL,
  association_type ENUM('chat','message','contact','group') NOT NULL,
  chat_jid VARCHAR(128) NULL,
  message_db_id BIGINT NULL,
  target_jid VARCHAR(128) NULL,
  data_json JSON NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_label_assoc (connection_id, label_id),
  INDEX idx_label_message (connection_id, message_db_id),
  INDEX idx_label_actor (connection_id, actor_user_id),
  CONSTRAINT fk_label_assoc_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_label_assoc_actor FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT fk_label_assoc_label FOREIGN KEY (connection_id, label_id)
    REFERENCES labels(connection_id, label_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE blocklist (
  connection_id VARCHAR(64) NOT NULL,
  user_id BINARY(16) NULL,
  actor_user_id BINARY(16) NULL,
  jid VARCHAR(128) NOT NULL,
  is_blocked TINYINT(1) NOT NULL,
  reason VARCHAR(255) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, jid),
  INDEX idx_block_user (connection_id, user_id),
  INDEX idx_block_actor (connection_id, actor_user_id),
  CONSTRAINT fk_block_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_block_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_block_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE events_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  actor_user_id BINARY(16) NULL,
  target_user_id BINARY(16) NULL,
  chat_jid VARCHAR(128) NULL,
  group_jid VARCHAR(128) NULL,
  message_db_id BIGINT NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_events_type (connection_id, event_type),
  INDEX idx_events_actor (connection_id, actor_user_id, created_at),
  CONSTRAINT fk_events_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE events_log_archive (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  actor_user_id BINARY(16) NULL,
  target_user_id BINARY(16) NULL,
  chat_jid VARCHAR(128) NULL,
  group_jid VARCHAR(128) NULL,
  message_db_id BIGINT NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_events_archive_type (connection_id, event_type),
  CONSTRAINT fk_events_archive_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE group_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  group_jid VARCHAR(128) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  actor_user_id BINARY(16) NULL,
  target_user_id BINARY(16) NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_group_events (connection_id, group_jid, created_at),
  CONSTRAINT fk_group_events_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE message_failures (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  chat_jid VARCHAR(128) NOT NULL,
  message_id VARCHAR(128) NULL,
  sender_user_id BINARY(16) NULL,
  actor_user_id BINARY(16) NULL,
  failure_reason VARCHAR(255) NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_message_failures (connection_id, chat_jid, created_at),
  CONSTRAINT fk_message_failures_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE bot_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  device_label VARCHAR(255) NULL,
  platform VARCHAR(64) NULL,
  app_version VARCHAR(64) NULL,
  last_login TIMESTAMP NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bot_sessions (connection_id, created_at),
  CONSTRAINT fk_bot_sessions_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE commands_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  actor_user_id BINARY(16) NULL,
  chat_jid VARCHAR(128) NOT NULL,
  command_name VARCHAR(64) NOT NULL,
  args_text TEXT NULL,
  success TINYINT(1) NOT NULL,
  duration_ms INT NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_commands_log (connection_id, command_name, created_at),
  INDEX idx_commands_user (connection_id, actor_user_id, created_at),
  CONSTRAINT fk_commands_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_sticker_templates (
  connection_id VARCHAR(64) NOT NULL,
  user_id BINARY(16) NOT NULL,
  template_text VARCHAR(512) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, user_id),
  INDEX idx_sticker_template_user (connection_id, user_id),
  CONSTRAINT fk_sticker_templates_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_sticker_templates_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_generated_stickers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  user_id BINARY(16) NOT NULL,
  chat_jid VARCHAR(128) NULL,
  pack_name VARCHAR(255) NULL,
  pack_author VARCHAR(255) NULL,
  template_text VARCHAR(512) NULL,
  local_path VARCHAR(1024) NOT NULL,
  file_sha256 VARCHAR(128) NOT NULL,
  mime_type VARCHAR(128) NULL,
  file_length BIGINT NOT NULL,
  data_json JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_generated_stickers_user (connection_id, user_id, created_at),
  INDEX idx_user_generated_stickers_hash (connection_id, file_sha256),
  CONSTRAINT fk_user_generated_stickers_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_user_generated_stickers_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE newsletters (
  connection_id VARCHAR(64) NOT NULL,
  newsletter_id VARCHAR(128) NOT NULL,
  data_json JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, newsletter_id),
  CONSTRAINT fk_newsletters_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE newsletter_participants (
  connection_id VARCHAR(64) NOT NULL,
  newsletter_id VARCHAR(128) NOT NULL,
  user_id BINARY(16) NOT NULL,
  role VARCHAR(32) NULL,
  status VARCHAR(32) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, newsletter_id, user_id),
  INDEX idx_news_part_user (connection_id, user_id),
  CONSTRAINT fk_news_part_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_news_part_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE newsletter_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  newsletter_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  actor_user_id BINARY(16) NULL,
  target_user_id BINARY(16) NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_news_events (connection_id, newsletter_id, event_type),
  CONSTRAINT fk_news_events_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE group_join_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  group_jid VARCHAR(128) NOT NULL,
  user_id BINARY(16) NOT NULL,
  actor_user_id BINARY(16) NULL,
  action VARCHAR(32) NOT NULL,
  method VARCHAR(64) NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_join_req_group (connection_id, group_jid),
  INDEX idx_join_req_actor (connection_id, actor_user_id),
  CONSTRAINT fk_join_req_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_join_req_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_join_req_actor FOREIGN KEY (actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_devices (
  connection_id VARCHAR(64) NOT NULL,
  user_id BINARY(16) NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  data_json JSON NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, user_id, device_id),
  CONSTRAINT fk_user_devices_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_user_devices_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

## Visão geral (como o Zyra usa o banco hoje)

O Zyra separa “estado operacional do WhatsApp” (chats, grupos, mensagens e metadados brutos) da “identidade unificada” (usuários e seus identificadores), além de manter trilhas de auditoria para observabilidade.

Principais blocos:

- **Multi-instância**: `connections` + `connection_id` em todas as entidades (isolamento lógico por instância).
- **Identidade unificada**: `users` + `user_identifiers` + `user_aliases` + `lid_mappings` (mesma pessoa pode ter PN/LID/JID/username).
- **Armazenamento do WhatsApp**: `chats`, `wa_contacts_cache`, `groups`, `group_participants`, `messages`, `message_media`, `message_text_index`.
- **Auditoria/Observabilidade**: `events_log`, `message_events`, `group_events`, `commands_log`, `message_failures`, `bot_sessions`, `blocklist`, `labels` e `label_associations`.
- **Newsletters (canais)**: `newsletters`, `newsletter_participants` e `newsletter_events`.
- **Estado criptográfico**: `auth_creds` e `signal_keys` (quando a estratégia de auth estiver apontada para MySQL).

## Pontos fortes

- **Isolamento por instância**: o `connection_id` aparece sistematicamente em chaves e índices, facilitando multi-instância e filtros por tenant.
- **Identidade resiliente**: `users` (BINARY(16)) desacopla a pessoa dos identificadores voláteis; `user_identifiers` permite re-vincular PN/LID/JID/username sem perder histórico.
- **Observabilidade pronta para produção**: trilhas de evento e falha (`events_log`, `message_events`, `message_failures`, `commands_log`) facilitam auditoria, troubleshooting e métricas.
- **Modelo híbrido “bruto + derivado”**: colunas de leitura rápida (ex: `text_preview`, `timestamp`, `status`) convivem com `data_json` para preservar payloads completos.
- **Busca textual nativa**: `message_text_index` com FULLTEXT permite consultas rápidas sem depender de um serviço externo.

## Pontos de atenção

- **Migrações**: como o `db:init` só cria tabelas ausentes, alterações de colunas/índices exigem um processo de migração (senão pode haver divergência entre ambiente novo e banco antigo).
- **UUID e fragmentação de índice**: hoje o `sql-store` grava UUIDs como BINARY(16) via `UNHEX(REPLACE(uuid,'-',''))`, o que não preserva ordenação temporal. Em grandes volumes, pode gerar fragmentação no InnoDB (mitigação: UUIDs ordenáveis ou chaves surrogate).
- **Crescimento de dados**: `messages`, `events_log`, `message_events` e `newsletter_events` tendem a crescer rápido. Planejar retenção/arquivamento e, se necessário, particionamento e índices adicionais.
- **JSON pesado**: `data_json` facilita compatibilidade e auditoria, mas aumenta custo de armazenamento e pode exigir colunas derivadas/indexadas para consultas frequentes.
- **Chave `connections`**: por haver FKs para `connections(id)`, é importante garantir que o `connection_id` esteja registrado (o bootstrap faz isso via `ensureMysqlConnection`, usando `WA_CONNECTION_ID`).
- **`wa_contacts_cache` é cache**: útil para performance e “estado do WhatsApp”, mas não deve ser tratado como fonte única de verdade de identidade (para isso existem `users`/`user_identifiers`).

## Verificações recomendadas

- `npm run db:init`: cria as tabelas ausentes do MySQL a partir deste arquivo.
- `npm run db:verify`: lista tabelas e contagens (por `WA_CONNECTION_ID` quando a tabela tem `connection_id`).
