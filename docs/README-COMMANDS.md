# 📦 Arquitetura Modular de Comandos - Zyra System

Este documento consolida a visão arquitetural e a implementação atual do sistema modular de comandos do Zyra. A proposta é desacoplar o núcleo de conexão do código de cada comando, permitindo evolução mais segura, manutenção mais simples e uma base preparada para expansão.

---

## 🧠 Visão Geral e Benefícios

Antes, os comandos dependiam diretamente do socket do Baileys (`WASocket`), o que criava acoplamento forte com a biblioteca de conexão e espalhava detalhes de transporte pelo projeto.

Com a arquitetura atual, o comando passa a receber um `CommandContext` (`ctx`) e o Core assume a responsabilidade pelas operações pesadas.

Principais benefícios:

1. **Desacoplamento:** o comando interage com uma interface estável, não com a implementação do socket.
2. **Independência:** cada comando fica isolado em `src/commands/`.
3. **Inversão de Controle:** o Core injeta capacidades e utilidades no contexto.
4. **Escalabilidade:** adicionar novos comandos não exige alterar o fluxo principal.
5. **Resiliência:** falhas podem ser tratadas centralmente no processor.
6. **Evolução futura:** a base já favorece middlewares, plugins e hot-swap.

---

## 🏛️ Anatomia da Arquitetura

### 1. Event Parser
O Core intercepta os eventos recebidos e normaliza a mensagem para consumo interno.

Responsabilidades:

- extrair remetente, chat, texto e metadados relevantes
- reduzir dependência de formatos específicos do Baileys
- produzir uma estrutura estável para o restante do pipeline

### 2. Command Processor
O processor gerencia o ciclo de vida da execução do comando.

Responsabilidades:

- identificar se a mensagem corresponde a um comando
- resolver aliases e argumentos
- criar o `ctx`
- executar o comando de forma isolada
- centralizar tratamento de erro e observabilidade

### 3. Contexto (`ctx`)
O contexto funciona como fachada para o desenvolvedor de comandos.

Em vez de cada comando repetir lógica de quoted, chatId, permissões ou ações administrativas, o Core oferece métodos diretos e previsíveis.

### 4. Helpers e serviços do Core
Operações privilegiadas ou reutilizáveis ficam concentradas no Core, e não espalhadas em cada comando.

Exemplos:

- resposta e reação a mensagens
- verificação de admin
- kick, ban, promote e demote
- futuras integrações com segurança, banco e cache

---

## 🛠️ Implementação Atual no Projeto

Hoje a arquitetura está organizada principalmente em:

- `src/core/command-runtime/context.ts`: expõe o `ctx` normalizado para os comandos
- `src/core/command-runtime/processor.ts`: identifica, cria o contexto e executa os comandos
- `src/core/command-runtime/admin.ts`: centraliza ações administrativas reutilizáveis
- `src/commands/types.ts`: define o contrato de cada comando
- `src/commands/`: reúne os comandos desacoplados do núcleo

Se o Baileys for atualizado ou substituído, a tendência é concentrar os ajustes nessas camadas, mantendo os comandos estáveis.

---

## ⚙️ Configurações Importantes

### Prefixo de comandos

O prefixo padrão de comando é `!`, mas pode ser configurado via variável de ambiente:

- `WA_COMMAND_PREFIX`: define o prefixo de comandos (default `!`)

Isso permite rodar múltiplas instâncias com padrões diferentes sem alterar código.

### Processamento de mensagens (anti-histórico)

Para evitar execução de comandos em carga de histórico, o Core processa comandos apenas quando `messages.upsert.type === "notify"`.

---

## 📜 Contrato dos Comandos

O tipo `Command` espera uma função que recebe o `ctx`.

```typescript
export type Command = {
  name: string
  description: string
  execute: (ctx: CommandContext) => Promise<void>
}
```

Essa assinatura reduz o acoplamento e padroniza o desenvolvimento de novos comandos.

---

## 🔌 Funções Disponíveis no `ctx`

O `CommandContext` (`ctx`) oferece métodos e dados para acelerar o desenvolvimento:

