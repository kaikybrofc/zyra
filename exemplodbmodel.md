# Modelo completo do banco (MySQL 8)

Este arquivo contem o modelo completo proposto para persistencia do bot, com:
- conexoes
- usuarios internos (id unico)
- identificadores (pn, lid, jid, username)
- dados do Baileys (auth/keys)
- store (chats, contatos, grupos, mensagens)
- tabelas auxiliares (labels, blocklist, eventos, midia, etc.)

## Diagrama (ASCII)

```
connections
  |
  +-- auth_creds
  +-- signal_keys
  +-- chats -----------+
  +-- contacts         |
  +-- groups -----+    |
  +-- messages ---+----+------ message_events
  +-- lid_mappings
  +-- labels ---------- label_associations
  +-- blocklist
  +-- events_log
  +-- newsletters ----- newsletter_events
  +-- group_events
  +-- group_join_requests
  +-- user_devices
  +-- message_failures
  +-- bot_sessions
  +-- commands_log
  +-- message_users
  |
  +-- users
       |
       +-- user_identifiers
       +-- user_aliases
       +-- contacts (user_id)
       +-- group_participants
       +-- messages (sender_user_id)
       +-- lid_mappings (user_id)
       +-- blocklist (user_id)
       +-- newsletter_participants

groups
  |
  +-- group_participants

messages
  |
  +-- message_media
  +-- message_text_index
  +-- message_users
```

```sql
CREATE TABLE connections (
  id VARCHAR(64) PRIMARY KEY,
  label VARCHAR(100) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE users (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  display_name VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_conn (connection_id),
  CONSTRAINT fk_users_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_identifiers (
  connection_id VARCHAR(64) NOT NULL,
  user_id BIGINT NOT NULL,
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
  data_json JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, jid),
  CONSTRAINT fk_chats_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE contacts (
  connection_id VARCHAR(64) NOT NULL,
  jid VARCHAR(128) NOT NULL,
  user_id BIGINT NULL,
  data_json JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, jid),
  INDEX idx_contacts_user (connection_id, user_id),
  CONSTRAINT fk_contacts_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_contacts_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE groups (
  connection_id VARCHAR(64) NOT NULL,
  jid VARCHAR(128) NOT NULL,
  subject VARCHAR(255) NULL,
  owner_user_id BIGINT NULL,
  announce TINYINT(1) NULL,
  restrict TINYINT(1) NULL,
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
  user_id BIGINT NOT NULL,
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
  sender_user_id BIGINT NULL,
  participant_jid VARCHAR(128) NULL,
  timestamp BIGINT NULL,
  content_type VARCHAR(64) NULL,
  text_preview VARCHAR(512) NULL,
  data_json JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_message (connection_id, chat_jid, message_id, participant_jid, from_me),
  INDEX idx_messages_chat_time (connection_id, chat_jid, timestamp),
  INDEX idx_messages_sender (connection_id, sender_user_id, timestamp),
  CONSTRAINT fk_messages_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_messages_sender FOREIGN KEY (sender_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE lid_mappings (
  connection_id VARCHAR(64) NOT NULL,
  pn VARCHAR(64) NOT NULL,
  lid VARCHAR(64) NOT NULL,
  user_id BIGINT NULL,
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
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_events_msg (connection_id, chat_jid, message_id),
  CONSTRAINT fk_events_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_aliases (
  connection_id VARCHAR(64) NOT NULL,
  user_id BIGINT NOT NULL,
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
  user_id BIGINT NOT NULL,
  relation_type ENUM('sender','mentioned','participant','quoted') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, message_db_id, user_id, relation_type),
  INDEX idx_message_users_user (connection_id, user_id, created_at),
  CONSTRAINT fk_message_users_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_message_users_msg FOREIGN KEY (message_db_id) REFERENCES messages(id),
  CONSTRAINT fk_message_users_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE labels (
  connection_id VARCHAR(64) NOT NULL,
  label_id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NULL,
  color VARCHAR(16) NULL,
  data_json JSON NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, label_id),
  CONSTRAINT fk_labels_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE label_associations (
  connection_id VARCHAR(64) NOT NULL,
  label_id VARCHAR(64) NOT NULL,
  association_type ENUM('chat','message','contact','group') NOT NULL,
  chat_jid VARCHAR(128) NULL,
  message_db_id BIGINT NULL,
  target_jid VARCHAR(128) NULL,
  data_json JSON NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_label_assoc (connection_id, label_id),
  INDEX idx_label_message (connection_id, message_db_id),
  CONSTRAINT fk_label_assoc_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_label_assoc_label FOREIGN KEY (connection_id, label_id)
    REFERENCES labels(connection_id, label_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE blocklist (
  connection_id VARCHAR(64) NOT NULL,
  user_id BIGINT NULL,
  jid VARCHAR(128) NOT NULL,
  is_blocked TINYINT(1) NOT NULL,
  reason VARCHAR(255) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, jid),
  INDEX idx_block_user (connection_id, user_id),
  CONSTRAINT fk_block_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_block_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE events_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_events_type (connection_id, event_type),
  CONSTRAINT fk_events_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE group_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  group_jid VARCHAR(128) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  actor_user_id BIGINT NULL,
  target_user_id BIGINT NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_group_events (connection_id, group_jid, created_at),
  CONSTRAINT fk_group_events_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_group_events_actor FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT fk_group_events_target FOREIGN KEY (target_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE message_failures (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  chat_jid VARCHAR(128) NOT NULL,
  message_id VARCHAR(128) NULL,
  sender_user_id BIGINT NULL,
  failure_reason VARCHAR(255) NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_message_failures (connection_id, chat_jid, created_at),
  CONSTRAINT fk_message_failures_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_message_failures_sender FOREIGN KEY (sender_user_id) REFERENCES users(id)
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
  user_id BIGINT NULL,
  chat_jid VARCHAR(128) NOT NULL,
  command_name VARCHAR(64) NOT NULL,
  args_text TEXT NULL,
  success TINYINT(1) NOT NULL,
  duration_ms INT NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_commands_log (connection_id, command_name, created_at),
  INDEX idx_commands_user (connection_id, user_id, created_at),
  CONSTRAINT fk_commands_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_commands_user FOREIGN KEY (user_id) REFERENCES users(id)
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
  user_id BIGINT NOT NULL,
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
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_news_events (connection_id, newsletter_id, event_type),
  CONSTRAINT fk_news_events_conn FOREIGN KEY (connection_id) REFERENCES connections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE group_join_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  group_jid VARCHAR(128) NOT NULL,
  user_id BIGINT NOT NULL,
  action VARCHAR(32) NOT NULL,
  method VARCHAR(64) NULL,
  data_json JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_join_req_group (connection_id, group_jid),
  CONSTRAINT fk_join_req_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_join_req_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_devices (
  connection_id VARCHAR(64) NOT NULL,
  user_id BIGINT NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  data_json JSON NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, user_id, device_id),
  CONSTRAINT fk_user_devices_conn FOREIGN KEY (connection_id) REFERENCES connections(id),
  CONSTRAINT fk_user_devices_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```
