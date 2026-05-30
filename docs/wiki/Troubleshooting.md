# Troubleshooting

Esta página é um runbook orientado a sintomas para diagnosticar incidentes no Zyra.

## Ordem recomendada de diagnóstico

Comece por esta sequência:

```bash
npm run build
npm run db:verify
npm run pm2:logs
```

Depois verifique:

- logs estruturados de aplicação, aviso e erro
- conectividade com MySQL
- conectividade com Redis, quando configurado
- estado do backfill
- configuração ativa da instância (`WA_CONNECTION_ID`, prefixo, métricas, health)

## Cenários comuns

### 1. Sessão não estabiliza ou reconecta sem parar

Verifique:

- se `WA_CONNECTION_ID` está correto e não conflita com outra instância
- disponibilidade do backend de auth configurado
- conectividade com MySQL e Redis
- logs de `connection.update`
- políticas antiban agressivas ou sessão marcada como restrita

Cruzar com:

- [Configuração](Configuração)
- [Persistência](Persistência)

### 2. Comando não responde

Verifique:

- `WA_COMMAND_PREFIX`
- se a mensagem chegou como `messages.upsert` do tipo `notify`
- saturação de fila por chat
- timeout de execução (`WA_COMMAND_TIMEOUT_MS`)
- erros no processor/runtime

Se o problema for específico de permissão, valide também contexto de grupo e papel do executor.

Cruzar com:

- [Comandos](Comandos)
- [Eventos](Eventos)

### 3. Fila saturada ou processamento lento

Verifique:

- `WA_ROUTER_MAX_PENDING_PER_QUEUE`
- `WA_COMMAND_TIMEOUT_MS`
- burst de mensagens em um único chat
- handlers lentos ou travados
- pressão geral no processo

Esse sintoma costuma aparecer como descarte defensivo de mensagens ou atraso acumulado em um chat específico.

### 4. Antilink não age como esperado

Verifique:

- se o recurso está ativo no grupo
- whitelist de domínios
- exceção para link do próprio grupo
- se o remetente é admin
- se o bot tem permissão de remoção
- se a mensagem contém link detectável no formato esperado

Lembrete importante:

- `antilink` é comando de configuração **e** regra automática do processor

Cruzar com:

- [Comandos](Comandos)
- [Comandos - Referência](Comandos-Referencia)

### 5. Mídia com metadados incompletos

Verifique:

- `WA_MEDIA_AUTO_DOWNLOAD`
- execução do backfill
- presença de `local_path` em `message_media`
- se `file_length` e `file_name` ainda estão pendentes

Ações típicas:

```bash
npm run db:backfill
npm run db:nulls
```

### 6. Nulos altos em dados derivados

Sintomas comuns:

- `users.display_name` acima do esperado
- `chats.display_name` acima do esperado
- lacunas em `sender_user_id`
- vínculos incompletos em eventos

Ações:

```bash
npm run db:backfill
npm run db:nulls
npm run db:verify
```

Observe se o worker está efetivamente reduzindo pendências entre ciclos.

### 7. Métricas ou health não aparecem

Verifique:

- `WA_ANTIBAN_METRICS_ENABLED`
- host/porta/path configurados
- `WA_HEALTH_ENABLED`
- firewall e bind do host
- processo realmente ativo

Cruzar com:

- [Configuração](Configuração)
- [Produção](Produção)

### 8. PM2 ou Docker sem os processos esperados

Verifique:

- se o build concluiu
- se `zyra` e `zyra-backfill` estão online no PM2
- se os serviços `zyra`, `backfill`, `mysql` e `redis` estão ativos no Compose
- se houve crash por dependência de banco/cache

## Comandos úteis de suporte

```bash
npm run db:verify
npm run db:nulls
npm run db:backfill
npm run pm2:logs
docker compose ps
docker compose logs -f zyra
docker compose logs -f backfill
```

## Boas práticas preventivas

- validar build antes de restart em produção
- observar logs imediatamente após deploy
- manter registro de mudanças de configuração por ambiente
- monitorar backfill, disco e conectividade com banco
- revisar periodicamente métricas e falhas recorrentes

## Leituras relacionadas

- [Configuração](Configuração)
- [Persistência](Persistência)
- [Backfill](Backfill)
- [Produção](Produção)

---

**Zyra Wiki** • Última atualização: 17/05/2026
