# Zyra System

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PM2 Ready](https://img.shields.io/badge/pm2-ready-2B037A?logo=pm2&logoColor=white)](https://pm2.keymetrics.io/)

Motor de bot para WhatsApp construído com [Baileys](https://github.com/WhiskeySockets/Baileys), focado em performance, resiliência e operação multi-instância. O projeto oferece persistência híbrida (MySQL, Redis e disco), arquitetura modular de comandos e recursos de observabilidade para ambientes de produção.

## Links Rápidos

- [Pré-requisitos](#-pré-requisitos)
- [Configuração do Projeto](#️-configuração-do-projeto)
- [Como Executar](#-como-executar)
- [Arquitetura do Sistema](#-arquitetura-do-sistema)
- [Ferramentas de Manutenção](#️-ferramentas-de-manutenção)
- [Wiki do Projeto](#-wiki-do-projeto)
- [Licença](#-licença)

## 📚 Wiki do Projeto

- [Home da Wiki](docs/wiki/Home.md)
- [Instalação](docs/wiki/Instalação.md)
- [Configuração](docs/wiki/Configuração.md)
- [Comandos](docs/wiki/Comandos.md)
- [Eventos](docs/wiki/Eventos.md)
- [Produção](docs/wiki/Produção.md)
- [Troubleshooting](docs/wiki/Troubleshooting.md)
- [Banco de Dados](docs/wiki/Banco-de-Dados.md)
- [Persistência](docs/wiki/Persistência.md)
- [Backfill](docs/wiki/Backfill.md)

---

## 🚀 Principais Diferenciais

- **Multi-instância Nativa:** Utilize o mesmo banco de dados para centenas de conexões isoladas via `connection_id`.
- **Persistência Híbrida:** Sistema de autenticação inteligente que alterna entre **MySQL**, **Redis** e **Disco** (FileSystem) para máxima resiliência.
- **Identidade Unificada:** Mapeamento inteligente de usuários (PN, LID, JID, Username) para um único ID interno.
- **Store de Alta Performance:** Cache de contatos, chats e mensagens otimizado para baixa latência.
- **Arquitetura Modular de Comandos:** Comandos desacoplados do núcleo com contexto próprio e funções de core prontas (consulte [README-COMMANDS.md](docs/README-COMMANDS.md)).
- **Observabilidade Total:** Logs estruturados e rastreamento de eventos para auditoria e troubleshooting.

---

## 📋 Pré-requisitos

- **Node.js:** v20.x (LTS) ou superior.
- **Gerenciador de Pacotes:** `npm` ou `yarn`.
- **Banco de Dados:** MySQL 8.0+ (Obrigatório para persistência de longo prazo).
- **Cache:** Redis 6.0+ (Altamente recomendado para performance).

---

## 🛠️ Instalação de Dependências

### 1. Servidor MySQL
O Zyra utiliza recursos modernos do MySQL 8 (como tipos JSON e índices Full-text).

**No Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install mysql-server -y
# Acesse o MySQL e crie o banco
sudo mysql -u root
# CREATE DATABASE zyra CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 2. Servidor Redis
O Redis é utilizado para "cache quente" das sessões de autenticação e estados temporários do socket.

**No Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install redis-server -y
sudo systemctl enable redis-server
```

---

## ⚙️ Configuração do Projeto

1. **Clonar e Instalar:**
   ```bash
   git clone <repo-url>
   cd zyra
   npm install
   ```

2. **Variáveis de Ambiente:**
   Crie um arquivo `.env` baseado no `.env.example`:
   ```bash
   cp .env.example .env
   ```

3. **Inicializar o Banco de Dados:**
   O Zyra possui um script automático que cria todas as tabelas necessárias:
   ```bash
   npm run db:init
   ```

---

## 🚦 Como Executar

### Desenvolvimento
```bash
npm run dev
```

### Docker

O repositório já inclui `Dockerfile` (multi-stage) e `docker-compose.yml` com:
- `zyra` (bot principal)
- `backfill` (worker de backfill)
- `mysql` (MySQL 8)
- `redis` (Redis 7)

#### 1. Criar `.env`
```bash
cp .env.example .env
```

#### 2. Build das imagens
O `Dockerfile` usa pacote privado no `npm ci`, então passe o token como secret:

```bash
export NPM_TOKEN=seu_token_aqui
DOCKER_BUILDKIT=1 docker build --secret id=npm_token,env=NPM_TOKEN -t zyra:local .
```

#### 3. Subir stack com Compose
```bash
docker compose up -d --build
```

#### 4. Inicializar banco (primeira execução)
```bash
docker compose exec zyra node dist/core/db/init.js
```

#### 5. Ver logs e status
```bash
docker compose ps
docker compose logs -f zyra
docker compose logs -f backfill
```

#### 6. Parar stack
```bash
docker compose down
```

Observações:
- Persistência de sessão/mídia: volume `zyra-data` em `/app/data`.
- Métricas do antiban expostas em `9108` (`http://localhost:9108/metrics`).

### Produção
```bash
npm run build
npm run start:prod
```

### Produção com PM2
```bash
npm run pm2:start
```

Ao iniciar via PM2, o sistema sobe dois processos:
- `zyra`: bot principal.
- `zyra-backfill`: worker contínuo de backfill de banco.

Comandos úteis:

- `npm run pm2:restart`: recompila e reinicia os processos do ecossistema (`zyra` e `zyra-backfill`).
- `npm run pm2:logs`: acompanha os logs de `zyra` e `zyra-backfill`.
- `npm run pm2:stop`: para `zyra` e `zyra-backfill` sem remover.
- `npm run pm2:delete`: remove `zyra` e `zyra-backfill` do PM2.
- `npm run pm2:save`: salva a lista atual de processos para restauração automática.
- `npm run pm2:startup`: gera o comando de inicialização automática do PM2 no boot do servidor.

Fluxo recomendado para manter o bot subindo com o servidor:

```bash
npm run pm2:start
npm run pm2:save
npm run pm2:startup
```

---

## 🧠 Arquitetura do Sistema

### Fluxo de Autenticação (Multi-Layer)
O sistema busca as credenciais na seguinte ordem de prioridade:
1. **Redis:** Acesso ultra-rápido para sessões ativas.
2. **MySQL:** Persistência durável e compartilhada.
3. **Disco:** Fallback local em caso de falha de rede.

### Gerenciamento de Memória e Histórico
A política de sincronização de histórico (`history-sync.ts`) é otimizada para liberar o sync completo apenas em novos logins, evitando o consumo excessivo de memória e processamento em reconexões rápidas.

---

## 🛠️ Ferramentas de Manutenção

O projeto inclui scripts utilitários para operações avançadas:

- **`npm run db:verify`**: Verifica a integridade das tabelas e conta registros por conexão.
- **`npm run db:delete-session`**: Limpa todos os dados de uma sessão específica (MySQL e Redis).
- **`npm run db:backfill`**: Processa mensagens antigas ou pendentes no banco.
- **`npm run db:nulls`**: Gera relatórios de campos inconsistentes para limpeza.

---

## 🤝 Contribuidores

- **@kaikybrofc** — mantenedor do projeto.
- **@kobie3717** — integração do [`baileys-antiban`](https://github.com/kobie3717/baileys-antiban)

---

## 📘 Código de Conduta

Este projeto segue um código de conduta para colaboração e uso responsável da plataforma:
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

---

## 📄 Licença

Este projeto está licenciado sob a **Licença MIT**. Veja o arquivo [LICENSE](LICENSE) para mais detalhes.

Copyright (c) 2026 kaikybrofc
