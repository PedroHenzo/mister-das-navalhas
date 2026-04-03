const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── POSTGRES POOL ─────────────────────────────────────────────────────────
// Railway pode injetar DATABASE_URL, DATABASE_PUBLIC_URL ou variáveis PG* separadas
const connectionString =
  process.env.DATABASE_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  process.env.POSTGRES_URL ||
  process.env.PGURL;

// Log todas as vars disponíveis para debug (sem expor senhas)
console.log('📋 Variáveis de ambiente detectadas:', Object.keys(process.env).filter(k =>
  k.includes('DATABASE') || k.includes('POSTGRES') || k.includes('PG')
).join(', ') || 'nenhuma');

let pool;
if (connectionString) {
  console.log('🔌 Conectando via connection string:', connectionString.replace(/:\/\/.*@/, '://***@'));
  pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });
} else if (process.env.PGHOST) {
  console.log('🔌 Conectando via variáveis PG* — host:', process.env.PGHOST);
  pool = new Pool({
    host:     process.env.PGHOST,
    port:     parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE,
    user:     process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false },
  });
} else {
  console.error('❌ Nenhuma variável de conexão PostgreSQL encontrada.');
  console.error('   Esperado: DATABASE_URL ou PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE');
  process.exit(1);
}

// ── HELPERS ───────────────────────────────────────────────────────────────
function uuid() {
  return Math.random().toString(36).slice(2, 10) +
         Math.random().toString(36).slice(2, 10);
}
function nowStr() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ── MIGRATIONS / SEED ─────────────────────────────────────────────────────
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS barbers (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        active      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TEXT NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS services (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        description  TEXT,
        duration_min INTEGER NOT NULL DEFAULT 50,
        price        NUMERIC(10,2) NOT NULL DEFAULT 0,
        active       BOOLEAN NOT NULL DEFAULT TRUE,
        created_at   TEXT NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id            TEXT PRIMARY KEY,
        barber_id     TEXT NOT NULL,
        service_id    TEXT NOT NULL,
        client_name   TEXT NOT NULL,
        client_phone  TEXT NOT NULL,
        client_email  TEXT,
        appt_date     TEXT NOT NULL,
        time_slot     TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        source        TEXT NOT NULL DEFAULT 'online',
        created_at    TEXT NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS barber_availability (
        id          TEXT PRIMARY KEY,
        barber_id   TEXT NOT NULL,
        avail_date  TEXT NOT NULL,
        time_slots  TEXT NOT NULL DEFAULT '[]',
        UNIQUE(barber_id, avail_date)
      );
    `);

    // Seed inicial — só insere se não existir nenhum barbeiro
    const { rows } = await client.query('SELECT COUNT(*) AS c FROM barbers');
    if (parseInt(rows[0].c) === 0) {
      await client.query(
        `INSERT INTO barbers (id, name, active, created_at) VALUES ($1, $2, TRUE, $3)`,
        ['barber-01', 'Wesley', nowStr()]
      );
      const seeds = [
        ['Corte Clássico',  'Tesoura, pente e acabamento.', 50,  45],
        ['Corte + Barba',   'Pacote completo com navalha.', 100, 75],
        ['Barba Completa',  'Modelagem com toalha quente.', 50,  40],
        ['Degradê',         'Fade do mais baixo ao alto.',  50,  55],
      ];
      for (const [n, d, dur, p] of seeds) {
        await client.query(
          `INSERT INTO services (id,name,description,duration_min,price,active,created_at)
           VALUES ($1,$2,$3,$4,$5,TRUE,$6)`,
          [uuid(), n, d, dur, p, nowStr()]
        );
      }
      console.log('✅ Banco inicializado com dados padrão.');
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API: BARBERS ──────────────────────────────────────────────────────────
app.get('/api/barbers', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM barbers WHERE active = TRUE');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: SERVICES ─────────────────────────────────────────────────────────
app.get('/api/services', async (req, res) => {
  try {
    const where = req.query.active === 'true' ? 'WHERE active = TRUE' : '';
    const { rows } = await pool.query(
      `SELECT * FROM services ${where} ORDER BY price ASC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/services', async (req, res) => {
  try {
    const { name, description = '', duration_min = 50, price, active = true } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'name e price obrigatórios' });
    const id = uuid();
    await pool.query(
      `INSERT INTO services (id,name,description,duration_min,price,active,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, name, description, duration_min, price, active, nowStr()]
    );
    const { rows } = await pool.query('SELECT * FROM services WHERE id=$1', [id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/services/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const fields = [], vals = [];
    const allowed = ['name','description','duration_min','price','active'];
    allowed.forEach(k => {
      if (req.body[k] !== undefined) {
        fields.push(`${k}=$${fields.length + 1}`);
        vals.push(req.body[k]);
      }
    });
    if (!fields.length) return res.status(400).json({ error: 'Nada para atualizar' });
    vals.push(id);
    await pool.query(
      `UPDATE services SET ${fields.join(',')} WHERE id=$${vals.length}`,
      vals
    );
    const { rows } = await pool.query('SELECT * FROM services WHERE id=$1', [id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/services/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM services WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: APPOINTMENTS ─────────────────────────────────────────────────────
app.get('/api/appointments', async (req, res) => {
  try {
    const conditions = ['1=1'], vals = [];
    if (req.query.barber_id)  { conditions.push(`barber_id=$${vals.length+1}`);  vals.push(req.query.barber_id); }
    if (req.query.appt_date)  { conditions.push(`appt_date=$${vals.length+1}`);  vals.push(req.query.appt_date); }
    if (req.query.status)     { conditions.push(`status=$${vals.length+1}`);     vals.push(req.query.status); }
    if (req.query.status_neq) { conditions.push(`status!=$${vals.length+1}`);    vals.push(req.query.status_neq); }
    const q = `SELECT * FROM appointments WHERE ${conditions.join(' AND ')} ORDER BY appt_date ASC, time_slot ASC`;
    const { rows } = await pool.query(q, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/appointments', async (req, res) => {
  try {
    const {
      barber_id, service_id, client_name, client_phone, client_email,
      appt_date, time_slot, status = 'pending', source = 'online'
    } = req.body;
    if (!barber_id||!service_id||!client_name||!client_phone||!appt_date||!time_slot)
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    const id = uuid();
    await pool.query(
      `INSERT INTO appointments
        (id,barber_id,service_id,client_name,client_phone,client_email,appt_date,time_slot,status,source,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id,barber_id,service_id,client_name,client_phone,client_email||null,
       appt_date,time_slot,status,source,nowStr()]
    );
    const { rows } = await pool.query('SELECT * FROM appointments WHERE id=$1', [id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/appointments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status obrigatório' });
    await pool.query('UPDATE appointments SET status=$1 WHERE id=$2', [status, id]);
    const { rows } = await pool.query('SELECT * FROM appointments WHERE id=$1', [id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: AVAILABILITY ─────────────────────────────────────────────────────
app.get('/api/barber_availability', async (req, res) => {
  try {
    const conditions = ['1=1'], vals = [];
    if (req.query.barber_id)  { conditions.push(`barber_id=$${vals.length+1}`);   vals.push(req.query.barber_id); }
    if (req.query.avail_date) { conditions.push(`avail_date=$${vals.length+1}`);  vals.push(req.query.avail_date); }
    if (req.query.gte)        { conditions.push(`avail_date>=$${vals.length+1}`); vals.push(req.query.gte); }
    if (req.query.lt)         { conditions.push(`avail_date<$${vals.length+1}`);  vals.push(req.query.lt); }
    const { rows } = await pool.query(
      `SELECT * FROM barber_availability WHERE ${conditions.join(' AND ')}`, vals
    );
    // Deserializa time_slots de JSON string → array
    res.json(rows.map(r => ({
      ...r,
      time_slots: typeof r.time_slots === 'string' ? JSON.parse(r.time_slots) : r.time_slots
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/barber_availability', async (req, res) => {
  try {
    const { barber_id, avail_date, time_slots } = req.body;
    if (!barber_id || !avail_date) return res.status(400).json({ error: 'barber_id e avail_date obrigatórios' });
    const slotsJson = JSON.stringify(Array.isArray(time_slots) ? time_slots : []);
    await pool.query(
      `INSERT INTO barber_availability (id, barber_id, avail_date, time_slots)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (barber_id, avail_date) DO UPDATE SET time_slots = EXCLUDED.time_slots`,
      [uuid(), barber_id, avail_date, slotsJson]
    );
    const { rows } = await pool.query(
      'SELECT * FROM barber_availability WHERE barber_id=$1 AND avail_date=$2',
      [barber_id, avail_date]
    );
    const r = rows[0];
    res.json({ ...r, time_slots: typeof r.time_slots === 'string' ? JSON.parse(r.time_slots) : r.time_slots });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WEBHOOK: MERCADO PAGO ────────────────────────────────────────────────
app.post('/api/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log('📩 Webhook MP recebido:', type, data?.id);

    // Confirma recebimento imediatamente (MP exige resposta < 5s)
    res.sendStatus(200);

    if (type === 'payment' && data?.id) {
      // Busca detalhes do pagamento na API do MP
      const mpToken = process.env.MP_ACCESS_TOKEN;
      if (!mpToken) return;

      const response = await fetch(
        `https://api.mercadopago.com/v1/payments/${data.id}`,
        { headers: { Authorization: `Bearer ${mpToken}` } }
      );
      const payment = await response.json();
      console.log('💳 Pagamento MP:', payment.status, payment.external_reference);

      // Se aprovado e tem referência de agendamento, confirma automaticamente
      if (payment.status === 'approved' && payment.external_reference) {
        await pool.query(
          `UPDATE appointments SET status='confirmed' WHERE id=$1`,
          [payment.external_reference]
        ).catch(e => console.error('Erro ao confirmar agendamento:', e.message));
      }
    }
  } catch (e) {
    console.error('Erro no webhook MP:', e.message);
    res.sendStatus(200); // sempre retorna 200 para o MP
  }
});

// ── PAGES ─────────────────────────────────────────────────────────────────
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/',      (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── START ─────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () =>
    console.log(`🔪 Mister das Navalhas rodando em http://localhost:${PORT}`)
  );
}).catch(err => {
  console.error('❌ Erro ao iniciar banco:', err);
  process.exit(1);
});
