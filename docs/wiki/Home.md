# Zyra Wiki

Bem-vindo à wiki do **Zyra**.

Esta wiki é a referência principal para arquitetura de alto nível, operação, persistência, produção e troubleshooting do projeto. Para onboarding rápido, use o [README do repositório](../../README.md). Para detalhes profundos da arquitetura de comandos, use o [guia técnico de comandos](../README-COMMANDS.md).

## Mapa da documentação

### Quando usar cada documento

- **`README.md`**: visão geral do projeto, instalação rápida e execução inicial
- **Wiki (`docs/wiki/`)**: operação, arquitetura resumida, persistência, banco, produção e suporte
- **`docs/README-COMMANDS.md`**: internals da plataforma de comandos e visão técnica mais profunda
- **`docs/exemplodbmodel.md`**: fonte de verdade do schema MySQL

## Visão rápida do sistema

O Zyra é um motor de bot para WhatsApp baseado em Baileys, com foco em:

- operação multi-instância
- persistência híbrida
- auditoria de eventos e mensagens
- execução modular de comandos
- estabilidade operacional em produção

### Fatos operacionais importantes

- Cada instância é isolada por `WA_CONNECTION_ID` em runtime e por `connection_id` no armazenamento.
- A estratégia de autenticação prioriza **MySQL**, depois **Redis** e por fim **disco local** como fallback.
- Em produção com PM2, o ecossistema sobe **dois processos**: `zyra` e `zyra-backfill`.
- Em Docker Compose, a stack padrão sobe `zyra`, `backfill`, `mysql` e `redis`.
- O runtime usa fila por `connectionId:chatId`, com proteção contra saturação de memória e timeout de comando.

## Arquitetura em uma tela

### Camadas principais

1. **Connection/Auth**
   - criação do socket
   - recuperação de credenciais
   - reconexão e shutdown gracioso

2. **Events**
   - consumo centralizado de eventos do Baileys
   - auditoria de mensagens, grupos, labels, newsletters e blocklist

3. **Store/Persistência**
   - cache em memória
   - Redis opcional para hot path
   - MySQL como camada durável de histórico e auditoria
   - disco como fallback para auth e mídia

4. **Commands/Runtime**
   - parsing de mensagens
   - aplicação de regras transversais
   - execução de comandos desacoplados do socket bruto

## Trilhas por perfil

### Desenvolvimento

Comece por:

- [Instalação](Instalação)
- [Configuração](Configuração)
- [Comandos](Comandos)
- [Eventos](Eventos)

Objetivo: subir o projeto localmente, entender o runtime e evoluir comandos com segurança.

### Operação / Infra

Comece por:

- [Produção](Produção)
- [Banco de Dados](Banco-de-Dados)
- [Persistência](Persistência)
- [Backfill](Backfill)

Objetivo: manter o ambiente estável, observável e recuperável.

### Suporte / Diagnóstico

Comece por:

- [Troubleshooting](Troubleshooting)
- [Backfill](Backfill)
- [Persistência](Persistência)
- [Produção](Produção)

Objetivo: diagnosticar incidentes, entender falhas recorrentes e restaurar consistência operacional.

## Navegação por assunto

### Setup

- [Instalação](Instalação)
- [Configuração](Configuração)

### Runtime

- [Comandos](Comandos)
- [Comandos - Referência](Comandos-Referencia)
- [Eventos](Eventos)

### Dados

- [Banco de Dados](Banco-de-Dados)
- [Persistência](Persistência)
- [Backfill](Backfill)

### Operação

- [Produção](Produção)
- [Troubleshooting](Troubleshooting)

### Governança

- [Código de Conduta](Código-de-Conduta)

## Uso responsável

O Zyra deve ser operado para automação legítima, moderação, atendimento ou uso interno, sempre respeitando políticas da plataforma, legislação aplicável e proteção de dados.

Consulte também:

- [Código de Conduta](Código-de-Conduta)
- [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md)

---

**Zyra Wiki** • Última atualização: 17/05/2026