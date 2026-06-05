// server.js
// Запуск: node server.js
// Зависимости: npm install ws better-sqlite3
//
// Управление токенами (CLI):
//   node server.js --issue <username> [<role>] [<officeId>]   — выдать токен
//   node server.js --revoke <token>                           — отозвать токен
//   node server.js --list                                     — список токенов

const WebSocket = require('ws');
const Database  = require('better-sqlite3');
const path      = require('path');
const fs        = require('fs');
const http      = require('http');
const crypto    = require('crypto');

// ─────────────────────────────────────────────────────────────────
// CLI-режим — управление токенами без запуска сервера
// ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args[0] === '--issue' || args[0] === '--revoke' || args[0] === '--list') {
  const db = new Database(path.join(__dirname, 'data.db'));
  db.pragma('journal_mode = WAL');
  ensureTokenTable(db);

  if (args[0] === '--issue') {
    const username = args[1];
    const role     = args[2] || null;
    const officeId = args[3] || 'HQ';
    if (!username) { console.error('Укажи username: node server.js --issue <username> [role] [officeId]'); process.exit(1); }
    const token = generateToken();
    db.prepare(`
      INSERT INTO tokens (token, username, role, office_id, active, issued_at)
      VALUES (?, ?, ?, ?, 1, datetime('now'))
    `).run(token, username, role, officeId);
    console.log(`\n✅ Токен выдан для "${username}" [${role || 'роль не задана'}] подразделение: ${officeId}`);
    console.log(`🔑 Токен: ${token}\n`);

  } else if (args[0] === '--revoke') {
    const token = args[1];
    if (!token) { console.error('Укажи токен: node server.js --revoke <token>'); process.exit(1); }
    const result = db.prepare(`UPDATE tokens SET active = 0 WHERE token = ?`).run(token);
    if (result.changes > 0) console.log(`✅ Токен отозван`);
    else console.log(`⚠️  Токен не найден`);

  } else if (args[0] === '--list') {
    const rows = db.prepare(`SELECT token, username, role, office_id, active, issued_at FROM tokens ORDER BY issued_at DESC`).all();
    if (!rows.length) { console.log('Токенов нет'); process.exit(0); }
    console.log('\nТокены:\n');
    rows.forEach(r => {
      const status = r.active ? '✅ активен' : '❌ отозван';
      console.log(`${status} | ${r.username} | ${r.role || '—'} | подразделение: ${r.office_id} | выдан: ${r.issued_at}`);
      console.log(`         ${r.token}\n`);
    });
  }
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────
// Генерация токена
// ─────────────────────────────────────────────────────────────────
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─────────────────────────────────────────────────────────────────
// ПОДРАЗДЕЛЕНИЯ
// ─────────────────────────────────────────────────────────────────
const OFFICES = {
  'HQ': {
    name:  'КМП',
    short: 'КМП',
    isHQ:  true,
    roles: ['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'],
  },
  '177': {
    name:  '177 огвпмп',
    short: '177',
    isHQ:  false,
    roles: ['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'],
  },
  '61': {
    name:  '61 огвбрмп',
    short: '61',
    isHQ:  false,
    roles: ['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'],
  },
  '114': {
    name:  '114 омсбр',
    short: '114',
    isHQ:  false,
    roles: ['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'],
  },
};

const VALID_ROLES = ['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'];

function canAssignTask(fromOffice, toOffice) {
  if (!fromOffice || !toOffice) return true;
  if (fromOffice === toOffice) return true;
  if (OFFICES[fromOffice]?.isHQ) return true;
  return false;
}

function getOnlineByOffice() {
  const result = {};
  for (const [, client] of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    const oid = client.officeId || 'HQ';
    if (!result[oid]) result[oid] = [];
    if (!result[oid].includes(client.role)) result[oid].push(client.role);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────
// HTTP СЕРВЕР — раздача файлов расширения (порт 5001)
// ─────────────────────────────────────────────────────────────────
const EXTENSION_DIR = path.join(__dirname, 'extension');
const HTTP_PORT     = 5001;

const ALLOWED_FILES = [
  'manifest.json','content.js','background.js',
  'inject.js','version.json','astra_extension.zip',
];
const MIME_TYPES = {
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.zip':  'application/zip',
};

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const url      = req.url.split('?')[0];
  const fileName = path.basename(url);

  if (!ALLOWED_FILES.includes(fileName)) { res.writeHead(404); res.end('Not found'); return; }

  const filePath = fileName === 'astra_extension.zip'
    ? path.join(__dirname, fileName)
    : path.join(EXTENSION_DIR, fileName);

  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('File not found'); return; }

  const mimeType = MIME_TYPES[path.extname(fileName)] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mimeType,
    'Content-Disposition': fileName === 'astra_extension.zip'
      ? 'attachment; filename="astra_extension.zip"'
      : 'inline',
  });
  fs.createReadStream(filePath).pipe(res);
});

