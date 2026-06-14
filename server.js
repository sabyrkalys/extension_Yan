// server.js — v2.2.0 (targets sync)
const WebSocket = require('ws');
const Database  = require('better-sqlite3');
const path      = require('path');
const fs        = require('fs');
const http      = require('http');
const crypto    = require('crypto');

// Директория для медиафайлов
const MEDIA_DIR = path.join(__dirname, 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const args = process.argv.slice(2);
if (args[0] === '--issue' || args[0] === '--revoke' || args[0] === '--list') {
  const db = new Database(path.join(__dirname, 'data.db'));
  db.pragma('journal_mode = WAL');
  ensureTokenTable(db);
  if (args[0] === '--issue') {
    const username = args[1], role = args[2] || null, officeId = args[3] || 'HQ';
    if (!username) { console.error('node server.js --issue <username> [role] [officeId]'); process.exit(1); }
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO tokens (token,username,role,office_id,active,issued_at) VALUES (?,?,?,?,1,datetime('now'))`).run(token,username,role,officeId);
    console.log(`\n✅ Токен выдан для "${username}" [${role||'роль не задана'}] подразделение: ${officeId}`);
    console.log(`🔑 Токен: ${token}\n`);
  } else if (args[0] === '--revoke') {
    const token = args[1];
    if (!token) { console.error('node server.js --revoke <token>'); process.exit(1); }
    const r = db.prepare(`UPDATE tokens SET active=0 WHERE token=?`).run(token);
    console.log(r.changes > 0 ? '✅ Токен отозван' : '⚠️  Не найден');
  } else if (args[0] === '--list') {
    const rows = db.prepare(`SELECT token,username,role,office_id,active,issued_at FROM tokens ORDER BY issued_at DESC`).all();
    if (!rows.length) { console.log('Токенов нет'); process.exit(0); }
    rows.forEach(r => {
      console.log(`${r.active?'✅':'❌'} | ${r.username} | ${r.role||'—'} | ${r.office_id} | ${r.issued_at}`);
      console.log(`         ${r.token}\n`);
    });
  }
  process.exit(0);
}

function generateToken() { return crypto.randomBytes(32).toString('hex'); }

const OFFICES = {
  'HQ':  { name:'КМП',         short:'КМП', isHQ:true,  roles:['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'] },
  '177': { name:'177 огвпмп',  short:'177', isHQ:false, roles:['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'] },
  '61':  { name:'61 огвбрмп',  short:'61',  isHQ:false, roles:['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'] },
  '114': { name:'114 омсбр',   short:'114', isHQ:false, roles:['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'] },
  '1':   { name:'1 омсбр',     short:'1',   isHQ:false, roles:['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'] },
  '9':   { name:'9 омсбр',     short:'9',   isHQ:false, roles:['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'] },
};
const VALID_ROLES = ['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'];

function canAssignTask(from, to) {
  if (!from || !to) return true;
  if (from === to) return true;
  if (OFFICES[from]?.isHQ) return true;
  return false;
}

function getOnlineByOffice() {
  const result = {};
  for (const [,c] of clients) {
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    const oid = c.officeId || 'HQ';
    if (!result[oid]) result[oid] = [];
    if (!result[oid].includes(c.role)) result[oid].push(c.role);
  }
  return result;
}

// ── HTTP сервер ──────────────────────────────────────────────────────
const EXTENSION_DIR = path.join(__dirname, 'extension');
const ALLOWED_FILES = ['manifest.json','content.js','background.js','inject.js','version.json','astra_extension.zip'];
const MIME_TYPES = { '.js':'application/javascript', '.json':'application/json', '.png':'image/png', '.zip':'application/zip' };

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlPath = req.url.split('?')[0];

  // ── Загрузка медиафайла ────────────────────────────────────────────────
if (req.method === 'POST' && urlPath === '/media/upload') {
    const MAX_SIZE = 100 * 1024 * 1024;
    let body = '';
    let totalSize = 0;
    let tooLarge = false;

    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize > MAX_SIZE) { tooLarge = true; req.destroy(); return; }
      body += chunk.toString();
    });

    req.on('end', () => {
      if (tooLarge) {
        res.writeHead(413); res.end(JSON.stringify({ error: 'Файл превышает 100 МБ' })); return;
      }
      try {
        const { entityId, mediaType, fileName, mimeType, base64Data } = JSON.parse(body);
        if (!entityId || !mediaType || !base64Data) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'Не хватает полей' })); return;
        }

        const fileBuffer = Buffer.from(base64Data, 'base64');
        const origExt    = path.extname(fileName || '').toLowerCase() || (mediaType === 'photo' ? '.jpg' : '.mp4');
        const safeName   = `${entityId}_${mediaType}_${Date.now()}${origExt}`;
        const destPath   = path.join(MEDIA_DIR, safeName);

        fs.writeFileSync(destPath, fileBuffer);
        log(`📁 Медиа сохранено: ${safeName} (${(fileBuffer.length / 1024).toFixed(0)} КБ)`);

        // Пишем в target_media
        db.prepare(`INSERT INTO target_media (entity_id, media_type, file_name, file_size)
          VALUES (?, ?, ?, ?)`).run(String(entityId), mediaType, safeName, fileBuffer.length);

        // Обновляем флаги в targets
        try {
          if (mediaType === 'photo') {
            db.prepare(`UPDATE targets SET has_photo=1, updated_at=datetime('now') WHERE entity_id=?`).run(String(entityId));
          } else {
            db.prepare(`UPDATE targets SET has_video=1, updated_at=datetime('now') WHERE entity_id=?`).run(String(entityId));
          }
        } catch {}

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, fileName: safeName }));

      } catch (err) {
        log(`❌ /media/upload: ${err.message}`);
        res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
      }
    });

    req.on('error', () => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
    return;
  }
if (req.method === 'GET' && urlPath === '/media/list') {
    const entityId = new URL('http://x' + req.url).searchParams.get('entityId');
    if (!entityId) { res.writeHead(400); res.end(JSON.stringify({ error: 'entityId required' })); return; }
    const rows = db.prepare(`SELECT * FROM target_media WHERE entity_id=? ORDER BY created_at ASC`).all(String(entityId));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, media: rows }));
    return;
  }

  if (req.method === 'POST' && urlPath === '/media/delete') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const row = db.prepare(`SELECT * FROM target_media WHERE id=?`).get(id);
        if (!row) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
        const filePath = path.join(MEDIA_DIR, row.file_name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        db.prepare(`DELETE FROM target_media WHERE id=?`).run(id);
        const remaining = db.prepare(`SELECT media_type FROM target_media WHERE entity_id=?`).all(row.entity_id);
        const hasPhoto = remaining.some(r => r.media_type === 'photo') ? 1 : 0;
        const hasVideo = remaining.some(r => r.media_type === 'video') ? 1 : 0;
        try { db.prepare(`UPDATE targets SET has_photo=?,has_video=?,updated_at=datetime('now') WHERE entity_id=?`).run(hasPhoto, hasVideo, row.entity_id); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
    });
    return;
  }

  if (req.method === 'GET' && urlPath === '/targets/info') {
    const entityId = new URL('http://x' + req.url).searchParams.get('entityId');
    if (!entityId) { res.writeHead(400); res.end(JSON.stringify({ error: 'entityId required' })); return; }
    const row = db.prepare(
      `SELECT description, notes FROM targets WHERE entity_id=?`
    ).get(String(entityId));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, description: row?.description || '', notes: row?.notes || '' }));
    return;
  }
  if (req.method === 'GET' && urlPath === '/media/counts') {
    const raw = new URL('http://x' + req.url).searchParams.get('entityIds');
    if (!raw) { res.writeHead(400); res.end('{}'); return; }
    const ids    = raw.split(',').filter(Boolean);
    const counts = {};
    for (const id of ids) {
      const rows = db.prepare(
        `SELECT media_type, COUNT(*) as cnt FROM target_media WHERE entity_id=? GROUP BY media_type`
      ).all(id);
      counts[id] = { photo: 0, video: 0 };
      for (const r of rows) {
        if (r.media_type === 'photo') counts[id].photo = r.cnt;
        else if (r.media_type === 'video') counts[id].video = r.cnt;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, counts }));
    return;
  }
  // ── Отдача медиафайла ──────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath.startsWith('/media/')) {
    const fileName = path.basename(urlPath);
    const filePath = path.join(MEDIA_DIR, fileName);
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(fileName).toLowerCase();
    const mime = { '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                   '.mp4':  'video/mp4',  '.mov':  'video/quicktime', '.avi': 'video/x-msvideo',
                   '.webm': 'video/webm' }[ext] || 'application/octet-stream';
    const stat = fs.statSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // ── Раздача файлов расширения ──────────────────────────────────────────
  const fileName = path.basename(urlPath);
  if (!ALLOWED_FILES.includes(fileName)) { res.writeHead(404); res.end('Not found'); return; }
  const filePath = fileName === 'astra_extension.zip' ? path.join(__dirname, fileName) : path.join(EXTENSION_DIR, fileName);
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('File not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(fileName)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});
httpServer.listen(5001, () => log('📦 HTTP сервер запущен на порту 5001'));

// ── Парсер multipart/form-data (без npm-зависимостей) ──────────────────────
function parseMultipart(body, boundary) {
  const fields = {};
  const files  = {};
  const sep    = Buffer.from('--' + boundary);
  const parts  = splitBuffer(body, sep);

  for (const part of parts) {
    if (!part || part.length < 4) continue;
    // Ищем разделитель заголовков и тела \r\n\r\n
    const headerEnd = indexOfSequence(part, Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) continue;
    const headerStr = part.slice(0, headerEnd).toString('utf8');
    const bodyPart  = part.slice(headerEnd + 4);
    // Убираем финальный \r\n
    const data = bodyPart.slice(0, bodyPart.length - 2);

    const dispMatch  = headerStr.match(/Content-Disposition:[^\r\n]*name="([^"]+)"/i);
    const fileMatch  = headerStr.match(/filename="([^"]+)"/i);
    if (!dispMatch) continue;
    const fieldName = dispMatch[1];

    if (fileMatch) {
      files[fieldName] = { filename: fileMatch[1], data };
    } else {
      fields[fieldName] = data.toString('utf8');
    }
  }
  return { fields, files };
}

function splitBuffer(buf, sep) {
  const parts = [];
  let start = 0;
  while (true) {
    const idx = indexOfSequence(buf, sep, start);
    if (idx === -1) break;
    parts.push(buf.slice(start, idx));
    start = idx + sep.length;
    // Пропускаем \r\n после boundary
    if (buf[start] === 0x0d && buf[start+1] === 0x0a) start += 2;
    // Конец: -- после boundary
    if (buf[start] === 0x2d && buf[start+1] === 0x2d) break;
  }
  return parts.filter(p => p.length > 0);
}

function indexOfSequence(buf, seq, offset = 0) {
  for (let i = offset; i <= buf.length - seq.length; i++) {
    let found = true;
    for (let j = 0; j < seq.length; j++) {
      if (buf[i+j] !== seq[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

// ── База данных ──────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function ensureTokenTable(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY, username TEXT NOT NULL, role TEXT,
    office_id TEXT DEFAULT 'HQ', active INTEGER DEFAULT 1,
    issued_at TEXT DEFAULT (datetime('now')), last_used TEXT
  );`);
}
ensureTokenTable(db);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astra_id TEXT UNIQUE, role TEXT NOT NULL,
    display_name TEXT, token_hint TEXT, office_id TEXT DEFAULT 'HQ',
    last_seen TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_role TEXT NOT NULL, to_role TEXT NOT NULL,
    from_office TEXT DEFAULT 'HQ', to_office TEXT DEFAULT 'HQ',
    target_id TEXT, target_title TEXT DEFAULT '',
    text TEXT NOT NULL, status TEXT DEFAULT 'новая',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT, updated_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_to_status ON tasks(to_role, status);

  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL, target_data TEXT NOT NULL,
    plan_date TEXT NOT NULL, created_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    published INTEGER DEFAULT 0, published_at TEXT DEFAULT NULL,
    note TEXT DEFAULT '',
    UNIQUE (target_id, plan_date)
  );
  CREATE INDEX IF NOT EXISTS idx_plans_date      ON plans(plan_date);
  CREATE INDEX IF NOT EXISTS idx_plans_published ON plans(plan_date, published);

  CREATE TABLE IF NOT EXISTS targets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id       TEXT    UNIQUE NOT NULL,
    folder_date     TEXT    NOT NULL,

    -- Из AstraMap (перезаписываются при синке)
    title           TEXT    DEFAULT '',
    target_type     TEXT    DEFAULT '',
    coord_lon       REAL,
    coord_lat       REAL,
    coord_x         INTEGER,
    coord_y         INTEGER,
    result          TEXT    DEFAULT '',
    detected_at     TEXT    DEFAULT '',
    source          TEXT    DEFAULT '',
    description     TEXT    DEFAULT '',
    confidence      TEXT    DEFAULT '',
    relevance       TEXT    DEFAULT '',
    priority        TEXT    DEFAULT '',
    is_mobile       INTEGER DEFAULT 0,
    author          TEXT    DEFAULT '',
    has_media       INTEGER DEFAULT 0,
    astra_synced_at TEXT,

    -- Только SQLite (не трогаем при синке)
    address         TEXT    DEFAULT '',
    has_photo       INTEGER DEFAULT 0,
    has_video       INTEGER DEFAULT 0,
    defeat_date     TEXT    DEFAULT '',
    notes           TEXT    DEFAULT '',

    created_at      TEXT    DEFAULT (datetime('now')),
    updated_at      TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS target_media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id  TEXT NOT NULL,
  media_type TEXT NOT NULL,
  file_name  TEXT NOT NULL,
  file_size  INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
  CREATE INDEX IF NOT EXISTS idx_target_media_entity ON target_media(entity_id);
  CREATE INDEX IF NOT EXISTS idx_targets_date   ON targets(folder_date);
  CREATE INDEX IF NOT EXISTS idx_targets_entity ON targets(entity_id);

