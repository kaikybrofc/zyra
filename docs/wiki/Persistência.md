# Persistência

Esta página explica como o Zyra distribui estado entre memória, Redis, MySQL e disco local, e qual o papel de cada camada no runtime.

## Objetivo

A estratégia de persistência do Zyra busca equilibrar:

- baixa latência no fluxo online
- durabilidade de histórico e auditoria
- resiliência diante de falhas parciais
- recuperação de consistência ao longo do tempo

## Quatro camadas principais

1. **Memória**
2. **Redis** (opcional)
3. **MySQL**
4. **Disco local**

Cada camada resolve um problema diferente.

## 1. Persistência de auth e sessão

Auth não é a mesma coisa que store operacional.

A sessão do WhatsApp usa uma estratégia com prioridade:

1. **MySQL**
2. **Redis**
3. **Disco local**

Se a estratégia centralizada falhar durante o bootstrap, o runtime pode cair para o fallback local em disco para manter disponibilidade.

Artefatos envolvidos:

- `auth_creds`
- `signal_keys`
- `WA_AUTH_DIR`
- persistência de credenciais e debounce de `creds.update`

Além de armazenar credenciais, `auth_creds` também participa da descoberta de startup: sem `WA_CONNECTION_IDS`, o bootstrap pode consultar o MySQL para decidir quais `connection_id` devem subir.

## 2. Store runtime em memória

A memória é o primeiro hot path do sistema.

Ela mantém estruturas recentes para:

- chats
- contatos
- grupos
- mensagens
- mapeamentos LID/PN
- caches auxiliares do Baileys

Vantagens:

- latência mínima
- suporte ao fluxo online
- menos round-trips ao backend de persistência

Limite importante:

- `WA_MAX_CACHED_MESSAGES` controla o volume do cache de mensagens em memória

## 3. Redis opcional

Redis atua como cache distribuído e camada de aceleração, não como substituto do histórico durável.

Usos típicos:

- hot cache para store
- aceleração de leituras recentes
- apoio à estratégia de auth quando configurado
- persistência compartilhada mais rápida que disco local

Pontos importantes:

- falhas de Redis não devem impedir completamente a operação SQL
- o namespace é segregado por conexão
- Redis melhora performance, mas não substitui auditoria durável

## 4. MySQL como camada durável

MySQL é a fonte de verdade operacional do Zyra.

Ele armazena:

- mensagens e mídia
- eventos e falhas
- comandos executados
- grupos, participantes e chats
- identidade unificada de usuários
- labels, blocklist e newsletters
- checkpoints do backfill

O SQL store usa um padrão importante:

- persiste o payload bruto
- grava colunas derivadas e relacionais para consulta eficiente

Isso torna o sistema simultaneamente auditável e utilizável para suporte, analytics e reconciliação.

## 5. Disco local como fallback

O disco local é usado principalmente para:

- fallback de credenciais quando necessário
- persistência local de mídia baixada
- dados auxiliares de estado em alguns cenários

Exemplos:

- `WA_AUTH_DIR`
- `WA_MEDIA_DOWNLOAD_DIR`
- mídia com `WA_MEDIA_AUTO_DOWNLOAD=true`

## Persistência de mensagens

O runtime grava mensagens de forma incremental, com suporte a:

- payload serializado
- preview textual
- indexação em `message_text_index`
- relacionamento entre sender, quoted, mentioned e participant
- eventos associados à mensagem

## Persistência de mídia

Quando habilitada:

- metadados de mídia são gravados em `message_media`
- a mídia pode ser baixada para disco local
- o backfill pode completar `file_length` e `file_name` depois

## Persistência de identidade

O Zyra trata identidade como problema central.

A camada SQL/Store reconcilia:

- JID
- PN
- LID
- aliases visíveis
- devices

Essa reconciliação é crítica para:

- auditoria confiável
- relatórios
- rastreio de ações administrativas
- consistência de mensagens e participantes

## Configuração por grupo

A configuração operacional de grupo, como antilink, é tratada como estado persistente próprio.

Ela pode passar por:

- cache local
- Redis
- MySQL (`group_config`)

Isso permite evolução de flags sem churn excessivo de schema.

## Consistência eventual e papel do backfill

Nem toda relação derivada precisa estar perfeita no mesmo instante da escrita online.

O desenho aceita consistência eventual em alguns pontos e usa o worker de backfill para:

- preencher campos derivados faltantes
- reconciliar vínculos de identidade
- corrigir lacunas históricas
- completar metadados locais de mídia

## Garantias práticas

- isolamento por `connection_id`
- durabilidade de histórico e auditoria no MySQL
- tolerância razoável a falhas parciais em cache
- recuperação incremental via backfill

## Leituras relacionadas

- [Banco de Dados](Banco-de-Dados)
- [Backfill](Backfill)
- [Produção](Produção)
- [Troubleshooting](Troubleshooting)

---

**Zyra Wiki** • Última atualização: 17/05/2026
