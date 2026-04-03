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

    await client.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id           TEXT PRIMARY KEY,
        mp_plan_id   TEXT,
        name         TEXT NOT NULL,
        description  TEXT,
        price        NUMERIC(10,2) NOT NULL DEFAULT 0,
        features     TEXT NOT NULL DEFAULT '[]',
        featured     BOOLEAN NOT NULL DEFAULT FALSE,
        init_point   TEXT,
        active       BOOLEAN NOT NULL DEFAULT TRUE,
        created_at   TEXT NOT NULL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id                  TEXT PRIMARY KEY,
        mp_subscription_id  TEXT,
        plan_id             TEXT,
        mp_plan_id          TEXT,
        client_name         TEXT,
        client_phone        TEXT,
        client_email        TEXT,
        status              TEXT NOT NULL DEFAULT 'pending',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
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

// ── HELPERS MP ─────────────────────────────────────────────────────────────
async function mpFetch(path, opts = {}) {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) throw new Error('MP_ACCESS_TOKEN não configurado');
  const res = await fetch('https://api.mercadopago.com' + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.error || `MP API ${res.status}`);
  return json;
}

// ── API: PLANS ─────────────────────────────────────────────────────────────
app.get('/api/plans', async (req, res) => {
  try {
    const where = req.query.active === 'true' ? 'WHERE active = TRUE' : '';
    const { rows } = await pool.query(`SELECT * FROM plans ${where} ORDER BY price ASC`);
    res.json(rows.map(r => ({ ...r, features: typeof r.features === 'string' ? JSON.parse(r.features) : r.features })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/plans', async (req, res) => {
  try {
    const { name, description = '', price, features = [], featured = false } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'name e price obrigatórios' });

    const siteUrl = process.env.SITE_URL || 'https://mister-das-navalhas-production.up.railway.app';
    let mp_plan_id = null, init_point = null;

    try {
      const mpRes = await mpFetch('/preapproval_plan', {
        method: 'POST',
        body: {
          reason: name,
          auto_recurring: {
            frequency: 1,
            frequency_type: 'months',
            transaction_amount: parseFloat(price),
            currency_id: 'BRL',
          },
          payment_methods_allowed: { payment_types: [{ id: 'credit_card' }] },
          back_url: siteUrl + '/?payment=success',
        },
      });
      mp_plan_id = mpRes.id || null;
      init_point = mpRes.init_point || null;
      console.log('✅ Plano MP criado:', mp_plan_id);
    } catch (mpErr) {
      console.warn('⚠️ Plano não criado no MP:', mpErr.message);
    }

    const id = uuid();
    await pool.query(
      `INSERT INTO plans (id,mp_plan_id,name,description,price,features,featured,init_point,active,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9)`,
      [id, mp_plan_id, name, description, price, JSON.stringify(features), featured, init_point, nowStr()]
    );
    const { rows } = await pool.query('SELECT * FROM plans WHERE id=$1', [id]);
    const r = rows[0];
    res.status(201).json({ ...r, features: typeof r.features === 'string' ? JSON.parse(r.features) : r.features });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/plans/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const fields = [], vals = [];
    const allowed = ['name','description','price','features','featured','active','init_point'];
    allowed.forEach(k => {
      if (req.body[k] !== undefined) {
        fields.push(`${k}=$${fields.length + 1}`);
        vals.push(k === 'features' ? JSON.stringify(req.body[k]) : req.body[k]);
      }
    });
    if (!fields.length) return res.status(400).json({ error: 'Nada para atualizar' });
    vals.push(id);
    await pool.query(`UPDATE plans SET ${fields.join(',')} WHERE id=$${vals.length}`, vals);
    const { rows } = await pool.query('SELECT * FROM plans WHERE id=$1', [id]);
    const r = rows[0];
    res.json({ ...r, features: typeof r.features === 'string' ? JSON.parse(r.features) : r.features });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/plans/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT mp_plan_id FROM plans WHERE id=$1', [req.params.id]);
    if (rows[0]?.mp_plan_id) {
      await mpFetch(`/preapproval_plan/${rows[0].mp_plan_id}`, {
        method: 'PUT',
        body: { status: 'inactive' },
      }).catch(e => console.warn('Aviso ao desativar plano MP:', e.message));
    }
    await pool.query('DELETE FROM plans WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: SUBSCRIPTIONS ─────────────────────────────────────────────────────
app.get('/api/subscriptions', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM subscriptions ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/subscriptions', async (req, res) => {
  try {
    const { plan_id, client_name, client_phone, client_email } = req.body;
    if (!plan_id || !client_name || !client_phone)
      return res.status(400).json({ error: 'plan_id, client_name e client_phone obrigatórios' });
    const { rows: planRows } = await pool.query('SELECT * FROM plans WHERE id=$1', [plan_id]);
    const plan = planRows[0];
    const id = uuid();
    const now2 = nowStr();
    await pool.query(
      `INSERT INTO subscriptions (id,mp_subscription_id,plan_id,mp_plan_id,client_name,client_phone,client_email,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9)`,
      [id, null, plan_id, plan?.mp_plan_id || null, client_name, client_phone, client_email || null, now2, now2]
    );
    const { rows } = await pool.query('SELECT * FROM subscriptions WHERE id=$1', [id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/subscriptions/:id', async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE subscriptions SET status=$1, updated_at=$2 WHERE id=$3', [status, nowStr(), req.params.id]);
    const { rows } = await pool.query('SELECT * FROM subscriptions WHERE id=$1', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/subscriptions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM subscriptions WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WEBHOOK: MERCADO PAGO ────────────────────────────────────────────────
app.post('/api/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data, action } = req.body;
    console.log('📩 Webhook MP recebido:', type, action, data?.id);

    res.sendStatus(200); // MP exige resposta < 5s

    const mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken || !data?.id) return;

    // Pagamento avulso (agendamentos)
    if (type === 'payment') {
      const payment = await mpFetch(`/v1/payments/${data.id}`).catch(() => null);
      if (!payment) return;
      console.log('💳 Pagamento MP:', payment.status, payment.external_reference);
      if (payment.status === 'approved' && payment.external_reference) {
        await pool.query(`UPDATE appointments SET status='confirmed' WHERE id=$1`, [payment.external_reference])
          .catch(e => console.error('Erro ao confirmar agendamento:', e.message));
      }
      return;
    }

    // Assinatura criada / atualizada
    if (type === 'subscription_preapproval' || type === 'preapproval') {
      const sub = await mpFetch(`/preapproval/${data.id}`).catch(() => null);
      if (!sub) return;
      console.log('📋 Assinatura MP:', sub.status, sub.preapproval_plan_id);
      const { rows: planRows } = await pool.query('SELECT id FROM plans WHERE mp_plan_id=$1', [sub.preapproval_plan_id]);
      const localPlanId = planRows[0]?.id || null;
      const existing = await pool.query('SELECT id FROM subscriptions WHERE mp_subscription_id=$1', [sub.id]);
      if (existing.rows.length) {
        await pool.query('UPDATE subscriptions SET status=$1, updated_at=$2 WHERE mp_subscription_id=$3', [sub.status, nowStr(), sub.id]);
        console.log('🔄 Assinatura atualizada:', sub.id, sub.status);
      } else {
        const clientName = sub.payer_first_name
          ? `${sub.payer_first_name} ${sub.payer_last_name || ''}`.trim()
          : (sub.payer_email || 'Cliente MP');
        await pool.query(
          `INSERT INTO subscriptions (id,mp_subscription_id,plan_id,mp_plan_id,client_name,client_phone,client_email,status,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [uuid(), sub.id, localPlanId, sub.preapproval_plan_id, clientName, null, sub.payer_email || null, sub.status, nowStr(), nowStr()]
        );
        console.log('✅ Nova assinatura salva:', sub.id);
      }
      return;
    }

    // Pagamento de assinatura aprovado
    if (type === 'subscription_authorized_payment') {
      const payment = await mpFetch(`/v1/payments/${data.id}`).catch(() => null);
      if (payment?.status === 'approved' && payment.metadata?.preapproval_id) {
        await pool.query('UPDATE subscriptions SET status=$1, updated_at=$2 WHERE mp_subscription_id=$3',
          ['authorized', nowStr(), payment.metadata.preapproval_id]).catch(e => console.error(e.message));
        console.log('💚 Pagamento de assinatura aprovado:', payment.metadata.preapproval_id);
      }
    }
  } catch (e) {
    console.error('Erro no webhook MP:', e.message);
  }
});

// ── API: CHECK SUBSCRIBER ─────────────────────────────────────────────────
app.get('/api/subscriptions/check', async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.json({ subscriber: false });
    const normalized = phone.replace(/\D/g, '');
    const { rows } = await pool.query(
      `SELECT s.*, p.name AS plan_name FROM subscriptions s
       LEFT JOIN plans p ON s.plan_id = p.id
       WHERE REGEXP_REPLACE(COALESCE(s.client_phone,''), '[^0-9]', '', 'g') = $1
         AND s.status IN ('authorized','manual')
       LIMIT 1`,
      [normalized]
    );
    res.json({ subscriber: rows.length > 0, subscription: rows[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: SIGNAL PAYMENT (sinal de agendamento) ────────────────────────────
app.post('/api/payment/signal', async (req, res) => {
  try {
    const { appointment_id, client_name, client_email } = req.body;
    if (!appointment_id) return res.status(400).json({ error: 'appointment_id obrigatório' });
    const siteUrl = process.env.SITE_URL || 'https://mister-das-navalhas-production.up.railway.app';
    const pref = await mpFetch('/checkout/preferences', {
      method: 'POST',
      body: {
        items: [{
          title: 'Sinal de Agendamento — Mister das Navalhas',
          quantity: 1,
          unit_price: 10.00,
          currency_id: 'BRL',
        }],
        payer: client_email ? { email: client_email, name: client_name } : undefined,
        external_reference: appointment_id,
        back_urls: {
          success: `${siteUrl}/?payment=success&appt=${appointment_id}`,
          failure: `${siteUrl}/?payment=failure&appt=${appointment_id}`,
          pending: `${siteUrl}/?payment=pending&appt=${appointment_id}`,
        },
        auto_return: 'approved',
        statement_descriptor: 'MISTER DAS NAVALHAS',
      },
    });
    res.json({ init_point: pref.init_point, sandbox_init_point: pref.sandbox_init_point });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
