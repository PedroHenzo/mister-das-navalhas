const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const initSqlJs = require('sql.js');

const app  = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db', 'barbearia.db');

// ── HELPERS ───────────────────────────────────────────────────────────────
function uuid() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}
function nowStr() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function parseSlots(row) {
  if (!row) return null;
  try { row.time_slots = JSON.parse(row.time_slots); } catch { row.time_slots = []; }
  return row;
}
function boolify(row) {
  if (!row) return null;
  if ('active' in row) row.active = row.active === 1;
  return row;
}
function toRows(result) {
  if (!result || result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}
function toRow(result) { return toRows(result)[0] || null; }

// ── DATABASE INIT ─────────────────────────────────────────────────────────
let db;

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS barbers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      duration_min INTEGER NOT NULL DEFAULT 30, price REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY, barber_id TEXT NOT NULL, service_id TEXT NOT NULL,
      client_name TEXT NOT NULL, client_phone TEXT NOT NULL, client_email TEXT,
      appt_date TEXT NOT NULL, time_slot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', source TEXT NOT NULL DEFAULT 'online',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS barber_availability (
      id TEXT PRIMARY KEY, barber_id TEXT NOT NULL, avail_date TEXT NOT NULL,
      time_slots TEXT NOT NULL DEFAULT '[]', UNIQUE(barber_id, avail_date)
    );
  `);

  const count = toRow(db.exec('SELECT COUNT(*) as c FROM barbers'));
  if (!count || count.c === 0) {
    db.run(`INSERT INTO barbers (id,name,active,created_at) VALUES (?,?,1,?)`,
      ['barber-01','Wesley',nowStr()]);
    [
      ['Corte Clássico','Tesoura, pente e acabamento.',30,45],
      ['Corte + Barba','Pacote completo com navalha.',60,75],
      ['Barba Completa','Modelagem com toalha quente.',30,40],
      ['Degradê','Fade do mais baixo ao alto.',45,55],
    ].forEach(([n,d,dur,p]) =>
      db.run(`INSERT INTO services (id,name,description,duration_min,price,active,created_at) VALUES (?,?,?,?,?,1,?)`,
        [uuid(),n,d,dur,p,nowStr()])
    );
    persist();
    console.log('✅ Banco de dados inicializado com dados padrão.');
  }
}

function persist() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API ───────────────────────────────────────────────────────────────────

app.get('/api/barbers', (req, res) => {
  res.json(toRows(db.exec('SELECT * FROM barbers WHERE active = 1')).map(boolify));
});

app.get('/api/services', (req, res) => {
  const where = req.query.active === 'true' ? 'WHERE active = 1' : '';
  res.json(toRows(db.exec(`SELECT * FROM services ${where} ORDER BY price`)).map(boolify));
});

app.post('/api/services', (req, res) => {
  const { name, description, duration_min, price, active = true } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'name e price obrigatórios' });
  const id = uuid();
  db.run(
    `INSERT INTO services (id,name,description,duration_min,price,active,created_at) VALUES (?,?,?,?,?,?,?)`,
    [id, name, description||'', duration_min||30, price, active?1:0, nowStr()]
  );
  persist();
  res.status(201).json(boolify(toRow(db.exec('SELECT * FROM services WHERE id=?',[id]))));
});

app.patch('/api/services/:id', (req, res) => {
  const { id } = req.params;
  const { name, description, duration_min, price, active } = req.body;
  const fields=[], vals=[];
  if (name!==undefined)         { fields.push('name=?');         vals.push(name); }
  if (description!==undefined)  { fields.push('description=?');  vals.push(description); }
  if (duration_min!==undefined) { fields.push('duration_min=?'); vals.push(duration_min); }
  if (price!==undefined)        { fields.push('price=?');        vals.push(price); }
  if (active!==undefined)       { fields.push('active=?');       vals.push(active?1:0); }
  if (!fields.length) return res.status(400).json({ error: 'Nada para atualizar' });
  vals.push(id);
  db.run(`UPDATE services SET ${fields.join(',')} WHERE id=?`, vals);
  persist();
  res.json(boolify(toRow(db.exec('SELECT * FROM services WHERE id=?',[id]))));
});

app.delete('/api/services/:id', (req, res) => {
  db.run('DELETE FROM services WHERE id=?',[req.params.id]);
  persist();
  res.json({ success: true });
});

app.get('/api/appointments', (req, res) => {
  let q='SELECT * FROM appointments WHERE 1=1'; const p=[];
  if (req.query.barber_id)  { q+=' AND barber_id=?';  p.push(req.query.barber_id); }
  if (req.query.appt_date)  { q+=' AND appt_date=?';  p.push(req.query.appt_date); }
  if (req.query.status)     { q+=' AND status=?';     p.push(req.query.status); }
  if (req.query.status_neq) { q+=' AND status!=?';    p.push(req.query.status_neq); }
  q+=' ORDER BY appt_date ASC, time_slot ASC';
  res.json(toRows(db.exec(q,p)));
});

app.post('/api/appointments', (req, res) => {
  const { barber_id,service_id,client_name,client_phone,client_email,
          appt_date,time_slot,status='pending',source='online' } = req.body;
  if (!barber_id||!service_id||!client_name||!client_phone||!appt_date||!time_slot)
    return res.status(400).json({ error: 'Campos obrigatórios faltando' });
  const id=uuid();
  db.run(
    `INSERT INTO appointments (id,barber_id,service_id,client_name,client_phone,client_email,appt_date,time_slot,status,source,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id,barber_id,service_id,client_name,client_phone,client_email||null,appt_date,time_slot,status,source,nowStr()]
  );
  persist();
  res.status(201).json(toRow(db.exec('SELECT * FROM appointments WHERE id=?',[id])));
});

