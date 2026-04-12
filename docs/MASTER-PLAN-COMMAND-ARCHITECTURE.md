# 🏛️ Master Plan: Arquitetura Modular e Processamento de Comandos (Zyra)

Este documento estabelece a visão técnica definitiva para a reestruturação do projeto Zyra, migrando de um sistema de rotas acoplado para uma arquitetura de **Micro-Kernel** onde o Core é o orquestrador e os Comandos são plugins independentes.

---

## 1. Visão Geral e Objetivos Estratégicos

O objetivo é alcançar o **Desacoplamento Total (Decoupling)**. O código de um comando (ex: `ban`, `play`, `sticker`) não deve sofrer alterações se trocarmos a biblioteca de conexão (Baileys) ou se a estrutura da API do WhatsApp mudar.

### Pilares Técnicos:
- **Abstração de Protocolo**: O comando interage com uma interface, não com uma implementação.
- **Inversão de Controle (IoC)**: O Core injeta as capacidades necessárias no comando via Contexto.
- **Resiliência Distribuída**: Falhas em comandos específicos são isoladas por Error Boundaries.
- **Extensibilidade "Hot-Swap"**: Adição de funcionalidades em runtime sem downtime.

---

## 2. A Anatomia da Nova Arquitetura

### 2.1. Camada 1: O Event Parser (Core)
Responsável por interceptar o `messages.upsert` do Baileys e normalizar os dados.
- **Função**: Extrair JID, pushName, texto puro (de botões, legendas, menções) e mídias.
- **Saída**: Um objeto `NormalMessage` padronizado internamente.

### 2.2. Camada 2: O Command Processor (Orquestrador)
O cérebro que gerencia o ciclo de vida da execução. Ele utiliza o padrão **Chain of Responsibility** para processar a mensagem através de middlewares antes de executar o comando.

#### Pipeline de Execução:
1.  **Validator**: Verifica se a mensagem é um comando (prefixo/aliases).
2.  **Rate Limiter**: Consulta o Redis para evitar spam por usuário.
3.  **Auth Guard**: Verifica níveis de permissão (User, Admin, Owner).
4.  **Injector**: Instancia o `Context` e injeta os **Core Helpers**.

### 2.3. Camada 3: O Contexto (The Facade Pattern)
O `ctx` é o objeto mais importante para o desenvolvedor de comandos. Ele encapsula métodos complexos em chamadas simples.

```typescript
// Exemplo da interface do Contexto
interface ZyraContext {
  // Dados normalizados
  args: string[];
  sender: { jid: string; name: string; isAdmin: boolean };
  chat: { jid: string; isGroup: boolean; botIsAdmin: boolean };
  quoted?: QuotedMessage;

  // Ações Abstraídas (Core executa a lógica pesada)
  reply(text: string, options?: ReplyOptions): Promise<void>;
  react(emoji: string): Promise<void>;
  download(): Promise<Buffer>;
  
  // Helpers do Core (Privileged Operations)
  core: {
    group: GroupManager;     // ban, kick, invite, promote
    security: SecurityTools; // checkLink, scanMedia
    db: DatabaseInterface;  // getUser, updateLevel
  };
}
```

---

## 3. Robustez e Resiliência: Detalhes Técnicos

### 3.1. Error Boundaries & Sandbox
Cada comando será executado dentro de um bloco `try/catch` centralizado no Processor.
- **Captura de Erros**: Se o comando `!stats` tentar ler uma propriedade de `undefined`, o Processor captura o `TypeError`, loga o stacktrace via `AppLogger` com contexto (chatId, userId) e limpa a memória.
- **Feedback ao Usuário**: O sistema decide, baseado no erro, se envia uma mensagem de "Erro Interno" ou se ignora silenciosamente (para erros comuns de rede).

### 3.2. Middlewares Avançados
Os middlewares permitem injetar lógica global sem tocar nos comandos.
- **Auto-Download**: Um middleware pode detectar que o comando `!sticker` precisa da imagem, baixar a mídia automaticamente e já entregar o `Buffer` pronto no `ctx.media`.
- **Anti-Link**: Em grupos, um middleware de segurança pode rodar antes de qualquer comando para deletar links proibidos.

### 3.3. Hot Reload & Dynamic Registry
O `CommandRegistry` monitora o sistema de arquivos usando `chokidar` ou `fs.watch`.
- Quando `src/commands/ping.ts` é salvo, o Node.js limpa o `require.cache` (ou usa um timestamp no `import()`) e recarrega apenas aquele módulo.
- **Resultado**: Iteração de desenvolvimento instantânea.

---

## 4. Exemplo Comparativo: O "Salto de Qualidade"

### Como é hoje (Acoplado):
```typescript
async execute({ sock, message, chatId }) {
   const isAdmin = (await sock.groupMetadata(chatId)).participants.find(p => p.id === sender).admin !== null;
   if(!isAdmin) return;
   await sock.sendMessage(chatId, { text: 'Olá' }, { quoted: message });
}
```

### Como será (Modular):
```typescript
async execute(ctx) {
   // A lógica de metadata e cache está escondida no Core Helper
   if (!await ctx.core.group.senderIsAdmin()) return; 
   
   await ctx.reply('Olá'); // O Core cuida do quoted e do chatId
}
```

---

## 5. Futuro e Possibilidades (The Vision)

Com esta base, o Zyra pode evoluir para:
1.  **Dashboard Web**: Um painel para ligar/desligar comandos em tempo real, já que os comandos são módulos independentes no Registry.
2.  **Sistema de Plugins**: Terceiros podem criar uma pasta de comandos e simplesmente "dropar" no projeto.
3.  **Multi-Platform**: O mesmo comando de `!ban` poderia funcionar no Telegram, bastando criar um `TelegramContext` que implemente a mesma interface.
4.  **Agentes de IA**: O Processor pode encaminhar mensagens para um LLM (como o Gemini) quando nenhum comando for detectado, criando um bot conversacional inteligente.

---

## 6. Plano de Implementação (Roadmap)

### Fase 1: Fundação (Core)
- Implementar `src/core/command-runtime/context.ts` (A interface).
- Implementar `src/core/command-runtime/processor.ts` (O motor).

### Fase 2: Inteligência (Helpers)
- Criar `src/core/command-runtime/helpers/group.ts` (Lógica de admins/membros).
- Criar `src/core/command-runtime/helpers/message.ts` (Parser de texto e mídias).

### Fase 3: Migração
- Converter comandos básicos (`ping`) para o novo formato.
- Ativar o loader dinâmico de arquivos.

---
*Este Master Plan redefine o Zyra não como um bot, mas como uma engine de automação robusta e profissional.*
