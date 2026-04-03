# Mister das Navalhas — Backend

## Stack
- Node.js + Express
- PostgreSQL (via `pg`)
- Hospedagem: Railway

---

## Deploy no Railway

### 1. Adicionar PostgreSQL ao projeto

No dashboard do Railway:
1. Clique em **+ New** dentro do seu projeto
2. Selecione **Database → PostgreSQL**
3. O Railway cria automaticamente a variável `DATABASE_URL` e a injeta no seu serviço Node

### 2. Fazer deploy

```bash
git add .
git commit -m "migra sqlite → postgresql"
git push
```

O `server.js` cria as tabelas automaticamente no primeiro start (`initDb()`).  
Se o banco estiver vazio, insere o barbeiro Wesley e os 4 serviços padrão.

---

## Desenvolvimento local

Crie um arquivo `.env` na raiz:

```env
DATABASE_URL=postgresql://usuario:senha@localhost:5432/mister_navalhas
PORT=3000
```

Instale as dependências e rode:

```bash
npm install
npm run dev
```

---

## Variáveis de ambiente

| Variável       | Descrição                                      |
|----------------|------------------------------------------------|
| `DATABASE_URL` | String de conexão PostgreSQL (Railway injeta)  |
| `PORT`         | Porta HTTP (Railway injeta, padrão 3000)       |

---

## Rotas da API

| Método | Rota                        | Descrição                         |
|--------|-----------------------------|-----------------------------------|
| GET    | /api/barbers                | Lista barbeiros ativos            |
| GET    | /api/services               | Lista serviços                    |
| POST   | /api/services               | Cria serviço                      |
| PATCH  | /api/services/:id           | Atualiza serviço                  |
| DELETE | /api/services/:id           | Remove serviço                    |
| GET    | /api/appointments           | Lista agendamentos (com filtros)  |
| POST   | /api/appointments           | Cria agendamento                  |
| PATCH  | /api/appointments/:id       | Atualiza status do agendamento    |
| GET    | /api/barber_availability    | Consulta disponibilidade          |
| POST   | /api/barber_availability    | Salva/atualiza disponibilidade    |