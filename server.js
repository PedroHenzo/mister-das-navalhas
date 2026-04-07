const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { Pool } = require('pg');
const { Client: WAClient, LocalAuth } = require('whatsapp-web.js');
const QRCode   = require('qrcode');
const axios    = require('axios');
const FormData = require('form-data');

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
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id            TEXT PRIMARY KEY DEFAULT 'mp',
        access_token  TEXT,
        refresh_token TEXT,
        user_id       TEXT,
        scope         TEXT,
        expires_at    TEXT,
        updated_at    TEXT NOT NULL
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS ia_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await client.query(`INSERT INTO ia_config (key,value) VALUES ('ia_ativa','false') ON CONFLICT (key) DO NOTHING`);
    await client.query(`INSERT INTO ia_config (key,value) VALUES ('personality','profissional') ON CONFLICT (key) DO NOTHING`);
    await client.query(`INSERT INTO ia_config (key,value) VALUES ('welcome_msg','Olá! Bem-vindo à Mister das Navalhas 🪒 Como posso ajudar?') ON CONFLICT (key) DO NOTHING`);
    await client.query(`INSERT INTO ia_config (key,value) VALUES ('auto_book','true') ON CONFLICT (key) DO UPDATE SET value='true'`);
    await client.query(`INSERT INTO ia_config (key,value) VALUES ('fora_horario','false') ON CONFLICT (key) DO NOTHING`);
    await client.query(`INSERT INTO ia_config (key,value) VALUES ('reativacao','false') ON CONFLICT (key) DO NOTHING`);
    await client.query(`INSERT INTO ia_config (key,value) VALUES ('reativ_days','30') ON CONFLICT (key) DO NOTHING`);
    await client.query(`INSERT INTO ia_config (key,value) VALUES ('confirma_agend','true') ON CONFLICT (key) DO NOTHING`);
    await client.query(`INSERT INTO ia_config (key,value) VALUES ('confirma_dia','false') ON CONFLICT (key) DO NOTHING`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ia_conversations (
        phone         TEXT PRIMARY KEY,
        name          TEXT,
        history       TEXT NOT NULL DEFAULT '[]',
        takeover      BOOLEAN NOT NULL DEFAULT FALSE,
        last_message  TEXT,
        last_at       TEXT,
        unread        INTEGER NOT NULL DEFAULT 0
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS livechat_sessions (
        id          TEXT PRIMARY KEY,
        name        TEXT,
        phone       TEXT,
        started_at  TEXT NOT NULL,
        last_at     TEXT,
        status      TEXT DEFAULT 'active',
        takeover    BOOLEAN NOT NULL DEFAULT FALSE,
        unread      INTEGER NOT NULL DEFAULT 0
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS livechat_messages (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL
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
    const { rows } = await pool.query(
      `SELECT a.*, s.name as service_name FROM appointments a JOIN services s ON a.service_id=s.id WHERE a.id=$1`, [id]
    );
    const appt = rows[0];
    res.status(201).json(appt);
    // Envia confirmação WA se habilitado (async, não bloqueia resposta)
    if (appt.client_phone) {
      getIaConfig('confirma_agend').then(val => {
        if (val === 'true') {
          waSend(appt.client_phone,
            `✅ Olá, ${appt.client_name}! Seu agendamento foi confirmado!\n📅 ${appt.appt_date} às ${appt.time_slot}\n💈 ${appt.service_name}\n\nAguardamos você! ✂️`
          ).catch(e => console.warn('Confirmação WA:', e.message));
        }
      }).catch(() => {});
    }
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
async function getMpToken() {
  // 1. Prefer OAuth token stored in DB
  try {
    const { rows } = await pool.query(`SELECT access_token FROM oauth_tokens WHERE id='mp' AND access_token IS NOT NULL`);
    if (rows[0]?.access_token) return rows[0].access_token;
  } catch (_) {}
  // 2. Fallback to env var
  if (process.env.MP_ACCESS_TOKEN) return process.env.MP_ACCESS_TOKEN;
  throw new Error('Mercado Pago não conectado. Acesse Admin → Integrações para autorizar.');
}

async function mpFetch(path, opts = {}) {
  const token = await getMpToken();
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

// ── OAUTH: MERCADO PAGO ────────────────────────────────────────────────────
// GET /auth/mercadopago  →  redireciona para tela de autorização do MP
app.get('/auth/mercadopago', (req, res) => {
  const clientId   = process.env.MP_CLIENT_ID;
  const siteUrl    = process.env.SITE_URL || 'https://mister-das-navalhas-production.up.railway.app';
  const redirectUri = `${siteUrl}/auth/mercadopago/callback`;
  if (!clientId) return res.status(500).send('MP_CLIENT_ID não configurado no servidor.');
  const url = `https://auth.mercadopago.com/authorization?client_id=${clientId}&response_type=code&platform_id=mp&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

// GET /auth/mercadopago/callback  →  troca code por access_token
app.get('/auth/mercadopago/callback', async (req, res) => {
  const { code, error } = req.query;
  const siteUrl    = process.env.SITE_URL || 'https://mister-das-navalhas-production.up.railway.app';
  const redirectUri = `${siteUrl}/auth/mercadopago/callback`;
  if (error || !code) {
    console.error('OAuth MP erro:', error);
    return res.redirect('/admin.html?mp_oauth=error');
  }
  try {
    const resp = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.MP_CLIENT_ID,
        client_secret: process.env.MP_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.access_token) {
      console.error('OAuth MP token error:', data);
      return res.redirect('/admin.html?mp_oauth=error');
    }
    const expiresAt = data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null;
    await pool.query(`
      INSERT INTO oauth_tokens (id, access_token, refresh_token, user_id, scope, expires_at, updated_at)
      VALUES ('mp', $1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        access_token  = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        user_id       = EXCLUDED.user_id,
        scope         = EXCLUDED.scope,
        expires_at    = EXCLUDED.expires_at,
        updated_at    = EXCLUDED.updated_at
    `, [data.access_token, data.refresh_token || null, String(data.user_id || ''), data.scope || '', expiresAt, nowStr()]);
    console.log('✅ OAuth MP conectado. user_id:', data.user_id);
    // Sincroniza planos sem init_point em background
    syncPlansWithMp().catch(e => console.warn('Sync planos MP:', e.message));
    res.redirect('/admin.html?mp_oauth=success');
  } catch (e) {
    console.error('Erro callback OAuth MP:', e.message);
    res.redirect('/admin.html?mp_oauth=error');
  }
});

// Helper: cria/atualiza planos no MP e salva init_point no banco
async function syncPlansWithMp() {
  const siteUrl = process.env.SITE_URL || 'https://mister-das-navalhas-production.up.railway.app';
  const { rows: plans } = await pool.query(`SELECT * FROM plans WHERE active = TRUE`);
  for (const plan of plans) {
    try {
      let mp_plan_id = plan.mp_plan_id;
      let init_point = plan.init_point;
      if (!mp_plan_id) {
        // Cria o plano no MP
        const mpRes = await mpFetch('/preapproval_plan', {
          method: 'POST',
          body: {
            reason: plan.name,
            auto_recurring: {
              frequency: 1,
              frequency_type: 'months',
              transaction_amount: parseFloat(plan.price),
              currency_id: 'BRL',
            },
            payment_methods_allowed: { payment_types: [{ id: 'credit_card' }] },
            back_url: siteUrl + '/?payment=success',
          },
        });
        mp_plan_id = mpRes.id || null;
        init_point = mpRes.init_point || null;
        console.log(`✅ Plano "${plan.name}" criado no MP:`, mp_plan_id);
      } else if (!init_point) {
        // Plano já existe no MP, busca o init_point
        const mpRes = await mpFetch(`/preapproval_plan/${mp_plan_id}`).catch(() => null);
        init_point = mpRes?.init_point || null;
      }
      if (mp_plan_id || init_point) {
        await pool.query(
          `UPDATE plans SET mp_plan_id=$1, init_point=$2 WHERE id=$3`,
          [mp_plan_id, init_point, plan.id]
        );
      }
    } catch (e) {
      console.warn(`Erro ao sincronizar plano "${plan.name}":`, e.message);
    }
  }
  console.log('🔄 Sync de planos MP concluído.');
}

// POST /api/plans/sync  →  sincroniza todos os planos com o MP
app.post('/api/plans/sync', async (req, res) => {
  try {
    await syncPlansWithMp();
    const { rows } = await pool.query(`SELECT * FROM plans WHERE active=TRUE ORDER BY price ASC`);
    res.json({
      success: true,
      plans: rows.map(r => ({ ...r, features: typeof r.features === 'string' ? JSON.parse(r.features) : r.features }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/mp/status  →  retorna status da conexão OAuth
app.get('/api/mp/status', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT user_id, scope, expires_at, updated_at FROM oauth_tokens WHERE id='mp'`);
    if (!rows.length || !rows[0]) return res.json({ connected: false });
    res.json({ connected: true, user_id: rows[0].user_id, scope: rows[0].scope, expires_at: rows[0].expires_at, updated_at: rows[0].updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/mp/disconnect  →  revoga e remove token
app.delete('/api/mp/disconnect', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT access_token FROM oauth_tokens WHERE id='mp'`);
    if (rows[0]?.access_token) {
      // Best-effort revoke on MP side
      await fetch(`https://api.mercadopago.com/oauth/token`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${rows[0].access_token}`, 'Content-Type': 'application/json' },
      }).catch(() => {});
    }
    await pool.query(`DELETE FROM oauth_tokens WHERE id='mp'`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
    const { appointment_id, client_name, client_email, amount, item_title } = req.body;
    if (!appointment_id) return res.status(400).json({ error: 'appointment_id obrigatório' });
    const siteUrl = process.env.SITE_URL || 'https://mister-das-navalhas-production.up.railway.app';
    const pref = await mpFetch('/checkout/preferences', {
      method: 'POST',
      body: {
        items: [{
          title: item_title || 'Sinal de Agendamento — Mister das Navalhas',
          quantity: 1,
          unit_price: amount || 10.00,
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

// ── IA HELPERS ────────────────────────────────────────────────────────────
async function getIaConfig(key) {
  const { rows } = await pool.query(`SELECT value FROM ia_config WHERE key=$1`, [key]);
  return rows[0]?.value ?? null;
}
async function setIaConfig(key, value) {
  await pool.query(
    `INSERT INTO ia_config (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`,
    [key, String(value)]
  );
}

async function buildSystemPrompt(personality) {
  const { rows: services } = await pool.query(`SELECT * FROM services WHERE active=TRUE ORDER BY price ASC`);
  const { rows: barbers }  = await pool.query(`SELECT id, name FROM barbers WHERE active=TRUE LIMIT 1`);
  const barberName = barbers[0]?.name || 'Wesley';
  const siteUrl = process.env.SITE_URL || 'https://mister-das-navalhas-production.up.railway.app';

  // Busca disponibilidade real dos próximos 14 dias
  const today = new Date().toISOString().slice(0, 10);
  const future = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  let availText = '';
  if (barbers[0]) {
    const { rows: avail } = await pool.query(
      `SELECT avail_date, time_slots FROM barber_availability
       WHERE barber_id=$1 AND avail_date>=$2 AND avail_date<=$3 ORDER BY avail_date`,
      [barbers[0].id, today, future]
    );
    // Para cada dia com disponibilidade, remove horários já ocupados
    const lines = [];
    for (const a of avail) {
      const slots = typeof a.time_slots === 'string' ? JSON.parse(a.time_slots) : a.time_slots;
      if (!slots.length) continue;
      const { rows: booked } = await pool.query(
        `SELECT time_slot FROM appointments
         WHERE barber_id=$1 AND appt_date=$2 AND status NOT IN ('cancelled','rejected')`,
        [barbers[0].id, a.avail_date]
      );
      const bookedSet = new Set(booked.map(b => b.time_slot));
      const free = slots.filter(s => !bookedSet.has(s));
      if (free.length) lines.push(`• ${a.avail_date}: ${free.join(', ')}`);
    }
    availText = lines.length ? lines.join('\n') : 'Sem horários disponíveis nos próximos 14 dias.';
  }

  const persMap = {
    profissional: 'Seja objetivo, cordial e direto. Foco em agendamentos rápidos.',
    descontraido: 'Use linguagem casual, emojis moderados. Seja amigável e descontraído.',
    premium:      'Use linguagem refinada. Transmita sofisticação e atenção aos detalhes.',
    direto:       'Respostas curtíssimas. Apenas o essencial — sem papo.',
  };
  const persText = persMap[personality] || persMap.profissional;
  const svcText  = services.map(s =>
    `• ${s.name} — R$ ${parseFloat(s.price).toFixed(2)} (${s.duration_min} min)${s.description ? ': ' + s.description : ''}`
  ).join('\n');

  return `Você é a IA da barbearia "Mister das Navalhas", Jurujuba/Niterói-RJ. Barbeiro: ${barberName}.
Estilo: ${persText}

## SERVIÇOS DISPONÍVEIS
${svcText}

## HORÁRIOS LIVRES (próximos 14 dias)
${availText}

## FLUXO DE AGENDAMENTO — siga esta ordem, uma etapa por vez:
1. Pergunte o nome do cliente
2. Pergunte qual serviço deseja
3. Mostre os dias e horários livres acima e pergunte qual prefere
4. Confirme: "Você quer agendar [serviço] no dia [data] às [horário], certo?"
5. Após confirmação, pergunte se prefere pagar o *sinal de R$10,00* ou o *valor completo* adiantado

## REGRAS OBRIGATÓRIAS
- SEMPRE escreva uma mensagem de texto para o cliente — NUNCA responda apenas com o token
- Responda de forma curta (é WhatsApp/chat)
- Use SOMENTE datas e horários da lista acima — nunca invente disponibilidade
- Nunca invente serviços ou preços fora da lista
- Se o cliente preferir agendar pelo site: ${siteUrl}
- O sinal é sempre R$10,00 independente do serviço
- Só emita o token após o cliente confirmar TODOS os dados
- Ao confirmar, escreva a mensagem de confirmação ao cliente E na linha seguinte o token:
AGENDAMENTO_SOLICITADO:{"client_name":"NOME","service":"SERVIÇO","appt_date":"YYYY-MM-DD","time_slot":"HH:MM","payment":"sinal"}
(payment = "sinal" ou "completo")`;
}

// ── TRANSCRIÇÃO DE ÁUDIO (Voxtral via Mistral) ────────────────────────────
async function transcribeAudio(audioBase64, mimeType) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY não configurada');
  mimeType = mimeType || 'audio/ogg';
  const buffer = Buffer.from(audioBase64, 'base64');
  const ext = mimeType.split('/')[1]?.split(';')[0] || 'ogg';
  const form = new FormData();
  form.append('model', 'voxtral-mini-2507');
  form.append('file', buffer, { filename: `audio.${ext}`, contentType: mimeType });
  const res = await axios.post(
    'https://api.mistral.ai/v1/audio/transcriptions',
    form,
    { headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() }, maxBodyLength: Infinity }
  );
  return res.data.text;
}

async function callMistral(messages, personality) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY não configurada no servidor.');
  const systemPrompt = await buildSystemPrompt(personality || 'profissional');
  const body = JSON.stringify({
    model:       process.env.MISTRAL_MODEL || 'mistral-small-latest',
    messages:    [
      { role: 'system', content: systemPrompt },
      ...messages
          .filter(m => m.content && m.content.trim())
          .map(m => ({ role: m.role, content: m.content })),
    ],
    temperature: 0.7,
    max_tokens:  512,
  });

  // Retry com backoff exponencial para erros 429 (rate limit)
  const MAX_RETRIES = 4;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    if (r.status === 429) {
      const retryAfter = parseInt(r.headers.get('retry-after') || '0') * 1000;
      const waitMs = retryAfter || (attempt * 5000); // 5s, 10s, 15s, 20s
      console.warn(`Mistral 429 — aguardando ${waitMs}ms (tentativa ${attempt}/${MAX_RETRIES})`);
      if (attempt === MAX_RETRIES) { const t = await r.text(); throw new Error('Mistral: ' + t); }
      await delay(waitMs);
      continue;
    }
    if (!r.ok) { const t = await r.text(); throw new Error('Mistral: ' + t); }
    const d = await r.json();
    return d.choices[0].message.content;
  }
}

// ── WHATSAPP-WEB.JS CLIENT ─────────────────────────────────────────────────
let waClient = null;
let waStatus = 'disconnected'; // disconnected | qr | connecting | connected
let waQrData = null;           // base64 data URL da imagem do QR

let waInitAttempts = 0;
const WA_MAX_ATTEMPTS = 3;

// ── WA MESSAGE QUEUE ──────────────────────────────────────────────────────
let waActivePhone     = null;
let waQueue           = [];
const waPending       = new Map(); // phone → [{phone,senderName,textMsg,msgObj}]
let waInactivityTimer = null;
const WA_INACTIVITY_MS = 60_000;

function randBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function enqueueWA(phone, senderName, textMsg, msgObj) {
  if (!waPending.has(phone)) waPending.set(phone, []);
  waPending.get(phone).push({ phone, senderName, textMsg, msgObj });

  if (waActivePhone === phone) {
    resetWAInactivityTimer();
    processNextWAMessage(phone);
    return;
  }

  if (waActivePhone === null) {
    startWAServing(phone);
    return;
  }

  if (!waQueue.includes(phone)) {
    waQueue.push(phone);
    console.log(`📥 [${phone}] aguardando na fila — posição ${waQueue.length}`);
  } else {
    console.log(`📥 [${phone}] nova msg acumulada (já na fila)`);
  }
}

function startWAServing(phone) {
  waActivePhone = phone;
  console.log(`▶️  Iniciando atendimento [${phone}]`);
  resetWAInactivityTimer();
  processNextWAMessage(phone);
}

function resetWAInactivityTimer() {
  if (waInactivityTimer) clearTimeout(waInactivityTimer);
  waInactivityTimer = setTimeout(() => {
    console.log(`⏱️  Timeout de inatividade [${waActivePhone}] — avançando fila`);
    advanceWAQueue();
  }, WA_INACTIVITY_MS);
}

function advanceWAQueue() {
  if (waInactivityTimer) { clearTimeout(waInactivityTimer); waInactivityTimer = null; }
  waActivePhone = null;
  if (waQueue.length === 0) {
    console.log('✅ Fila WA vazia — aguardando novos clientes');
    return;
  }
  const next = waQueue.shift();
  console.log(`⏭️  Próximo da fila: [${next}] (restam ${waQueue.length})`);
  startWAServing(next);
}

function processNextWAMessage(phone) {
  if (waActivePhone !== phone) return;
  const items = waPending.get(phone);
  if (!items || items.length === 0) return;

  const item = items.shift();
  if (items.length === 0) waPending.delete(phone);

  runWAMessageItem(item)
    .then(() => {
      if (waPending.has(phone) && waActivePhone === phone)
        setTimeout(() => processNextWAMessage(phone), randBetween(500, 1200));
    })
    .catch(err => {
      console.error(`❌ Erro WA [${phone}]:`, err.stack || err.message || err);
      if (waPending.has(phone) && waActivePhone === phone)
        setTimeout(() => processNextWAMessage(phone), randBetween(500, 1200));
    });
}

async function runWAMessageItem({ phone, senderName, textMsg, msgObj }) {
  await delay(randBetween(800, 2000));
  await processWAMessage(phone, senderName, textMsg, msgObj);
}

async function waTypingAndSend(phone, text, msgObj) {
  const ms = Math.min(randBetween(text.length * 40, text.length * 60), 7000);
  // Resolve o chat uma única vez — usa msgObj.getChat() quando disponível
  // para evitar getChatById que falha em contas com LID
  let chat = null;
  if (msgObj) {
    try { chat = await msgObj.getChat(); } catch {}
  }
  try { if (chat) await chat.sendStateTyping(); } catch {}
  await delay(ms);
  try { if (chat) await chat.clearState(); } catch {}
  await delay(randBetween(150, 350));
  // Envia pelo chat resolvido se possível; senão cai no waSend normal (Z-API)
  if (chat && waClient && waStatus === 'connected') {
    await chat.sendMessage(text);
  } else {
    await waSend(phone, text);
  }
}

function initWAClient() {
  if (waInitAttempts >= WA_MAX_ATTEMPTS) {
    console.warn(`⚠️ WhatsApp: máximo de ${WA_MAX_ATTEMPTS} tentativas atingido. Use o botão no painel para reconectar.`);
    waStatus = 'disconnected';
    return;
  }
  waInitAttempts++;

  if (waClient) {
    try { waClient.destroy().catch(() => {}); } catch (_) {}
    waClient = null;
  }
  waStatus = 'connecting';
  waQrData = null;

  waClient = new WAClient({
    authStrategy: new LocalAuth({ clientId: 'mdn-bot', dataPath: path.join(__dirname, '.wwebjs_auth') }),
    puppeteer: {
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-extensions',
        '--window-size=1920,1080',
      ],
    },
  });

  waClient.on('qr', async (qr) => {
    waStatus = 'qr';
    waQrData = await QRCode.toDataURL(qr).catch(() => null);
    console.log('📱 QR Code gerado — aguardando leitura.');
  });

  waClient.on('authenticated', () => {
    waStatus = 'connecting';
    waQrData = null;
    console.log('✅ WhatsApp autenticado.');
  });

  waClient.on('ready', () => {
    waStatus = 'connected';
    waQrData = null;
    console.log('✅ WhatsApp conectado e pronto.');
  });

  waClient.on('disconnected', (reason) => {
    waStatus = 'disconnected';
    waQrData = null;
    waClient = null;
    // Limpa fila ao desconectar
    waQueue = [];
    waPending.clear();
    waActivePhone = null;
    if (waInactivityTimer) { clearTimeout(waInactivityTimer); waInactivityTimer = null; }
    console.log('⚠️ WhatsApp desconectado:', reason);
  });

  waClient.on('message', async (msg) => {
    try {
      if (!waClient || waStatus !== 'connected') return;
      if (msg.fromMe) return;
      if (msg.from.endsWith('@g.us') || msg.from.endsWith('@broadcast')) return;

      const iaAtiva = await getIaConfig('ia_ativa');
      if (iaAtiva !== 'true') return;

      const phone = msg.from.replace('@c.us', '').replace(/\D/g, '');
      if (!phone) return;
      const isAudio = msg.type === 'ptt' || msg.type === 'audio';
      const textMsg = msg.body || '';
      if (!isAudio && !textMsg.trim()) return;
      const senderName = msg._data?.notifyName || phone;

      console.log(`📩 [${phone}] tipo=${msg.type} "${textMsg.substring(0, 50)}"`);
      enqueueWA(phone, senderName, textMsg, msg);
    } catch (e) { console.error('WA message handler:', e.stack || e.message || e); }
  });

  waClient.initialize().catch(e => {
    waStatus = 'disconnected';
    console.error('Erro ao inicializar WA client:', e.message);
  });
}

async function waSend(phone, message) {
  // Tenta whatsapp-web.js primeiro
  if (waClient && waStatus === 'connected') {
    const cleanPhone = phone.replace('@c.us', '').replace(/\D/g, '');
    let chatId = `${cleanPhone}@c.us`;
    // Usa chat.sendMessage() em vez de client.sendMessage() — evita erro "No LID for user"
    // getChatById abre ou recupera o chat existente que já tem o LID resolvido
    const chat = await waClient.getChatById(chatId);
    await chat.sendMessage(message);
    return;
  }
  // Fallback: Z-API (se configurado)
  const [inst, tok, ctok] = await Promise.all([
    getIaConfig('zapi_instance'), getIaConfig('zapi_token'), getIaConfig('zapi_client_token'),
  ]);
  if (inst && tok) {
    const r = await fetch(`https://api.z-api.io/instances/${inst}/token/${tok}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': ctok || '' },
      body: JSON.stringify({ phone, message }),
    });
    if (!r.ok) { const t = await r.text(); throw new Error('Z-API: ' + t); }
    return;
  }
  throw new Error('WhatsApp não conectado. Leia o QR Code em IA → Conexão WhatsApp.');
}

// Lógica compartilhada de processamento de mensagem WA (usada por ww.js e pelo webhook Z-API)
// msgObj: objeto Message do whatsapp-web.js (opcional) — usado para typing indicator e áudio
async function processWAMessage(phone, senderName, textMsg, msgObj) {
  // ── Transcrição de áudio ────────────────────────────────────────────────
  const isAudio = msgObj && (msgObj.type === 'ptt' || msgObj.type === 'audio');
  let clientText = textMsg;

  if (isAudio) {
    let chat = null;
    try { chat = await msgObj.getChat(); } catch {}
    try { if (chat) await chat.sendStateTyping(); } catch {}
    try {
      await waTypingAndSend(phone, '🎧 Um segundo, ouvindo seu áudio...', msgObj);
      const media = await msgObj.downloadMedia();
      clientText = await transcribeAudio(media.data, media.mimetype || 'audio/ogg');
      await waTypingAndSend(phone, `_Entendi: "${clientText}"_`, msgObj);
    } catch (audioErr) {
      console.error(`[${phone}] Transcrição erro:`, audioErr.message);
      await waTypingAndSend(phone, 'Não consegui ouvir o áudio 😕 Pode digitar sua mensagem?', msgObj);
      return;
    }
  }

  if (!clientText?.trim()) { console.warn(`[${phone}] clientText vazio — ignorado`); return; }

  const { rows } = await pool.query(`SELECT * FROM ia_conversations WHERE phone=$1`, [phone]);
  let conv = rows[0];
  if (!conv) {
    await pool.query(
      `INSERT INTO ia_conversations (phone,name,history,takeover,last_message,last_at,unread)
       VALUES ($1,$2,'[]',FALSE,$3,$4,1)`,
      [phone, senderName, clientText, nowStr()]
    );
    const { rows: r } = await pool.query(`SELECT * FROM ia_conversations WHERE phone=$1`, [phone]);
    conv = r[0];
  }

  if (conv.takeover) {
    console.log(`[${phone}] takeover ativo — salvando msg sem responder`);
    const history = typeof conv.history === 'string' ? JSON.parse(conv.history) : conv.history;
    history.push({ role: 'user', content: clientText });
    await pool.query(
      `UPDATE ia_conversations SET history=$1, last_message=$2, last_at=$3, unread=unread+1 WHERE phone=$4`,
      [JSON.stringify(history), clientText, nowStr(), phone]
    );
    return;
  }

  const history = typeof conv.history === 'string' ? JSON.parse(conv.history) : conv.history;
  history.push({ role: 'user', content: clientText });

  // Mostra "digitando..." enquanto chama a IA — só usa msgObj.getChat() para evitar LID error
  let chat = null;
  if (msgObj) {
    try { chat = await msgObj.getChat(); } catch (e) { console.warn(`[${phone}] getChat falhou:`, e.message); }
  }
  console.log(`[${phone}] chat resolvido: ${chat ? 'sim' : 'não'} — chamando Mistral`);
  try { if (chat) await chat.sendStateTyping(); } catch {}

  const pers  = await getIaConfig('personality') || 'profissional';
  const raw   = await callMistral(history.slice(-20), pers);
  console.log(`[${phone}] Mistral respondeu (${raw.length} chars)`);

  try { if (chat) await chat.clearState(); } catch {}

  const clean = raw.replace(/AGENDAMENTO_SOLICITADO:\s*\{[\s\S]*?\}/, '').trim();
  if (!clean) {
    console.warn(`[${phone}] IA retornou resposta vazia — raw: ${raw.slice(0, 100)}`);
    return;
  }
  history.push({ role: 'assistant', content: clean });

  console.log(`[${phone}] Enviando: "${clean.substring(0, 60)}..."`);
  // Envia com delay simulando digitação (proporcional ao tamanho da resposta)
  await waTypingAndSend(phone, clean, msgObj);

  await pool.query(
    `UPDATE ia_conversations SET history=$1, last_message=$2, last_at=$3, name=$4, unread=0 WHERE phone=$5`,
    [JSON.stringify(history), clean, nowStr(), senderName, phone]
  );

  // Auto-book — cria o agendamento no sistema quando IA confirma
  const apptMatch = raw.match(/AGENDAMENTO_SOLICITADO:\s*(\{[\s\S]*?\})/);
  if (apptMatch) {
    const autoBook = await getIaConfig('auto_book');
    if (autoBook !== 'true') {
      console.log(`[${phone}] Auto-book desabilitado — token ignorado`);
    } else {
      try {
        const apptData = JSON.parse(apptMatch[1]);
        console.log(`[${phone}] Auto-book:`, apptData);
        const { rows: brs } = await pool.query(`SELECT id FROM barbers WHERE active=TRUE LIMIT 1`);
        // busca serviço por correspondência parcial, case-insensitive
        const { rows: srs } = await pool.query(
          `SELECT id, name FROM services WHERE active=TRUE AND name ILIKE $1 LIMIT 1`,
          [`%${apptData.service || ''}%`]
        );
        if (!brs.length) console.warn(`[${phone}] Auto-book: nenhum barbeiro ativo`);
        else if (!srs.length) console.warn(`[${phone}] Auto-book: serviço não encontrado: "${apptData.service}"`);
        else {
          const apptId = uuid();
          const clientName = apptData.client_name || senderName;
          const paymentType = apptData.payment || 'sinal'; // 'sinal' ou 'completo'

          // status inicial: pending_payment até o MP confirmar
          await pool.query(
            `INSERT INTO appointments (id,barber_id,service_id,client_name,client_phone,appt_date,time_slot,status,source,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_payment','whatsapp',$8)
             ON CONFLICT DO NOTHING`,
            [apptId, brs[0].id, srs[0].id, clientName, phone, apptData.appt_date, apptData.time_slot, nowStr()]
          );
          console.log(`[${phone}] Agendamento criado (pending_payment): ${apptData.appt_date} ${apptData.time_slot} — ${srs[0].name}`);

          // Gera link de pagamento Mercado Pago
          try {
            const { rows: svcRows } = await pool.query(`SELECT price FROM services WHERE id=$1`, [srs[0].id]);
            const svcPrice = parseFloat(svcRows[0]?.price || 0);
            const amount = paymentType === 'completo' ? svcPrice : 10.00;
            const itemTitle = paymentType === 'completo'
              ? `${srs[0].name} — ${apptData.appt_date} ${apptData.time_slot}`
              : `Sinal de Agendamento — ${srs[0].name} — ${apptData.appt_date} ${apptData.time_slot}`;

            const siteUrl = process.env.SITE_URL || 'https://mister-das-navalhas-production.up.railway.app';
            const pref = await mpFetch('/checkout/preferences', {
              method: 'POST',
              body: {
                items: [{ title: itemTitle, quantity: 1, unit_price: amount, currency_id: 'BRL' }],
                external_reference: apptId,
                back_urls: {
                  success: `${siteUrl}/?payment=success&appt=${apptId}`,
                  failure: `${siteUrl}/?payment=failure&appt=${apptId}`,
                  pending: `${siteUrl}/?payment=pending&appt=${apptId}`,
                },
                auto_return: 'approved',
                statement_descriptor: 'MISTER DAS NAVALHAS',
              },
            });

            const payLink = pref.init_point;
            const label = paymentType === 'completo' ? `valor completo (R$${svcPrice.toFixed(2)})` : 'sinal (R$10,00)';
            await waTypingAndSend(phone,
              `💳 Para confirmar seu horário, realize o pagamento do ${label} pelo link abaixo:\n\n${payLink}\n\nAssim que o pagamento for confirmado, seu agendamento estará reservado! ✅`,
              msgObj
            );
          } catch (payErr) {
            console.warn(`[${phone}] Erro ao gerar link de pagamento:`, payErr.message);
            // Se falhar o pagamento, pelo menos avança o status
            await pool.query(`UPDATE appointments SET status='confirmed' WHERE id=$1`, [apptId]);
          }
        }
      } catch (e) { console.warn(`[${phone}] Auto-book erro:`, e.message, '| raw:', raw.slice(-200)); }
    }
  }
}

// ── IA: CONFIG ────────────────────────────────────────────────────────────
app.get('/api/ia/config', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT key, value FROM ia_config`);
    const cfg = {};
    rows.forEach(r => { cfg[r.key] = r.value; });
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ia/config', async (req, res) => {
  try {
    const allowed = ['ia_ativa','personality','welcome_msg','auto_book','fora_horario',
                     'reativacao','reativ_days','confirma_agend','confirma_dia',
                     'zapi_instance','zapi_token','zapi_client_token'];
    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k)) await setIaConfig(k, v);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── IA: TEST ──────────────────────────────────────────────────────────────
app.post('/api/ia/test', async (req, res) => {
  try {
    const { message, history = [], personality } = req.body;
    if (!message) return res.status(400).json({ error: 'message obrigatório' });
    const pers = personality || await getIaConfig('personality') || 'profissional';
    const hist = [...history, { role: 'user', content: message }];
    const raw  = await callMistral(hist, pers);
    const clean = raw.replace(/AGENDAMENTO_SOLICITADO:\{.*?\}/s, '').trim();
    hist.push({ role: 'assistant', content: clean });
    res.json({ response: clean, history: hist });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── IA: WHATSAPP CONVERSATIONS ────────────────────────────────────────────
app.get('/api/ia/conversations', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM ia_conversations ORDER BY last_at DESC NULLS LAST LIMIT 100`);
    res.json(rows.map(r => ({ ...r, history: typeof r.history==='string'?JSON.parse(r.history):r.history })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ia/conversations/:phone/takeover', async (req, res) => {
  try {
    await pool.query(`UPDATE ia_conversations SET takeover=TRUE, unread=0 WHERE phone=$1`, [req.params.phone]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ia/conversations/:phone/release', async (req, res) => {
  try {
    await pool.query(`UPDATE ia_conversations SET takeover=FALSE WHERE phone=$1`, [req.params.phone]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ia/send', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone e message obrigatórios' });
    await waSend(phone, message);
    const { rows } = await pool.query(`SELECT history FROM ia_conversations WHERE phone=$1`, [phone]);
    const history = typeof rows[0]?.history==='string' ? JSON.parse(rows[0].history) : (rows[0]?.history || []);
    history.push({ role: 'assistant', content: message, manual: true });
    await pool.query(
      `UPDATE ia_conversations SET history=$1, last_message=$2, last_at=$3 WHERE phone=$4`,
      [JSON.stringify(history), message, nowStr(), phone]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WHATSAPP STATUS + QR ──────────────────────────────────────────────────
app.get('/api/wa/status', (req, res) => {
  res.json({ status: waStatus, qr: waQrData });
});

app.post('/api/wa/connect', (req, res) => {
  waInitAttempts = 0; // reset ao conectar manualmente
  initWAClient();
  res.json({ ok: true, status: waStatus });
});

app.post('/api/wa/disconnect', async (req, res) => {
  try {
    if (waClient) await waClient.logout().catch(() => {});
    waStatus = 'disconnected'; waQrData = null; waClient = null;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WEBHOOK: Z-API fallback (WhatsApp incoming via Z-API) ─────────────────
app.post('/api/webhook/zapi', async (req, res) => {
  res.json({ ok: true });
  try {
    const body = req.body;
    if (body.fromMe || body.isGroup) return;
    const textMsg = body.text?.message || body.body || '';
    if (!textMsg) return;
    const phone = body.phone;
    const senderName = body.senderName || phone;
    const iaAtiva = await getIaConfig('ia_ativa');
    if (iaAtiva !== 'true') return;
    await processWAMessage(phone, senderName, textMsg);
  } catch (e) { console.error('Webhook Z-API:', e.message); }
});

// ── LIVECHAT ──────────────────────────────────────────────────────────────
app.post('/api/livechat/start', async (req, res) => {
  try {
    const { name, phone } = req.body;
    const id  = uuid();
    const now = nowStr();
    await pool.query(
      `INSERT INTO livechat_sessions (id,name,phone,started_at,last_at,status,takeover,unread)
       VALUES ($1,$2,$3,$4,$4,'active',FALSE,0)`,
      [id, name || 'Visitante', phone || null, now]
    );
    const welcomeMsg = await getIaConfig('welcome_msg') || 'Olá! Bem-vindo à Mister das Navalhas 🪒 Como posso ajudar?';
    await pool.query(
      `INSERT INTO livechat_messages (id,session_id,role,content,created_at) VALUES ($1,$2,'assistant',$3,$4)`,
      [uuid(), id, welcomeMsg, now]
    );
    res.json({ session_id: id, welcome: welcomeMsg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/livechat/message', async (req, res) => {
  try {
    const { session_id, content } = req.body;
    if (!session_id || !content) return res.status(400).json({ error: 'session_id e content obrigatórios' });
    const { rows: sess } = await pool.query(`SELECT * FROM livechat_sessions WHERE id=$1`, [session_id]);
    if (!sess.length) return res.status(404).json({ error: 'Sessão não encontrada' });
    const session = sess[0];

    await pool.query(
      `INSERT INTO livechat_messages (id,session_id,role,content,created_at) VALUES ($1,$2,'user',$3,$4)`,
      [uuid(), session_id, content, nowStr()]
    );

    if (session.takeover) {
      await pool.query(`UPDATE livechat_sessions SET last_at=$1, unread=unread+1 WHERE id=$2`, [nowStr(), session_id]);
      return res.json({ pending: true });
    }

    const { rows: msgs } = await pool.query(
      `SELECT role, content FROM livechat_messages WHERE session_id=$1 ORDER BY created_at ASC`,
      [session_id]
    );
    const history = msgs.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

    const pers  = await getIaConfig('personality') || 'profissional';
    const raw   = await callMistral(history.slice(-20), pers);
    const clean = raw.replace(/AGENDAMENTO_SOLICITADO:\{.*?\}/s, '').trim();

    const respId = uuid();
    await pool.query(
      `INSERT INTO livechat_messages (id,session_id,role,content,created_at) VALUES ($1,$2,'assistant',$3,$4)`,
      [respId, session_id, clean, nowStr()]
    );
    await pool.query(`UPDATE livechat_sessions SET last_at=$1 WHERE id=$2`, [nowStr(), session_id]);

    res.json({ message: clean, message_id: respId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/livechat/sessions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, (SELECT content FROM livechat_messages WHERE session_id=s.id ORDER BY created_at DESC LIMIT 1) AS last_message
       FROM livechat_sessions s WHERE s.status='active' ORDER BY s.last_at DESC NULLS LAST`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/livechat/:sessionId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, role, content, created_at FROM livechat_messages WHERE session_id=$1 ORDER BY created_at ASC`,
      [req.params.sessionId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/livechat/:sessionId/takeover', async (req, res) => {
  try {
    await pool.query(`UPDATE livechat_sessions SET takeover=TRUE, unread=0 WHERE id=$1`, [req.params.sessionId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/livechat/:sessionId/release', async (req, res) => {
  try {
    await pool.query(`UPDATE livechat_sessions SET takeover=FALSE WHERE id=$1`, [req.params.sessionId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/livechat/:sessionId/send', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content obrigatório' });
    const msgId = uuid();
    await pool.query(
      `INSERT INTO livechat_messages (id,session_id,role,content,created_at) VALUES ($1,$2,'assistant',$3,$4)`,
      [msgId, req.params.sessionId, content, nowStr()]
    );
    await pool.query(`UPDATE livechat_sessions SET last_at=$1, takeover=TRUE WHERE id=$2`, [nowStr(), req.params.sessionId]);
    res.json({ ok: true, message_id: msgId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/livechat/:sessionId/close', async (req, res) => {
  try {
    await pool.query(`UPDATE livechat_sessions SET status='closed' WHERE id=$1`, [req.params.sessionId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN LOGIN ───────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) return res.status(500).json({ error: 'Senha não configurada no servidor.' });
  if (password === adminPass) return res.json({ ok: true });
  res.status(401).json({ error: 'Senha incorreta.' });
});

// ── CRON DIÁRIO ───────────────────────────────────────────────────────────
// Roda a cada 10 minutos; usa last_daily_run para executar 1x por dia às 8h UTC
async function runDailyCron() {
  try {
    const now   = new Date();
    const hour  = now.getUTCHours();
    const today = now.toISOString().slice(0, 10);
    if (hour < 8 || hour >= 9) return; // só entre 08:00–09:00 UTC

    const lastRun = await getIaConfig('last_daily_run').catch(() => null);
    if (lastRun === today) return;
    await setIaConfig('last_daily_run', today);
    console.log(`⏰ Cron diário — ${today}`);

    // ── Lembrete no dia do agendamento ───────────────────────────────────
    const confirmaDia = await getIaConfig('confirma_dia');
    if (confirmaDia === 'true') {
      const { rows: appts } = await pool.query(
        `SELECT a.client_name, a.client_phone, a.time_slot, s.name AS service_name
         FROM appointments a JOIN services s ON a.service_id=s.id
         WHERE a.appt_date=$1 AND a.status='confirmed' AND a.client_phone IS NOT NULL`,
        [today]
      );
      for (const a of appts) {
        try {
          await waSend(a.client_phone,
            `🔔 Lembrete: seu agendamento na Mister das Navalhas é *hoje* às *${a.time_slot}*!\n💈 ${a.service_name}\n\nAté logo! ✂️`
          );
          await delay(2000);
        } catch (e) { console.warn('Lembrete dia:', e.message); }
      }
      console.log(`📅 Lembretes enviados: ${appts.length}`);
    }

    // ── Reativação de clientes inativos ──────────────────────────────────
    const reativAtiva = await getIaConfig('reativacao');
    if (reativAtiva === 'true') {
      const reativDays = parseInt(await getIaConfig('reativ_days') || '30');
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - reativDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const siteUrl = process.env.SITE_URL || '';

      const { rows: clients } = await pool.query(
        `SELECT client_name, client_phone, MAX(appt_date) AS last_visit
         FROM appointments
         WHERE status='confirmed' AND client_phone IS NOT NULL
         GROUP BY client_name, client_phone
         HAVING MAX(appt_date) < $1`,
        [cutoffStr]
      );
      for (const c of clients) {
        try {
          await waSend(c.client_phone,
            `Olá, ${c.client_name}! 💈 Sentimos sua falta na Mister das Navalhas!\nQue tal agendar um horário? ${siteUrl}`
          );
          await delay(2500);
        } catch (e) { console.warn('Reativação:', e.message); }
      }
      console.log(`🔄 Reativações enviadas: ${clients.length}`);
    }
  } catch (e) {
    console.error('Cron diário erro:', e.message);
  }
}

// ── PAGES ─────────────────────────────────────────────────────────────────
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/',      (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── START ─────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () =>
    console.log(`🔪 Mister das Navalhas rodando em http://localhost:${PORT}`)
  );
  // Inicializa o WhatsApp client automaticamente
  initWAClient();
  // Cron diário: verifica a cada 10 minutos
  setInterval(runDailyCron, 10 * 60 * 1000);
}).catch(err => {
  console.error('❌ Erro ao iniciar banco:', err);
  process.exit(1);
});