httpServer.listen(HTTP_PORT, () => {
  log(`📦 HTTP сервер обновлений запущен на порту ${HTTP_PORT}`);
});

// ─────────────────────────────────────────────────────────────────
// БАЗА ДАННЫХ
// ─────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function ensureTokenTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      token      TEXT PRIMARY KEY,
      username   TEXT NOT NULL,
      role       TEXT,
      office_id  TEXT DEFAULT 'HQ',
      active     INTEGER DEFAULT 1,
      issued_at  TEXT DEFAULT (datetime('now')),
      last_used  TEXT
    );
  `);
}
ensureTokenTable(db);

db.exec(`
  CREATE TABLE IF NOT EXISTS plans (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id    TEXT    NOT NULL,
    target_data  TEXT    NOT NULL,
    plan_date    TEXT    NOT NULL,
    created_by   TEXT    NOT NULL,
    created_at   TEXT    DEFAULT (datetime('now')),
    published    INTEGER DEFAULT 0,
    published_at TEXT    DEFAULT NULL,
    note         TEXT    DEFAULT '',
    UNIQUE (target_id, plan_date)
  );
  CREATE INDEX IF NOT EXISTS idx_plans_date      ON plans(plan_date);
  CREATE INDEX IF NOT EXISTS idx_plans_published ON plans(plan_date, published);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    astra_id     TEXT    UNIQUE,
    role         TEXT    NOT NULL,
    display_name TEXT,
    token_hint   TEXT,
    last_seen    TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    from_role    TEXT    NOT NULL,
    to_role      TEXT    NOT NULL,
    target_id    TEXT,
    target_title TEXT    DEFAULT '',
    text         TEXT    NOT NULL,
    status       TEXT    DEFAULT 'новая',
    created_at   TEXT    DEFAULT (datetime('now')),
    updated_at   TEXT,
    updated_by   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_to_status ON tasks(to_role, status);
`);

// ─────────────────────────────────────────────────────────────────
// Подготовленные запросы
// ─────────────────────────────────────────────────────────────────
const stmt = {
  getToken:   db.prepare(`SELECT * FROM tokens WHERE token = ? AND active = 1`),
  touchToken: db.prepare(`UPDATE tokens SET last_used = datetime('now') WHERE token = ?`),

  upsertUser: db.prepare(`
    INSERT INTO users (astra_id, role, display_name, token_hint, last_seen)
    VALUES (@astra_id, @role, @display_name, @token_hint, datetime('now'))
    ON CONFLICT(astra_id) DO UPDATE SET
      role         = excluded.role,
      display_name = excluded.display_name,
      token_hint   = excluded.token_hint,
      last_seen    = datetime('now')
  `),
  getRoleByAstraId: db.prepare(`SELECT role, display_name, office_id FROM users WHERE astra_id = ?`),

  insertTask: db.prepare(`
    INSERT INTO tasks (from_role, to_role, from_office, to_office, target_id, target_title, text, status)
    VALUES (@from_role, @to_role, @from_office, @to_office, @target_id, @target_title, @text, 'новая')
  `),
  updateTaskStatus: db.prepare(`
    UPDATE tasks SET status = @status, updated_at = datetime('now'), updated_by = @updated_by
    WHERE id = @id
  `),
  getTask:         db.prepare(`SELECT * FROM tasks WHERE id = ?`),
  getPendingTasks: db.prepare(`
    SELECT * FROM tasks WHERE to_role = ? AND status = 'новая' ORDER BY created_at DESC
  `),
  getRecentTasks: db.prepare(`
    SELECT * FROM tasks WHERE from_role = ? OR to_role = ? ORDER BY created_at DESC LIMIT 100
  `),

  insertPlan: db.prepare(`
    INSERT OR IGNORE INTO plans (target_id, target_data, plan_date, created_by, note)
    VALUES (@target_id, @target_data, @plan_date, @created_by, @note)
  `),
  getPlansForDate:     db.prepare(`SELECT * FROM plans WHERE plan_date = ? ORDER BY created_at DESC`),
  deletePlan:          db.prepare(`DELETE FROM plans WHERE id = ?`),
  getPlanById:         db.prepare(`SELECT * FROM plans WHERE id = ?`),
  getUnpublishedPlans: db.prepare(`SELECT * FROM plans WHERE plan_date = ? AND published = 0 ORDER BY created_at ASC`),
  markPlanPublished:   db.prepare(`UPDATE plans SET published = 1, published_at = datetime('now') WHERE id = ?`),
  getPlansByDate:      db.prepare(`SELECT * FROM plans WHERE plan_date = ? ORDER BY created_at ASC`),
};

// ─────────────────────────────────────────────────────────────────
// WEBSOCKET СЕРВЕР
// ─────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ port: 5000 });
const clients = new Map();

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] ${msg}`);
}

