# Instalação

Este guia cobre a instalação do Zyra em ambiente local ou servidor Linux, com foco em previsibilidade e validação rápida do setup.

Para um onboarding mais curto, veja também o [README do repositório](../../README.md).

## Pré-requisitos

- **Node.js** 20 ou superior
- **npm** como gerenciador principal do projeto
- **MySQL 8.0+** para persistência durável e auditoria
- **Redis 6.0+** opcional, mas recomendado para cache quente e melhor performance
- **Git**

## Dependências do projeto

O runtime principal usa:

- TypeScript + TSX
- Baileys para conexão WhatsApp
- `mysql2` para persistência SQL
- `redis` para cache distribuído
- `pm2` para operação em produção

## Provisionamento básico do host

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install -y git curl build-essential
```

### Instalação do Node.js

Exemplo com `nvm`:

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install --lts
node -v
npm -v
```

### Instalação do MySQL

```bash
sudo apt install -y mysql-server
sudo systemctl enable --now mysql
sudo mysql -e "CREATE DATABASE IF NOT EXISTS zyra CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

### Instalação do Redis

```bash
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
redis-cli ping
```

## Clonar e instalar o projeto

```bash
git clone https://github.com/kaikybrofc/zyra.git
cd zyra
npm install
```

Para reproduzir o fluxo da CI com mais fidelidade:

```bash
npm ci
```

## Observação sobre dependências

O projeto não depende mais de pacotes privados para a instalação padrão.

Se `npm install` ou `npm ci` falhar, revise rede, cache local do npm e resolução de dependências públicas.

## Configuração inicial

Crie o `.env` a partir do exemplo:

```bash
cp .env.example .env
```

Variáveis mínimas para a primeira subida:

- `WA_CONNECTION_ID` para uma sessão explícita, ou `WA_CONNECTION_IDS` para várias sessões explícitas
- `MYSQL_URL`
- `WA_COMMAND_PREFIX` (opcional)
- `WA_REDIS_URL` (opcional, recomendado)

Os detalhes completos estão em [Configuração](Configuração).

## Inicialização do schema

```bash
npm run db:init
```

Esse passo cria tabelas ausentes, garante índices críticos e registra a conexão quando necessário. A fonte de verdade do schema está em `docs/exemplodbmodel.md`.

## Validação pós-instalação

```bash
npm run lint
npm run build
npm test
npm run db:verify
```

## Primeira execução

### Desenvolvimento

```bash
npm run dev
```

### Execução simples

```bash
npm run start
```

Com o processo ativo, acompanhe o bootstrap e faça o pareamento via QR Code quando necessário.

Se `WA_CONNECTION_IDS` não estiver definido e o MySQL já tiver sessões persistidas em `auth_creds`, o bootstrap pode descobrir automaticamente quais conexões devem subir.

## Checklist de aceite

- build TypeScript executa sem erro
- conexão com MySQL está funcional
- `npm run db:init` conclui com sucesso
- `npm run db:verify` retorna estado coerente da conexão atual
- a aplicação inicia e consegue receber eventos do WhatsApp
- logs passam a ser gravados normalmente

## Próximos passos

Depois da instalação:

- [Configuração](Configuração)
- [Comandos](Comandos)
- [Produção](Produção)

---

**Zyra Wiki** • Última atualização: 17/05/2026