# Comandos - Referência

Esta página lista os comandos atualmente registrados em `src/commands/index.ts`. O prefixo padrão é `!`, mas pode ser alterado via `WA_COMMAND_PREFIX`.

Para entender o comportamento do runtime, fila, timeout e regras automáticas como antilink, veja [Comandos](Comandos).

## Convenções gerais

### Requisitos comuns para comandos administrativos

Em grupos, comandos de administração normalmente exigem:

- executor com permissão adequada
- bot com privilégios compatíveis no grupo

### Identificadores aceitos em comandos administrativos

Dependendo do comando, os alvos podem ser informados como:

- número (`5511999999999`)
- menção (`@usuario`)
- resposta a uma mensagem

## Utilidade

### `!ping`

Verifica disponibilidade básica do bot.

Exemplo:

```text
!ping
```

### `!menu`

Lista os comandos disponíveis a partir do registry atual.

Exemplo:

```text
!menu
```

## Sticker e mídia

### `!sticker`, `!s`, `!st`

Converte mídia em figurinha.

Fonte de mídia suportada:

- legenda da própria mídia
- resposta a mídia
- fallback recente do chat quando aplicável

Ajuda embutida:

```text
!s -h
!s --help
```

Exemplos:

```text
!s
!s Zyra
!s Pack do #grupo/#nome
```

Observações:

- o runtime suporta placeholders no template
- o template do usuário pode ser persistido e reutilizado
- há limite operacional para o sticker gerado

### `!toimg`

Converte uma figurinha WebP para imagem.

Uso esperado:

```text
!toimg
```

Geralmente exige responder uma figurinha.

### `!togif`

Converte uma figurinha WebP para GIF.

Uso esperado:

```text
!togif
```

Geralmente exige responder uma figurinha.

## Moderação e administração de grupo

### `!antilink`

Configura o antilink por grupo.

Exemplos:

```text
!antilink
!antilink on
!antilink off
!antilink invite on
!antilink invite off
!antilink allow list
!antilink allow add exemplo.com
!antilink allow remove exemplo.com
```

Observações:

- sem argumentos, retorna status e instruções
- `invite on/off` controla exceção para o link do próprio grupo
- `allow` gerencia whitelist de domínios permitidos
- o enforcement automático do antilink é descrito em [Comandos](Comandos)

### `!add`

Adiciona participante(s) ao grupo.

Exemplos:

```text
!add 5511999999999
!add @usuario
```

### `!kick`

Remove participante(s) do grupo.

Exemplos:

```text
!kick 5511999999999
!kick @usuario
```

### `!ban`

Executa remoção/banimento semântico do participante.

Exemplo:

```text
!ban @usuario
```

### `!promote`

Promove participante(s) a admin.

Exemplo:

```text
!promote @usuario
```

### `!demote`

Remove privilégios administrativos.

Exemplo:

```text
!demote @usuario
```

### `!grupo on|off`

Abre ou fecha o envio de mensagens no grupo.

Exemplos:

```text
!grupo on
!grupo off
```

### `!lock on|off`

Controla edição de informações do grupo.

Exemplos:

```text
!lock on
!lock off
```

### `!assunto <texto>`

Atualiza o assunto do grupo.

Exemplo:

```text
!assunto Equipe Projeto X
```

### `!descricao <texto|limpar>`

Atualiza ou limpa a descrição do grupo.

Exemplos:

```text
!descricao Regras do grupo...
!descricao limpar
```

### `!linkgrupo`

Exibe o link atual de convite do grupo.

Exemplo:

```text
!linkgrupo
```

### `!revogarlink`

Revoga o link atual e gera um novo.

Exemplo:

```text
!revogarlink
```

### `!ephemeral off|24h|7d|90d|<segundos>`

Controla mensagens temporárias do grupo.

Exemplos:

```text
!ephemeral off
!ephemeral 24h
!ephemeral 604800
```

## Erros comuns

Exemplos de respostas esperadas em cenários inválidos:

- comando administrativo fora de grupo
- executor sem permissão suficiente
- mídia ausente para conversão
- alvo inválido ou não resolvido

## Observação de manutenção

Sempre que `src/commands/index.ts` mudar, esta página deve ser revisada.

---

**Zyra Wiki** • Última atualização: 17/05/2026