`);

// Безопасные миграции для существующих БД
['ALTER TABLE tasks ADD COLUMN from_office TEXT DEFAULT \'HQ\'',
 'ALTER TABLE tasks ADD COLUMN to_office   TEXT DEFAULT \'HQ\'',
 'ALTER TABLE users ADD COLUMN office_id   TEXT DEFAULT \'HQ\'',
].forEach(sql => { try { db.exec(sql); } catch {} });

// ── Prepared statements ──────────────────────────────────────────────
const stmt = {
  getToken:   db.prepare(`SELECT * FROM tokens WHERE token=? AND active=1`),
  touchToken: db.prepare(`UPDATE tokens SET last_used=datetime('now') WHERE token=?`),

  upsertUser: db.prepare(`
    INSERT INTO users (astra_id,role,display_name,token_hint,office_id,last_seen)
    VALUES (@astra_id,@role,@display_name,@token_hint,@office_id,datetime('now'))
    ON CONFLICT(astra_id) DO UPDATE SET
      role=excluded.role, display_name=excluded.display_name,
      token_hint=excluded.token_hint, office_id=excluded.office_id,
      last_seen=datetime('now')
  `),
  getRoleByAstraId: db.prepare(`SELECT role,display_name,office_id FROM users WHERE astra_id=?`),

  insertTask: db.prepare(`
    INSERT INTO tasks (from_role,to_role,from_office,to_office,target_id,target_title,text,status)
    VALUES (@from_role,@to_role,@from_office,@to_office,@target_id,@target_title,@text,'новая')
  `),
  updateTaskStatus: db.prepare(`
    UPDATE tasks SET status=@status, updated_at=datetime('now'), updated_by=@updated_by WHERE id=@id
  `),
  getTask:         db.prepare(`SELECT * FROM tasks WHERE id=?`),
  getPendingTasks: db.prepare(`SELECT * FROM tasks WHERE to_role=? AND status='новая' ORDER BY created_at DESC`),
  getRecentTasks:  db.prepare(`SELECT * FROM tasks WHERE from_role=? OR to_role=? ORDER BY created_at DESC LIMIT 100`),

  insertPlan: db.prepare(`
    INSERT OR IGNORE INTO plans (target_id,target_data,plan_date,created_by,note)
    VALUES (@target_id,@target_data,@plan_date,@created_by,@note)
  `),
  getPlansForDate:     db.prepare(`SELECT * FROM plans WHERE plan_date=? ORDER BY created_at DESC`),
  deletePlan:          db.prepare(`DELETE FROM plans WHERE id=?`),
  getPlanById:         db.prepare(`SELECT * FROM plans WHERE id=?`),
  getUnpublishedPlans: db.prepare(`SELECT * FROM plans WHERE plan_date=? AND published=0 ORDER BY created_at ASC`),
  markPlanPublished:   db.prepare(`UPDATE plans SET published=1, published_at=datetime('now') WHERE id=?`),
  getPlansByDate:      db.prepare(`SELECT * FROM plans WHERE plan_date=? ORDER BY created_at ASC`),

  // ── Targets ──────────────────────────────────────────────────────────
  upsertTarget: db.prepare(`
    INSERT INTO targets (
      entity_id, folder_date, title, target_type,
      coord_lon, coord_lat, coord_x, coord_y,
      result, detected_at, source, description,
      confidence, relevance, priority, is_mobile,
      author, has_media, astra_synced_at
    ) VALUES (
      @entity_id, @folder_date, @title, @target_type,
      @coord_lon, @coord_lat, @coord_x, @coord_y,
      @result, @detected_at, @source, @description,
      @confidence, @relevance, @priority, @is_mobile,
      @author, @has_media, datetime('now')
    )
    ON CONFLICT(entity_id) DO UPDATE SET
      folder_date     = excluded.folder_date,
      title           = excluded.title,
      target_type     = excluded.target_type,
      coord_lon       = excluded.coord_lon,
      coord_lat       = excluded.coord_lat,
      coord_x         = excluded.coord_x,
      coord_y         = excluded.coord_y,
      result          = excluded.result,
      detected_at     = excluded.detected_at,
      source          = excluded.source,
      description     = excluded.description,
      confidence      = excluded.confidence,
      relevance       = excluded.relevance,
      priority        = excluded.priority,
      is_mobile       = excluded.is_mobile,
      has_media       = excluded.has_media,
      astra_synced_at = datetime('now'),
      updated_at      = datetime('now')
  `),

  // Таблица с джойном задач — для расширения
  getTargetsByDate: db.prepare(`
    SELECT
      t.*,
      tk.id        AS task_id,
      tk.to_role   AS task_to_role,
      tk.to_office AS task_to_office,
      tk.from_role AS task_from_role,
      tk.status    AS task_status,
      tk.text      AS task_text
    FROM targets t
    LEFT JOIN tasks tk
      ON tk.target_id = t.entity_id
      AND tk.status NOT IN ('уничтожена','отклонена')
      AND tk.id = (
        SELECT MAX(id) FROM tasks WHERE target_id = t.entity_id
        AND status NOT IN ('уничтожена','отклонена')
      )
    WHERE t.folder_date = ?
    ORDER BY t.detected_at DESC
  `),

  getTargetByEntityId: db.prepare(`SELECT * FROM targets WHERE entity_id=?`),

  updateTargetLocal: db.prepare(`
    UPDATE targets SET
      address     = COALESCE(@address,     address),
      has_photo   = COALESCE(@has_photo,   has_photo),
      has_video   = COALESCE(@has_video,   has_video),
      defeat_date = COALESCE(@defeat_date, defeat_date),
      notes       = COALESCE(@notes,       notes),
      updated_at  = datetime('now')
    WHERE entity_id = @entity_id
  `),
};

// ── WebSocket ────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ port: 5000 });
const clients = new Map();

function log(msg) { console.log(`[${new Date().toLocaleTimeString('ru-RU')}] ${msg}`); }
function normalizeTask(t) { return { ...t, from: t.from_role||t.from||'', to: t.to_role||t.to||'' }; }

function sendToOfficeRole(role, officeId, data) {
  let sent = false;
  for (const [,c] of clients) {
    if (c.role === role && c.officeId === officeId && c.ws.readyState === WebSocket.OPEN) {
      try { c.ws.send(JSON.stringify(data)); sent = true; } catch {}
    }
  }
  if (!sent) {
    for (const [,c] of clients) {
      if (c.role === role && c.ws.readyState === WebSocket.OPEN) {
        try { c.ws.send(JSON.stringify(data)); sent = true; } catch {}
      }
    }
  }
  return sent;
}

function broadcastAll(data) {
  for (const [,c] of clients) {
    if (c.ws.readyState === WebSocket.OPEN) { try { c.ws.send(JSON.stringify(data)); } catch {} }
  }
}

function getOnlineRoles() {
  const r = new Set();
  for (const [,c] of clients) if (c.ws.readyState === WebSocket.OPEN) r.add(c.role);
  return [...r];
}

wss.on('connection', (ws, req) => {
  let myRole = null, myAstraId = null, myName = null, myOfficeId = 'HQ', authenticated = false;

  const authTimeout = setTimeout(() => {
    if (!authenticated) { log('⏱️  Таймаут авторизации'); ws.close(4001,'Auth timeout'); }
  }, 30_000);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { ws.send(JSON.stringify({ type:'ERROR', text:'Неверный JSON' })); return; }

    if (msg.type === 'PING') { ws.send(JSON.stringify({ type:'PONG' })); return; }

    if (msg.type === 'REGISTER') {
      clearTimeout(authTimeout);
      const token = (msg.token || '').trim();
      const userId = msg.userId?.toString() || null;
      const username = (msg.username || '').trim();
      const displayName = (msg.displayName || username || 'Неизвестно').trim();

      if (!token) {
        ws.send(JSON.stringify({ type:'AUTH_ERROR', text:'Токен обязателен' }));
        ws.close(4003,'No token'); return;
      }
      const tokenRow = stmt.getToken.get(token);
      if (!tokenRow) {
        log(`🚫 Недействительный токен: ${username}`);
        ws.send(JSON.stringify({ type:'AUTH_ERROR', text:'Недействительный или отозванный токен' }));
        ws.close(4003,'Invalid token'); return;
      }
      stmt.touchToken.run(token);

      let resolvedRole = tokenRow.role || null;
      if (!resolvedRole && userId) { const c = stmt.getRoleByAstraId.get(userId); if (c) resolvedRole = c.role; }
      if (!resolvedRole) resolvedRole = (msg.role || '').toLowerCase().trim() || null;

      if (!resolvedRole || !VALID_ROLES.includes(resolvedRole)) {
        ws.send(JSON.stringify({ type:'NEED_ROLE', text:'Выберите расчёт', validRoles:VALID_ROLES })); return;
      }

      const dbUser = stmt.getRoleByAstraId.get(userId || username);
      myOfficeId = (dbUser?.office_id && OFFICES[dbUser.office_id]) ? dbUser.office_id
        : (tokenRow.office_id && OFFICES[tokenRow.office_id]) ? tokenRow.office_id
        : (msg.officeId && OFFICES[msg.officeId]) ? msg.officeId : 'HQ';

      stmt.upsertUser.run({ astra_id:userId||username, role:resolvedRole, display_name:displayName, token_hint:token.slice(0,8), office_id:myOfficeId });

      myRole = resolvedRole; myAstraId = userId||username; myName = displayName; authenticated = true;
      clients.set(myAstraId, { ws, role:myRole, astraId:myAstraId, displayName:myName, officeId:myOfficeId });
      log(`✅ ${myName} [${myRole}·${myOfficeId}] подключён`);

      ws.send(JSON.stringify({ type:'REGISTERED', role:myRole, displayName:myName, officeId:myOfficeId, online:getOnlineByOffice() }));

      const pending = stmt.getPendingTasks.all(myRole);
      if (pending.length > 0) ws.send(JSON.stringify({ type:'PENDING_TASKS', tasks:pending.map(normalizeTask) }));
      ws.send(JSON.stringify({ type:'TASKS_HISTORY', tasks:stmt.getRecentTasks.all(myRole,myRole).map(normalizeTask) }));

      for (const [,client] of clients) {
        if (client.astraId === myAstraId) continue;
        if (client.ws.readyState === WebSocket.OPEN) {
          try { client.ws.send(JSON.stringify({ type:'USER_ONLINE', role:myRole, displayName:myName, officeId:myOfficeId, online:getOnlineByOffice() })); } catch {}
        }
      }
      return;
    }

    if (!authenticated || !myRole) { ws.send(JSON.stringify({ type:'AUTH_ERROR', text:'Сначала REGISTER' })); return; }

    switch (msg.type) {

      case 'NEW_TASK': {
        const toRole = (msg.to || '').toLowerCase().trim();
        if (!VALID_ROLES.includes(toRole)) { ws.send(JSON.stringify({ type:'ERROR', text:`Неизвестный расчёт: ${toRole}` })); return; }
        const toOfficeId = msg.toOfficeId || myOfficeId;
        if (!canAssignTask(myOfficeId, toOfficeId)) { ws.send(JSON.stringify({ type:'ERROR', text:'Нет прав' })); return; }
        if (!msg.text?.trim()) { ws.send(JSON.stringify({ type:'ERROR', text:'Текст обязателен' })); return; }
        const info = stmt.insertTask.run({ from_role:myRole, to_role:toRole, from_office:myOfficeId||'HQ', to_office:toOfficeId||'HQ', target_id:msg.targetId||null, target_title:msg.targetTitle||'', text:msg.text.trim() });
        const task = stmt.getTask.get(info.lastInsertRowid);
        const nTask = normalizeTask(task);
        log(`📋 Задача #${task.id}: ${myRole}[${myOfficeId}] → ${toRole}[${toOfficeId}]`);
        ws.send(JSON.stringify({ type:'TASK_SENT', task:nTask }));
        const delivered = sendToOfficeRole(toRole, toOfficeId, { type:'NEW_TASK', task:nTask });
        log(`   Доставлено: ${delivered ? 'да' : 'офлайн'}`);
        for (const [,c] of clients) {
          if (c.astraId === myAstraId || (c.role === toRole && c.officeId === toOfficeId)) continue;
          if (c.ws.readyState === WebSocket.OPEN) { try { c.ws.send(JSON.stringify({ type:'TASK_UPDATE', task:nTask })); } catch {} }
        }
        break;
      }

      case 'UPDATE_TASK': {
        const VALID_STATUSES = ['новая','принята','в работе','выполнена','отклонена','поражена','не поражена','доразведка','подтверждено','подавлено','перенесена','уничтожена'];
        if (!VALID_STATUSES.includes(msg.status)) { ws.send(JSON.stringify({ type:'ERROR', text:`Неверный статус: ${msg.status}` })); return; }
        stmt.updateTaskStatus.run({ id:msg.taskId, status:msg.status, updated_by:myRole });
        if (msg.status === 'перенесена' && msg.rescheduleDate) {
          db.prepare(`UPDATE tasks SET text=text||' [перенесена на '||?||']' WHERE id=?`).run(msg.rescheduleDate, msg.taskId);
        }
        const task = stmt.getTask.get(msg.taskId);
        if (!task) { ws.send(JSON.stringify({ type:'ERROR', text:'Задача не найдена' })); return; }
        log(`🔄 Задача #${task.id} → ${task.status}`);
        broadcastAll({ type:'TASK_UPDATED', task:normalizeTask(task) });
        break;
      }

      case 'UPDATE':
        for (const [,c] of clients) {
          if (c.astraId === myAstraId) continue;
          if (c.ws.readyState === WebSocket.OPEN) { try { c.ws.send(JSON.stringify({ type:'UPDATE', from:myRole, displayName:myName })); } catch {} }
        }
        break;

      case 'CREATE_PLAN': {
        if (!msg.planDate || !msg.targetId) { ws.send(JSON.stringify({ type:'ERROR', text:'planDate и targetId обязательны' })); return; }
        const info = stmt.insertPlan.run({ target_id:String(msg.targetId), target_data:JSON.stringify(msg.targetData||{}), plan_date:msg.planDate, created_by:myRole, note:msg.note||'' });
        if (info.changes === 0) { ws.send(JSON.stringify({ type:'ERROR', text:`Цель уже запланирована на ${msg.planDate}` })); return; }
        const plan = stmt.getPlanById.get(info.lastInsertRowid);
        log(`📅 План #${plan.id}: ${myRole} → ${plan.plan_date}`);
        broadcastAll({ type:'PLAN_CREATED', plan });
        break;
      }

      case 'GET_PLANS': {
        if (!msg.planDate) return;
        ws.send(JSON.stringify({ type:'PLANS_FOR_DATE', planDate:msg.planDate, plans:stmt.getPlansForDate.all(msg.planDate).filter(p=>!p.published) }));
        break;
      }

      case 'DELETE_PLAN':
        stmt.deletePlan.run(msg.planId);
        broadcastAll({ type:'PLAN_DELETED', planId:msg.planId });
        break;

      case 'GET_DRAFT_CHECK': {
        if (!msg.planDate) return;
        const plans = stmt.getUnpublishedPlans.all(msg.planDate);
        if (plans.length > 0) ws.send(JSON.stringify({ type:'DRAFT_EXISTS', planDate:msg.planDate, count:plans.length }));
        break;
      }

      case 'GET_DRAFT_PLANS': {
        if (!msg.planDate) return;
        ws.send(JSON.stringify({ type:'DRAFT_PLANS', planDate:msg.planDate, plans:stmt.getPlansByDate.all(msg.planDate) }));
        break;
      }

      case 'MARK_PUBLISHED': {
        if (!msg.planId) return;
        stmt.markPlanPublished.run(msg.planId);
        broadcastAll({ type:'PLAN_PUBLISHED', plan:stmt.getPlanById.get(msg.planId) });
        break;
      }

      // ── НОВЫЕ: синк целей ─────────────────────────────────────────────

      case 'SYNC_TARGETS': {
        const { date, entities } = msg;
        if (!date || !Array.isArray(entities) || entities.length === 0) break;

        db.transaction((rows) => {
          for (const e of rows) {
            stmt.upsertTarget.run({
              entity_id:   String(e.entity_id),
              folder_date: date,
              title:       e.title        || '',
              target_type: e.target_type  || '',
              coord_lon:   e.coord_lon    ?? null,
              coord_lat:   e.coord_lat    ?? null,
              coord_x:     e.coord_x      ?? null,
              coord_y:     e.coord_y      ?? null,
              result:      e.result       || '',
              detected_at: e.detected_at  || '',
              source:      e.source       || '',
              description: e.description  || '',
              confidence:  e.confidence   || '',
              relevance:   e.relevance    || '',
              priority:    e.priority     || '',
              is_mobile:   e.is_mobile    ? 1 : 0,
              author:      e.author       || '',
              has_media:   e.has_media    ? 1 : 0,
            });
          }
        })(entities);

        log(`🔄 SYNC_TARGETS: ${entities.length} целей за ${date} от ${myRole}[${myOfficeId}]`);
        const rows = stmt.getTargetsByDate.all(date);
        // Возвращаем объединённые данные только запросившему — у него уже есть AstraMap данные
        ws.send(JSON.stringify({ type:'TARGETS_SYNCED', date, rows }));
        break;
      }

      case 'GET_TARGETS': {
        const { date } = msg;
        if (!date) break;
        const rows = stmt.getTargetsByDate.all(date);
        ws.send(JSON.stringify({ type:'TARGETS_LIST', date, rows }));
        break;
      }

      case 'UPDATE_TARGET_LOCAL': {
        const { entity_id } = msg;
        if (!entity_id) break;
        stmt.updateTargetLocal.run({
          entity_id,
          address:     msg.address     !== undefined ? msg.address     : null,
          has_photo:   msg.has_photo   !== undefined ? msg.has_photo   : null,
          has_video:   msg.has_video   !== undefined ? msg.has_video   : null,
          defeat_date: msg.defeat_date !== undefined ? msg.defeat_date : null,
          notes:       msg.notes       !== undefined ? msg.notes       : null,
        });
        const updated = stmt.getTargetByEntityId.get(entity_id);
        log(`✏️  UPDATE_TARGET_LOCAL: цель ${entity_id} от ${myRole}[${myOfficeId}]`);
        broadcastAll({ type:'TARGET_UPDATED', target:updated });
        break;
      }

      default:
        log(`⚠️  Неизвестный тип: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (myAstraId) {
      clients.delete(myAstraId);
      log(`🔴 ${myName||myRole} отключился`);
      for (const [,c] of clients) {
        if (c.ws.readyState === WebSocket.OPEN) {
          try { c.ws.send(JSON.stringify({ type:'USER_OFFLINE', role:myRole, online:getOnlineRoles() })); } catch {}
        }
      }
    }
  });

  ws.on('error', (err) => log(`❌ WS ошибка (${myName||'незарег.'}): ${err.message}`));
});

log(`🟢 WS-сервер запущен на порту 5000`);
log(`   БД: ${path.join(__dirname, 'data.db')}`);
log(`   Управление токенами: node server.js --issue <username> [role] [officeId]`);