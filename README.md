# Mister das Navalhas 🔪

Barbearia Mister das Navalhas — Sistema de agendamento online + painel admin.

## Stack

- **Backend:** Node.js + Express
- **Banco de dados:** SQLite (via `sql.js` — puro JavaScript, sem compilação nativa)
- **Frontend:** HTML/CSS/JS puro (sem framework)

## Estrutura

```
mister-navalhas/
├── server.js          ← API REST + servidor de arquivos estáticos
├── package.json
├── railway.toml       ← Configuração de deploy Railway
├── db/
│   └── barbearia.db   ← Gerado automaticamente ao subir
└── public/
    ├── index.html     ← Site público (agendamento)
    ├── admin.html     ← Painel do barbeiro
    ├── logo.png
    └── wesley.png
```

## Rotas da API

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/barbers` | Lista barbeiros ativos |
| GET | `/api/services` | Lista serviços |
| POST | `/api/services` | Cria serviço |
| PATCH | `/api/services/:id` | Edita serviço |
| DELETE | `/api/services/:id` | Remove serviço |
| GET | `/api/appointments` | Lista agendamentos |
| POST | `/api/appointments` | Cria agendamento |
| PATCH | `/api/appointments/:id` | Atualiza status |
| GET | `/api/barber_availability` | Busca disponibilidade |
| POST | `/api/barber_availability` | Salva disponibilidade (upsert) |

## Deploy no Railway

### 1. Instalar Railway CLI (opcional)
```bash
npm install -g @railway/cli
railway login
```

### 2. Via GitHub (recomendado)
1. Crie um repositório no GitHub e faça push deste projeto
2. Acesse [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Selecione o repositório
4. Railway detecta automaticamente Node.js e faz o deploy

### 3. Adicionar Volume para persistência do banco

> ⚠️ Importante: sem um volume, o banco SQLite é perdido a cada novo deploy.

No Railway:
1. Vá no seu serviço → aba **Volumes**
2. Clique em **Add Volume**
3. Mount path: `/app/db`
4. Isso garante que `db/barbearia.db` persista entre deploys

### 4. Variável de ambiente (opcional)
```
PORT=3000          ← Railway define automaticamente
DB_PATH=/app/db/barbearia.db  ← já é o padrão
```

## Rodar localmente

```bash
npm install
npm start
# Acesse: http://localhost:3000
# Admin:   http://localhost:3000/admin
```

## Senha do Admin

A senha padrão é: `barbearia2025`

Para alterar, edite a constante `ADMIN_PASSWORD` no arquivo `public/admin.html`.
