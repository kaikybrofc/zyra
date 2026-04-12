# 📦 Arquitetura Modular de Comandos - Zyra System

Esta documentação descreve a nova arquitetura modular de comandos implementada para garantir escalabilidade, facilidade de manutenção e desacoplamento do núcleo (core) do sistema.

---

## 🧠 Conceito e Benefícios

Anteriormente, os comandos recebiam diretamente o socket do Baileys (`WASocket`), o que criava um acoplamento forte com a biblioteca de conexão. Na nova arquitetura:

1.  **Desacoplamento:** Comandos agora recebem um `CommandContext` (`ctx`), que abstrai a comunicação.
2.  **Independência:** Cada comando é uma peça isolada na pasta `src/commands/`.
3.  **Core Helpers:** O sistema fornece funções prontas (como `reply`, `react`, `isAdmin`) diretamente no contexto.
4.  **Escalabilidade:** Adicionar um novo comando não exige mexer no fluxo principal de mensagens.

---

## 🛠️ O que mudou no código?

### 1. Novo Runtime de Comandos (`src/core/command-runtime/`)
Agora o core foi dividido em camadas:

- `context.ts`: expõe um `ctx` normalizado para os comandos.
- `processor.ts`: identifica, cria o contexto e executa os comandos.
- `admin.ts`: centraliza ações administrativas reutilizáveis.

Se o Baileys for atualizado ou trocado, o ajuste tende a ficar concentrado nessa pasta, mantendo os comandos intactos.

### 2. Contrato Simplificado (`src/commands/types.ts`)
O tipo `Command` agora espera uma função que recebe o `ctx`.

```typescript
export type Command = {
  name: string
  description: string
  execute: (ctx: CommandContext) => Promise<void>
}
```

### 3. Processador Central (`src/core/command-runtime/processor.ts`)
O processador central agora identifica o comando, cria o contexto e gerencia a execução de forma isolada. O roteador apenas encaminha as mensagens recebidas para o processor do core.

---

## 🚀 Como criar um novo comando?

Basta seguir estes 3 passos simples:

### Passo 1: Criar o arquivo do comando
Crie um novo arquivo em `src/commands/meu-comando.ts`:

```typescript
import type { Command } from './types.js'

export const meuComando: Command = {
  name: 'ola',
  description: 'Exemplo de comando modular',
  async execute(ctx) {
    // Usando funcoes do core prontas:
    await ctx.react('👋')
    await ctx.reply(`Ola @${ctx.sender.split('@')[0]}, como posso ajudar?`)
  },
}
```

### Passo 2: Registrar o comando
Adicione o seu novo comando no arquivo `src/commands/index.ts`:

```typescript
import { meuComando } from './meu-comando.js'

export const commands: Record<string, Command> = {
  // ... outros comandos
  [meuComando.name]: meuComando,
}
```

### Passo 3: Pronto!
Depois de registrar no índice, o comando estará disponível com o prefixo configurado (ex: `!ola`).

---

## 🔌 Funções Disponíveis no `ctx` (Core Helpers)

O `CommandContext` (`ctx`) oferece diversos métodos para agilizar o desenvolvimento:

-   `ctx.reply(text)`: Envia uma resposta marcando a mensagem original.
-   `ctx.react(emoji)`: Reage à mensagem do usuário.
-   `ctx.isAdmin()`: Verifica de forma assíncrona se o usuário é admin do grupo.
-   `ctx.kick(jid | jids)`: Remove participantes do grupo.
-   `ctx.ban(jid | jids)`: Alias semântico para remoção centralizada pelo core.
-   `ctx.promote(jid | jids)`: Promove participantes para admin.
-   `ctx.demote(jid | jids)`: Remove privilégios de admin.
-   `ctx.admin.*`: Acesso direto à camada administrativa centralizada.
-   `ctx.isGroup`: Booleano que indica se a mensagem veio de um grupo.
-   `ctx.args`: Array com os argumentos passados após o comando.
-   `ctx.text`: O texto completo da mensagem.
-   `ctx.sender`: O JID de quem enviou a mensagem.
-   `ctx.chatId`: O JID do chat (grupo ou PV).

O `ctx` não expõe mais `socket` nem `message` brutos. Isso reduz acoplamento com o Baileys e força a reutilização dos helpers do core.

---

## 🧩 Evolução Futura
Esta base permite adicionar facilmente:
-   **Middlewares**: Validar permissões antes de cada comando.
-   **Plugins**: Carregamento dinâmico de comandos de pastas externas.
-   **Rate Limit**: Proteção contra spam por comando.