- `ctx.reply(text)`: envia uma resposta marcando a mensagem original
- `ctx.react(emoji)`: reage à mensagem do usuário
- `ctx.isAdmin()`: verifica de forma assíncrona se o usuário é admin do grupo
- `ctx.kick(jid | jids)`: remove participantes do grupo
- `ctx.ban(jid | jids)`: alias semântico para remoção centralizada pelo core
- `ctx.promote(jid | jids)`: promove participantes para admin
- `ctx.demote(jid | jids)`: remove privilégios de admin
- `ctx.admin.*`: acesso direto à camada administrativa centralizada
- `ctx.isGroup`: indica se a mensagem veio de grupo
- `ctx.args`: argumentos passados após o comando
- `ctx.text`: texto completo da mensagem
- `ctx.sender`: JID de quem enviou a mensagem
- `ctx.chatId`: JID do chat

O `ctx` não expõe mais `socket` nem `message` brutos. Isso reduz acoplamento e incentiva o uso dos helpers oficiais do Core.

---

## 🧱 Robustez e Resiliência

### Error Boundaries
Cada comando deve ser executado sob tratamento centralizado de erro no processor.

Objetivos:

- impedir que uma falha em um comando derrube o fluxo geral
- registrar stacktrace e contexto operacional
- decidir centralmente se o usuário deve receber feedback ou se o erro será apenas logado

### Middlewares
A arquitetura favorece camadas intermediárias antes da execução do comando.

Exemplos de uso:

- validação de prefixo e alias
- controle de rate limit
- verificação de permissões
- auto-download de mídia
- regras globais de segurança, como anti-link

### Registry e Hot Reload
O modelo também favorece um registro dinâmico de comandos.

Isso abre espaço para:

- recarregar comandos sem reiniciar toda a aplicação
- plugar módulos externos
- habilitar e desabilitar funcionalidades com mais flexibilidade

---

## 🔄 Comparativo de Evolução

### Modelo antigo
```typescript
async execute({ sock, message, chatId }) {
  const isAdmin = (await sock.groupMetadata(chatId)).participants.find(
    (p) => p.id === sender
  ).admin !== null

  if (!isAdmin) return
  await sock.sendMessage(chatId, { text: 'Ola' }, { quoted: message })
}
```

### Modelo modular
```typescript
async execute(ctx) {
  if (!await ctx.isAdmin()) return
  await ctx.reply('Ola')
}
```

No modelo modular, a complexidade operacional fica no Core e o comando permanece focado na regra de negócio.

---

## 🚀 Como Criar um Novo Comando

### Passo 1: criar o arquivo
Crie um arquivo em `src/commands/meu-comando.ts`:

```typescript
import type { Command } from './types.js'

export const meuComando: Command = {
  name: 'ola',
  description: 'Exemplo de comando modular',
  async execute(ctx) {
    await ctx.react('👋')
    await ctx.reply(`Ola @${ctx.sender.split('@')[0]}, como posso ajudar?`)
  },
}
```

### Passo 2: registrar o comando
Adicione o comando em `src/commands/index.ts`:

```typescript
import { meuComando } from './meu-comando.js'

export const commands: Record<string, Command> = {
  [meuComando.name]: meuComando,
}
```

### Passo 3: usar normalmente
Depois de registrado, o comando passa a responder com o prefixo configurado.

---

## 🧩 Evolução Futura

Esta base permite adicionar com mais segurança:

- **middlewares** para validação e políticas globais
- **plugins** com carregamento dinâmico
- **rate limit** por comando ou usuário
- **dashboard web** para gerenciar comandos em tempo real
- **multi-plataforma** com contextos equivalentes para outros canais
- **agentes de IA** integrados ao processor quando nenhum comando for detectado

---

## 🗺️ Roadmap

### Fase 1: Fundação

- consolidar e expandir `context.ts`
- fortalecer o `processor.ts` como ponto central de execução
- manter ações administrativas encapsuladas no Core

### Fase 2: Inteligência

- ampliar helpers reutilizáveis
- adicionar middlewares de segurança e permissão
- preparar integrações com cache, banco e observabilidade

### Fase 3: Expansão

- evoluir o carregamento de comandos
- facilitar plugins e extensões externas
- suportar recarga dinâmica e novas superfícies de automação
