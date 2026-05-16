# Zyra Platform Guide

Guia técnico unificado da plataforma Zyra, consolidando:
- arquitetura modular de comandos
- modelo de dados MySQL
- práticas de operação e evolução

Este documento é a visão de alto nível para desenvolvimento e manutenção.

## Escopo

O Zyra foi projetado para:
- processar eventos WhatsApp em tempo real com Baileys
- executar comandos desacoplados do transporte
- manter persistência híbrida e auditável
- operar em múltiplas instâncias com isolamento por `connection_id`

## Arquitetura de Comandos

### Objetivo

A camada de comandos remove o acoplamento direto com `WASocket`.
Cada comando recebe um `CommandContext` (`ctx`) com APIs estáveis.

Benefícios:
1. desacoplamento da lib de transporte
2. manutenção centralizada de regras comuns
3. evolução segura para middlewares, plugins e hot-reload
4. redução de código repetido nos comandos

### Fluxo de Execução

1. Event Parser normaliza eventos recebidos.
2. Command Processor detecta comando, resolve alias e argumentos.
3. Core cria `ctx` e executa o comando de forma isolada.
4. Tratamento de erro e observabilidade ficam centralizados.

Componentes principais:
- `src/core/command-runtime/context.ts`
- `src/core/command-runtime/processor.ts`
- `src/core/command-runtime/admin.ts`
- `src/commands/types.ts`
- `src/commands/`

### Contrato de Comando

```ts
export type Command = {
  name: string
  description: string
  execute: (ctx: CommandContext) => Promise<void>
}
```

### Capacidades do `ctx`

- `ctx.reply(text)`
- `ctx.react(emoji)`
- `ctx.isAdmin()`
- `ctx.kick(jid | jids)`
- `ctx.ban(jid | jids)`
- `ctx.promote(jid | jids)`
- `ctx.demote(jid | jids)`
- `ctx.admin.*`
- `ctx.isGroup`
- `ctx.args`
- `ctx.text`
- `ctx.sender`
- `ctx.chatId`

Observação: o comando não precisa acessar socket bruto para operações comuns.

### Exemplo de Comando

```ts
import type { Command } from './types.js'

export const ola: Command = {
  name: 'ola',
  description: 'Exemplo de comando modular',
  async execute(ctx) {
    await ctx.react('👋')
    await ctx.reply(`Ola @${ctx.sender.split('@')[0]}`)
  },
}
```

## Modelo de Dados (MySQL)

### Princípios

- **Multi-instância**: todas as entidades relevantes carregam `connection_id`.
- **Identidade unificada**: usuário lógico desacoplado de PN/LID/JID/username.
- **Payload bruto + colunas derivadas**: flexibilidade de evolução com leitura eficiente.
- **Observabilidade nativa**: auditoria e rastreabilidade desde o banco.

### Blocos de Domínio

- **Conexão e autenticação**: `connections`, `auth_creds`, `signal_keys`
- **Identidade**: `users`, `user_identifiers`, `user_aliases`, `lid_mappings`, `user_devices`
- **WhatsApp state**: `chats`, `wa_contacts_cache`, `groups`, `group_participants`
- **Mensageria**: `messages`, `message_media`, `message_text_index`, `message_users`, `chat_users`
- **Eventos e auditoria**: `events_log`, `events_log_archive`, `message_events`, `group_events`, `commands_log`, `message_failures`, `bot_sessions`
- **Recursos auxiliares**: `labels`, `label_associations`, `blocklist`
- **Newsletters**: `newsletters`, `newsletter_participants`, `newsletter_events`
- **Recursos de sticker**: `user_sticker_templates`, `user_generated_stickers`
- **Ingressos de grupo**: `group_join_requests`

### Pontos Fortes

- isolamento por tenant com índices por `connection_id`
- identidade resiliente a mudanças de identificadores
- trilha de auditoria pronta para suporte e diagnóstico
- busca textual nativa via FULLTEXT em `message_text_index`

### Pontos de Atenção

- `db:init` cria tabelas ausentes, mas não faz migração destrutiva
- tabelas de eventos e mensagens crescem rápido e exigem política de retenção
- campos `data_json` preservam payload completo, porém podem demandar índices derivados

## Operação e Manutenção

Comandos úteis:
- `npm run db:init`: cria tabelas ausentes a partir do schema documentado
- `npm run db:verify`: valida tabelas e contagens
- `npm run pm2:start`: sobe runtime de produção

Configurações relevantes:
- `WA_COMMAND_PREFIX`
- `WA_CONNECTION_ID`
- `MYSQL_URL`
- `WA_REDIS_URL`

## Evolução Recomendada

1. adicionar middlewares transversais (rate-limit, permissões, segurança)
2. ampliar registry dinâmico de comandos
3. criar pipeline formal de migrações de schema
4. estabelecer retenção e arquivamento para tabelas de alto volume

## Referências

- Schema completo e fonte da verdade do MySQL:
  - `docs/exemplodbmodel.md`
- Wiki do projeto:
  - `docs/wiki/Home.md`