function normalizeTask(task) {
  return { ...task, from: task.from_role || task.from || '', to: task.to_role || task.to || '' };
}

// Отправить всем клиентам с нужной ролью И подразделением
function sendToOfficeRole(role, officeId, data) {
  let sent = false;
  for (const [, client] of clients) {
    if (client.role === role && client.officeId === officeId && client.ws.readyState === WebSocket.OPEN) {
      try { client.ws.send(JSON.stringify(data)); sent = true; } catch {}
    }
  }
  // Если нет клиентов с нужным офисом — отправляем всем с нужной ролью (обратная совместимость)
  if (!sent) {
    for (const [, client] of clients) {
      if (client.role === role && client.ws.readyState === WebSocket.OPEN) {
        try { client.ws.send(JSON.stringify(data)); sent = true; } catch {}
      }
    }
  }
  return sent;
}

function broadcastAll(data) {
  for (const [, client] of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      try { client.ws.send(JSON.stringify(data)); } catch {}
    }
  }
}

function getOnlineRoles() {
  const roles = new Set();
  for (const [, client] of clients) {
    if (client.ws.readyState === WebSocket.OPEN) roles.add(client.role);
  }
  return [...roles];
}

// ─────────────────────────────────────────────────────────────────
// Обработка подключений
// ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  let myRole      = null;
  let myAstraId   = null;
  let myName      = null;
  let myOfficeId  = 'HQ';
  let authenticated = false;

  // Таймаут авторизации — 30 секунд (даём время на загрузку страницы)
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      log(`⏱️  Таймаут авторизации — клиент не прислал REGISTER`);
      ws.close(4001, 'Auth timeout');
    }
  }, 30_000);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      ws.send(JSON.stringify({ type: 'ERROR', text: 'Неверный JSON' }));
      return;
    }

    if (msg.type === 'PING') {
      ws.send(JSON.stringify({ type: 'PONG' }));
      return;
    }

    if (msg.type === 'REGISTER') {
      clearTimeout(authTimeout);

      const token       = (msg.token || '').trim();
      const userId      = msg.userId?.toString() || null;
      const username    = (msg.username    || '').trim();
      const displayName = (msg.displayName || username || 'Неизвестно').trim();

      if (!token) {
        log(`🚫 REGISTER без токена: ${username}`);
        ws.send(JSON.stringify({ type: 'AUTH_ERROR', text: 'Токен обязателен' }));
        ws.close(4003, 'No token');
        return;
      }

      const tokenRow = stmt.getToken.get(token);
      if (!tokenRow) {
        log(`🚫 Недействительный токен от: ${username} (${req.socket.remoteAddress})`);
        ws.send(JSON.stringify({ type: 'AUTH_ERROR', text: 'Недействительный или отозванный токен' }));
        ws.close(4003, 'Invalid token');
        return;
      }

      stmt.touchToken.run(token);

      // Роль: из токена → из БД → из сообщения
      let resolvedRole = tokenRow.role || null;
      if (!resolvedRole && userId) {
        const cached = stmt.getRoleByAstraId.get(userId);
        if (cached) resolvedRole = cached.role;
      }
      if (!resolvedRole) resolvedRole = (msg.role || '').toLowerCase().trim() || null;

      if (!resolvedRole || !VALID_ROLES.includes(resolvedRole)) {
        ws.send(JSON.stringify({ type: 'NEED_ROLE', text: 'Выберите расчёт', validRoles: VALID_ROLES }));
        return;
      }

      // Офис: из БД пользователя (приоритет) → из токена → из сообщения → HQ
      const dbUser = stmt.getRoleByAstraId.get(userId || username);
      myOfficeId = (dbUser?.office_id && OFFICES[dbUser.office_id])
        ? dbUser.office_id
        : (tokenRow.office_id && OFFICES[tokenRow.office_id])
          ? tokenRow.office_id
          : (msg.officeId && OFFICES[msg.officeId] ? msg.officeId : 'HQ');

      stmt.upsertUser.run({
        astra_id:     userId || username,
        role:         resolvedRole,
        display_name: displayName,
        token_hint:   token.slice(0, 8),
      });

      myRole    = resolvedRole;
      myAstraId = userId || username;
      myName    = displayName;
      authenticated = true;

      clients.set(myAstraId, { ws, role: myRole, astraId: myAstraId, displayName: myName, officeId: myOfficeId });
      log(`✅ ${myName} [${myRole}·${myOfficeId}] подключён (токен: ${token.slice(0,8)}...)`);

      ws.send(JSON.stringify({
        type:        'REGISTERED',
        role:        myRole,
        displayName: myName,
        officeId:    myOfficeId,
        online:      getOnlineByOffice(),
      }));

      const pending = stmt.getPendingTasks.all(myRole);
      if (pending.length > 0) {
        ws.send(JSON.stringify({ type: 'PENDING_TASKS', tasks: pending.map(normalizeTask) }));
      }
      const history = stmt.getRecentTasks.all(myRole, myRole);
      ws.send(JSON.stringify({ type: 'TASKS_HISTORY', tasks: history.map(normalizeTask) }));

      // Уведомляем всех об онлайне
      for (const [, client] of clients) {
        if (client.astraId === myAstraId) continue;
        if (client.ws.readyState === WebSocket.OPEN) {
          try {
            client.ws.send(JSON.stringify({
              type: 'USER_ONLINE', role: myRole, displayName: myName,
              officeId: myOfficeId, online: getOnlineByOffice(),
            }));
          } catch {}
        }
      }
      return;
    }

    if (!authenticated || !myRole) {
      ws.send(JSON.stringify({ type: 'AUTH_ERROR', text: 'Сначала REGISTER с токеном' }));
      return;
    }

    switch (msg.type) {

      case 'NEW_TASK': {
        const toRole = (msg.to || '').toLowerCase().trim();
        if (!VALID_ROLES.includes(toRole)) {
          ws.send(JSON.stringify({ type: 'ERROR', text: `Неизвестный расчёт: ${toRole}` })); return;
        }
        const toOfficeId = msg.toOfficeId || myOfficeId;
        if (!canAssignTask(myOfficeId, toOfficeId)) {
          ws.send(JSON.stringify({ type: 'ERROR', text: 'Нет прав назначать задачи этому подразделению' })); return;
        }
        if (!msg.text?.trim()) {
          ws.send(JSON.stringify({ type: 'ERROR', text: 'Текст задачи обязателен' })); return;
        }
        const info = stmt.insertTask.run({
          from_role:    myRole,
          to_role:      toRole,
          from_office:  myOfficeId || 'HQ',
          to_office:    toOfficeId || 'HQ',
          target_id:    msg.targetId    || null,
          target_title: msg.targetTitle || '',
          text:         msg.text.trim(),
        });
        const task  = stmt.getTask.get(info.lastInsertRowid);
        const nTask = normalizeTask(task);
        log(`📋 Задача #${task.id}: ${myRole}[${myOfficeId}] → ${toRole}[${toOfficeId}]`);

        // Отправителю — подтверждение
        ws.send(JSON.stringify({ type: 'TASK_SENT', task: nTask }));

        // Получателю — уведомление о новой задаче (только нужному подразделению)
        const delivered = sendToOfficeRole(toRole, toOfficeId, { type: 'NEW_TASK', task: nTask });
        log(`   Доставлено получателю: ${delivered ? 'да' : 'офлайн'}`);

        // Всем остальным — обновление без уведомления
        for (const [, client] of clients) {
          if (client.astraId === myAstraId) continue; // отправитель уже получил TASK_SENT
          if (client.role === toRole && client.officeId === toOfficeId) continue; // получатель уже получил NEW_TASK
          if (client.ws.readyState === WebSocket.OPEN) {
            try { client.ws.send(JSON.stringify({ type: 'TASK_UPDATE', task: nTask })); } catch {}
          }
        }
        break;
      }

      case 'UPDATE_TASK': {
        const VALID_STATUSES = [
          'новая','принята','в работе','выполнена','отклонена',
          'поражена','не поражена','доразведка','подтверждено',
          'подавлено','перенесена','уничтожена',
        ];
        if (!VALID_STATUSES.includes(msg.status)) {
          ws.send(JSON.stringify({ type: 'ERROR', text: `Неверный статус: ${msg.status}` })); return;
        }
        stmt.updateTaskStatus.run({ id: msg.taskId, status: msg.status, updated_by: myRole });
        if (msg.status === 'перенесена' && msg.rescheduleDate) {
          db.prepare(`UPDATE tasks SET text = text || ' [перенесена на ' || ? || ']' WHERE id = ?`)
            .run(msg.rescheduleDate, msg.taskId);
        }
        const task = stmt.getTask.get(msg.taskId);
        if (!task) { ws.send(JSON.stringify({ type: 'ERROR', text: `Задача не найдена` })); return; }
        log(`🔄 Задача #${task.id} → ${task.status} (${myRole}[${myOfficeId}])`);
        broadcastAll({ type: 'TASK_UPDATED', task: normalizeTask(task) });
        break;
      }

      case 'UPDATE':
        for (const [, client] of clients) {
          if (client.astraId === myAstraId) continue;
          if (client.ws.readyState === WebSocket.OPEN) {
            try { client.ws.send(JSON.stringify({ type: 'UPDATE', from: myRole, displayName: myName })); } catch {}
          }
        }
        break;

      case 'CREATE_PLAN': {
        if (!msg.planDate || !msg.targetId) {
          ws.send(JSON.stringify({ type: 'ERROR', text: 'planDate и targetId обязательны' })); return;
        }
        const info = stmt.insertPlan.run({
          target_id:   String(msg.targetId),
          target_data: JSON.stringify(msg.targetData || {}),
          plan_date:   msg.planDate,
          created_by:  myRole,
          note:        msg.note || '',
        });
        if (info.changes === 0) {
          ws.send(JSON.stringify({ type: 'ERROR', text: `Цель ${msg.targetId} уже запланирована на ${msg.planDate}` })); return;
        }
        const plan = stmt.getPlanById.get(info.lastInsertRowid);
        log(`📅 План #${plan.id}: ${myRole} → ${plan.plan_date} цель ${plan.target_id}`);
        broadcastAll({ type: 'PLAN_CREATED', plan });
        break;
      }

      case 'GET_PLANS': {
        if (!msg.planDate) return;
        const plans = stmt.getPlansForDate.all(msg.planDate).filter(p => !p.published);
        ws.send(JSON.stringify({ type: 'PLANS_FOR_DATE', planDate: msg.planDate, plans }));
        break;
      }

      case 'DELETE_PLAN':
        stmt.deletePlan.run(msg.planId);
        broadcastAll({ type: 'PLAN_DELETED', planId: msg.planId });
        break;

      case 'GET_DRAFT_CHECK': {
        if (!msg.planDate) return;
        const plans = stmt.getUnpublishedPlans.all(msg.planDate);
        if (plans.length > 0) {
          ws.send(JSON.stringify({ type: 'DRAFT_EXISTS', planDate: msg.planDate, count: plans.length }));
        }
        break;
      }

      case 'GET_DRAFT_PLANS': {
        if (!msg.planDate) return;
        const plans = stmt.getPlansByDate.all(msg.planDate);
        ws.send(JSON.stringify({ type: 'DRAFT_PLANS', planDate: msg.planDate, plans }));
        break;
      }

      case 'MARK_PUBLISHED': {
        if (!msg.planId) return;
        stmt.markPlanPublished.run(msg.planId);
        const plan = stmt.getPlanById.get(msg.planId);
        broadcastAll({ type: 'PLAN_PUBLISHED', plan });
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
      log(`🔴 ${myName || myRole} [${myRole}] отключился`);
      for (const [, client] of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          try {
            client.ws.send(JSON.stringify({
              type: 'USER_OFFLINE', role: myRole, online: getOnlineRoles(),
            }));
          } catch {}
        }
      }
    }
  });

  ws.on('error', (err) => {
    log(`❌ WS ошибка (${myName || 'незарег.'}): ${err.message}`);
  });
});

log(`🟢 WS-сервер запущен на порту 5000`);
log(`   БД: ${path.join(__dirname, 'data.db')}`);
log(`   Расчёты: ${VALID_ROLES.join(', ')}`);
log(`   Управление токенами: node server.js --issue <username> [role] [officeId]`);