app.patch('/api/appointments/:id', (req, res) => {
  const { id }=req.params, { status }=req.body;
  if (!status) return res.status(400).json({ error: 'status obrigatório' });
  db.run('UPDATE appointments SET status=? WHERE id=?',[status,id]);
  persist();
  res.json(toRow(db.exec('SELECT * FROM appointments WHERE id=?',[id])));
});

app.get('/api/barber_availability', (req, res) => {
  let q='SELECT * FROM barber_availability WHERE 1=1'; const p=[];
  if (req.query.barber_id)  { q+=' AND barber_id=?';   p.push(req.query.barber_id); }
  if (req.query.avail_date) { q+=' AND avail_date=?';  p.push(req.query.avail_date); }
  if (req.query.gte)        { q+=' AND avail_date>=?'; p.push(req.query.gte); }
  if (req.query.lt)         { q+=' AND avail_date<?';  p.push(req.query.lt); }
  res.json(toRows(db.exec(q,p)).map(parseSlots));
});

app.post('/api/barber_availability', (req, res) => {
  const { barber_id,avail_date,time_slots }=req.body;
  if (!barber_id||!avail_date) return res.status(400).json({ error: 'barber_id e avail_date obrigatórios' });
  const slotsJson=JSON.stringify(Array.isArray(time_slots)?time_slots:[]);
  const existing=toRow(db.exec('SELECT id FROM barber_availability WHERE barber_id=? AND avail_date=?',[barber_id,avail_date]));
  if (existing) {
    db.run('UPDATE barber_availability SET time_slots=? WHERE barber_id=? AND avail_date=?',[slotsJson,barber_id,avail_date]);
  } else {
    db.run('INSERT INTO barber_availability (id,barber_id,avail_date,time_slots) VALUES (?,?,?,?)',[uuid(),barber_id,avail_date,slotsJson]);
  }
  persist();
  res.json(parseSlots(toRow(db.exec('SELECT * FROM barber_availability WHERE barber_id=? AND avail_date=?',[barber_id,avail_date]))));
});

// ── PAGES ─────────────────────────────────────────────────────────────────
app.get('/admin', (_,res) => res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/',      (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));

// ── START ─────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => console.log(`🔪 Mister das Navalhas em http://localhost:${PORT}`));
}).catch(err => { console.error('Erro ao iniciar banco:', err); process.exit(1); });
