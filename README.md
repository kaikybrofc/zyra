# 🌌 Zyra System

**Zyra System** é um motor de bot para WhatsApp de alta performance, construído em Node.js utilizando a biblioteca [Baileys](https://github.com/WhiskeySockets/Baileys). Ele foi projetado para ser **escalável, resiliente e multi-instância**, com suporte nativo a persistência em MySQL e cache em Redis.

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

### Produção
```bash
npm run build
npm run start:prod
```

### Produção com PM2
```bash
npm run pm2:start
```

Comandos úteis:

- `npm run pm2:restart`: recompila e reinicia o processo `zyra`.
- `npm run pm2:logs`: acompanha os logs do processo.
- `npm run pm2:stop`: para a instância sem removê-la.
- `npm run pm2:delete`: remove a instância do PM2.
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

## 💡 Dicas de Infraestrutura (Pro-Tips)

### Performance SSH
Se você gerencia o servidor via SSH, habilite a **Multiplexação** no seu computador local para conexões instantâneas:
```bash
# Adicione ao seu ~/.ssh/config local
Host *
    ControlMaster auto
    ControlPath ~/.ssh/sockets/%r@%h:%p
    ControlPersist 1h
```

### Monitoramento de Logs
Utilize o `LOG_LEVEL=debug` durante o desenvolvimento para visualizar o fluxo de eventos do Baileys e as interações com o banco de dados.

---

## 🤝 Contribuidores

- **@kaikybrofc** — mantenedor do projeto.
- **@kobie3717** — feedback e melhorias na integração do `baileys-antiban` (tipagem e cleanup de timers).

---

## 📄 Licença

Este projeto está licenciado sob a **Licença MIT**. Veja o arquivo [LICENSE](LICENSE) para mais detalhes.

Copyright (c) 2026 kaikybrofc
