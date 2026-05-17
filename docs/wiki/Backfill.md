# Backfill

O backfill é parte do desenho operacional do Zyra. Ele não existe apenas como ferramenta pontual: em produção, ele pode rodar continuamente para reparar e enriquecer dados derivados ao longo do tempo.

Arquivo principal:

- `src/core/db/backfill.ts`

## Objetivo

O worker de backfill corrige dados incompletos ou inconsistentes sem interromper o fluxo online do bot.

Ele atua especialmente em:

- identidade derivada
- vínculos entre usuários e mensagens
- metadados de mídia
- relações de chats, grupos e contatos
- consistência histórica em tabelas de auditoria

## Modos de execução

### Execução contínua

É o modo recomendado em produção. O worker roda em ciclos, com intervalo configurável, e usa checkpoints para retomar de onde parou.

### Execução one-shot

Útil para manutenção manual, validação ou recuperação pontual.

Exemplo:

```bash
WA_BACKFILL_ONCE=true npm run db:backfill
```

## Checkpoints

O worker usa `backfill_checkpoints` para persistir progresso por etapa.

Isso permite:

- retomada incremental
- redução de retrabalho
- execução segura em lotes
- melhor previsibilidade operacional

## Comportamento geral do worker

Características principais:

- execução em ciclos
- batch size configurável
- múltiplas passagens por ciclo
- métricas de antes/depois para pendências críticas
- logs por etapa
- tolerância a enriquecimento progressivo

## Etapas típicas

Entre as tarefas executadas pelo worker, estão:

- normalização de usuários e identificadores
- preenchimento de `sender_user_id`
- reconciliação de `message_events` e `events_log`
- preenchimento de nomes visíveis e relações derivadas
- complementação de metadados de mídia local
- atualização de relações de grupos, chats e contatos

## Prioridade crítica de qualidade de dados

O ciclo atual prioriza redução rápida de lacunas em campos de identidade e visibilidade, especialmente:

1. `wa_contacts_cache.user_id`
2. `lid_mappings.user_id`
3. `users.display_name`
4. `wa_contacts_cache.display_name`
5. `chats.display_name`

Esse foco melhora rapidamente trilhas de comando, auditoria e troubleshooting.

## Backfill de mídia local

Quando `WA_MEDIA_AUTO_DOWNLOAD=true`, o worker também pode completar campos derivados de mídia local, como:

- `message_media.file_length`
- `message_media.file_name`

Esses dados podem ser inferidos a partir do arquivo já salvo em disco.

## Operação segura

Recomendações:

- usar backup recente do banco em ambientes críticos
- monitorar duração por ciclo
- ajustar batch size se houver pressão excessiva no MySQL
- validar redução de pendências com `db:nulls` e `db:verify`

## Comandos úteis

```bash
npm run db:backfill
npm run db:verify
npm run db:nulls
```

## Quando usar one-shot

Use modo one-shot quando precisar:

- validar uma correção de schema/comportamento
- recuperar consistência após incidente
- observar impacto de uma mudança antes de recolocar o worker contínuo

## Leituras relacionadas

- [Banco de Dados](Banco-de-Dados)
- [Persistência](Persistência)
- [Produção](Produção)
- [Troubleshooting](Troubleshooting)

---

**Zyra Wiki** • Última atualização: 17/05/2026