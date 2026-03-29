# Zyra System

Zyra System — bot de WhatsApp em Node.js usando Baileys.

## Requisitos

- Node.js LTS (>=20)
- npm

## Instalação rápida

1. Instale as dependências:

```bash
npm install
```

2. Crie o arquivo `.env` a partir do `.env.example`:

```bash
cp .env.example .env
```

3. Configure as variáveis de ambiente:

`WA_AUTH_DIR`: caminho para os arquivos de sessão do WhatsApp (padrão: `data/auth`).

`WA_PRINT_QR`: `true` ou `false` para imprimir o QR no terminal.

`LOG_LEVEL`: nível de log (`trace|debug|info|warn|error|fatal`).

## Como rodar

Desenvolvimento:

```bash
npm run dev
```

Produção:

```bash
npm run build
npm start
```

Nota: o QR aparece no terminal no primeiro login quando `WA_PRINT_QR=true`. Se não aparecer, já existe uma sessão salva em `data/auth`.
