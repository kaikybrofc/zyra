# Comandos

Esta página resume como o runtime de comandos do Zyra funciona em produção e como os comandos se comportam do ponto de vista operacional. Para a referência completa dos comandos registrados atualmente, veja [Comandos - Referência](Comandos-Referencia). Para detalhes profundos da arquitetura interna, veja [`docs/README-COMMANDS.md`](../README-COMMANDS.md).

## Visão geral

O Zyra usa um runtime modular de comandos baseado em:

- `src/commands/*.ts` para implementação dos comandos
- `src/commands/index.ts` para registro central
- `src/core/command-runtime/context.ts` para o `CommandContext`
- `src/core/command-runtime/processor.ts` para parsing, regras transversais e execução
- `src/router/index.ts` para enfileiramento por chat

## Fluxo de processamento

1. Um evento `messages.upsert` chega ao sistema.
2. O handler central encaminha mensagens `notify` para o router.
3. O router enfileira o processamento por `connectionId:chatId`.
4. O processor normaliza a mensagem, detecta prefixo e identifica o comando.
5. Antes da execução, regras automáticas de runtime podem ser aplicadas.
6. O comando recebe um `CommandContext` estável e desacoplado do socket bruto.
7. O resultado é registrado nos logs e, quando aplicável, também na persistência SQL.

## Fila, backpressure e timeout

O runtime protege o processo com duas regras importantes:

- **fila por chat/conexão**: mantém a ordem por conversa sem travar toda a instância
- **limite de pendências por fila**: protege memória quando há saturação
- **timeout de comando**: impede que handlers travados bloqueiem o chat indefinidamente

Variáveis relacionadas:

- `WA_ROUTER_MAX_PENDING_PER_QUEUE`
- `WA_COMMAND_TIMEOUT_MS`

## O que o `CommandContext` expõe

Os comandos recebem um contexto com dados e helpers estáveis, incluindo:

- dados de mensagem e chat: `chatId`, `sender`, `isGroup`, `text`, `args`
- resposta e envio: `reply`, `send`, `react`, helpers de mídia
- ações administrativas de grupo
- utilidades para stickers, quoted message e persistência associada

Isso reduz acoplamento com o socket bruto e centraliza comportamento transversal no runtime.

## Antilink: comando e regra automática

O antilink merece destaque porque ele existe em dois níveis.

### Como comando

O comando `!antilink` permite:

- ativar ou desativar o recurso no grupo
- gerenciar whitelist de domínios
- controlar a exceção para o link do próprio grupo

### Como comportamento automático

Quando ativo para um grupo, o runtime pode:

- detectar links em mensagens
- ignorar domínios permitidos
- permitir o link do próprio grupo quando configurado
- tratar admins de forma diferente de membros comuns
- remover participantes infratores
- apagar mensagens recentes do remetente
- tentar cascata de remoção em grupos vinculados à mesma comunidade

Ou seja: `antilink` não é apenas um comando de configuração; ele é uma regra operacional aplicada pelo processor em mensagens de grupo.

## Registry atual

A fonte de verdade dos comandos ativos é `src/commands/index.ts`.

Isso significa que:

- a lista exibida por `!menu` é dinâmica
- aliases como `!s` e `!st` dependem do registry atual
- a documentação de referência deve ser mantida alinhada ao índice central

## Boas práticas ao evoluir comandos

- validar contexto cedo (`isGroup`, permissões, mídia disponível)
- manter feedback curto e claro para o usuário
- delegar regras transversais ao runtime e ao store
- não depender de efeitos colaterais fora do contrato do comando
- validar o comportamento com testes próximos ao subsistema afetado

## Leituras relacionadas

- [Comandos - Referência](Comandos-Referencia)
- [Eventos](Eventos)
- [Persistência](Persistência)
- [Guia técnico de comandos](../README-COMMANDS.md)

---

**Zyra Wiki** • Última atualização: 17/05/2026