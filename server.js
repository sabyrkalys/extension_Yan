// server.js
// Запуск: node server.js
// Зависимости: npm install ws better-sqlite3

const WebSocket = require('ws');
const Database  = require('better-sqlite3');
const path      = require('path');
const fs        = require('fs');
const http      = require('http');

// ─────────────────────────────────────────────────────────────────
// Офисы — дублируют config.js (сервер не имеет доступа к браузерному коду)
// Добавить офис: одна запись здесь и в config.js клиента
// ─────────────────────────────────────────────────────────────────
const OFFICES = {
  'HQ':    { name: 'Головной офис',  short: 'ГО',   isHQ: true,  roles: ['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'] },
  'o177':  { name: '177 ОГВПМП',     short: '177',  isHQ: false, roles: ['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'] },
  // Шаблон: 'o3bat': { name: '3-й батальон', short: '3 бат.', isHQ: false, roles: [...] },
};

// Роли допустимы из любого офиса (одинаковые)
const VALID_ROLES = ['разведка','рэб','инженеры','артиллерия','бпс','админ','гооп','босс'];

// Правило назначения задач
function canAssignTask(fromOffice, toOffice) {
  if (!fromOffice || !toOffice) return true;   // старые клиенты без officeId — разрешаем
  if (fromOffice === toOffice) return true;
  if (OFFICES[fromOffice]?.isHQ) return true;
  return false;
}

// Статус онлайн — объект { officeId: [roles] }
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

// ═══════════════════════════════════════════════════════════════════════════
// HTTP СЕРВЕР — раздача файлов расширения для обновления
// Файлы расширения лежат в папке ./extension рядом с server.js
// Порт 5001 — отдельно от WS порта 5000
// ═══════════════════════════════════════════════════════════════════════════

const EXTENSION_DIR = path.join(__dirname, 'extension');
const HTTP_PORT     = 5001;

// Разрешённые файлы для скачивания (безопасность)
const ALLOWED_FILES = [
  'manifest.json',
  'content.js',
  'background.js',
  'inject.js',
  'version.json',
];

const MIME_TYPES = {
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
};

const httpServer = http.createServer((req, res) => {
  // CORS — разрешаем запросы с любого источника (только в локальной сети)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const url      = req.url.split('?')[0]; // убираем query string
  const fileName = path.basename(url);    // только имя файла, без пути

  // Разрешаем только конкретные файлы
  if (!ALLOWED_FILES.includes(fileName)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const filePath = path.join(EXTENSION_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('File not found');
    return;
  }

  const ext      = path.extname(fileName);
  const mimeType = MIME_TYPES[ext] || 'text/plain';

  res.writeHead(200, { 'Content-Type': mimeType });
  fs.createReadStream(filePath).pipe(res);
});

httpServer.listen(HTTP_PORT, () => {
  log(`📦 HTTP сервер обновлений запущен на порту ${HTTP_PORT}`);
  log(`   Файлы расширения: ${EXTENSION_DIR}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// БАЗА ДАННЫХ (SQLite — один файл, переживает перезапуски сервера)
// ═══════════════════════════════════════════════════════════════════════════

const db = new Database(path.join(__dirname, 'data.db'));

// WAL-режим: параллельные чтения не блокируют запись
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS plans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id   TEXT    NOT NULL,
    target_data TEXT    NOT NULL,
    plan_date   TEXT    NOT NULL,
    created_by  TEXT    NOT NULL,
    created_at  TEXT    DEFAULT (datetime('now')),
    published   INTEGER DEFAULT 0,
    published_at TEXT   DEFAULT NULL,
    note        TEXT    DEFAULT '',
    UNIQUE (target_id, plan_date)   -- защита от дублей на уровне БД
  );
  CREATE INDEX IF NOT EXISTS idx_plans_date ON plans(plan_date);
  CREATE INDEX IF NOT EXISTS idx_plans_published ON plans(plan_date, published);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    astra_id    TEXT    UNIQUE,          -- id из профиля AstraMap
    role        TEXT    NOT NULL,        -- расчёт: разведка | рэб | ...
    display_name TEXT,                   -- имя из профиля
    token_hint  TEXT,                    -- первые 8 символов токена (для отладки)
    last_seen   TEXT    DEFAULT (datetime('now'))
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

// ── Подготовленные запросы (быстрее чем строить SQL каждый раз) ──────────────
const stmt = {
  upsertUser: db.prepare(`
    INSERT INTO users (astra_id, role, display_name, token_hint, last_seen)
    VALUES (@astra_id, @role, @display_name, @token_hint, datetime('now'))
    ON CONFLICT(astra_id) DO UPDATE SET
      role         = excluded.role,
      display_name = excluded.display_name,
      token_hint   = excluded.token_hint,
      last_seen    = datetime('now')
  `),

  getRoleByAstraId: db.prepare(
    `SELECT role, display_name FROM users WHERE astra_id = ?`
  ),

  insertTask: db.prepare(`
    INSERT INTO tasks (from_role, to_role, target_id, target_title, text, status)
    VALUES (@from_role, @to_role, @target_id, @target_title, @text, 'новая')
  `),

  updateTaskStatus: db.prepare(`
    UPDATE tasks SET status = @status, updated_at = datetime('now'), updated_by = @updated_by
    WHERE id = @id
  `),

  getTask: db.prepare(`SELECT * FROM tasks WHERE id = ?`),

  getPendingTasks: db.prepare(`
    SELECT * FROM tasks WHERE to_role = ? AND status = 'новая'
    ORDER BY created_at ASC
  `),

  getRecentTasks: db.prepare(`
    SELECT * FROM tasks
    WHERE from_role = ? OR to_role = ?
    ORDER BY created_at DESC LIMIT 100
  `),

  touchUser: db.prepare(
    `UPDATE users SET last_seen = datetime('now') WHERE astra_id = ?`
  ),

  // Plans
  // INSERT OR IGNORE — если план (target_id, plan_date) уже есть, тихо пропускаем
  insertPlan: db.prepare(`
    INSERT OR IGNORE INTO plans (target_id, target_data, plan_date, created_by, note)
    VALUES (@target_id, @target_data, @plan_date, @created_by, @note)
  `),
  getPlansForDate: db.prepare(`
    SELECT * FROM plans WHERE plan_date = ? ORDER BY created_at DESC
  `),
  deletePlan: db.prepare(`DELETE FROM plans WHERE id = ?`),
  getPlanById: db.prepare(`SELECT * FROM plans WHERE id = ?`),
  getUnpublishedPlans: db.prepare(`
    SELECT * FROM plans WHERE plan_date = ? AND published = 0 ORDER BY created_at ASC
  `),
  markPlanPublished: db.prepare(`
    UPDATE plans SET published = 1, published_at = datetime('now') WHERE id = ?
  `),
  getPlansByDate: db.prepare(`SELECT * FROM plans WHERE plan_date = ? ORDER BY created_at ASC`),
};

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET СЕРВЕР
// ═══════════════════════════════════════════════════════════════════════════

// ── SSL сертификаты для WSS ──────────────────────────────────────────────────
// Создай сертификат командой (нужен openssl):
//   openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout key.pem -out cert.pem -subj "/CN=localhost"
// Файлы cert.pem и key.pem положи рядом с server.js

// Обычный WS без SSL — Mixed Content обходится через background.js расширения.
// Background service worker может подключаться к ws:// без ограничений браузера.
const wss = new WebSocket.Server({ port: 5000 });

// Подключённые клиенты: username → { ws, role, astraId, displayName }
// Ключ — username (уникален), не role (может быть одинаковой у нескольких)
const clients = new Map();

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('ru-RU')}] ${msg}`);
}

// Нормализует поля задачи из БД (from_role/to_role) для клиента (from/to)
function normalizeTask(task) {
  return {
    ...task,
    from: task.from_role || task.from || '',
    to:   task.to_role   || task.to   || '',
  };
}

// Отправить сообщение всем клиентам с нужной ролью
function sendTo(role, data) {
  const targets = getClientsByRole(role);
  if (targets.length === 0) return false;
  targets.forEach(client => {
    try { client.ws.send(JSON.stringify(data)); } catch {}
  });
  return true;
}

function broadcast(data, exceptRole = null) {
  for (const [, client] of clients) {
    if (client.role === exceptRole) continue;
    if (client.ws.readyState === WebSocket.OPEN) {
      try { client.ws.send(JSON.stringify(data)); } catch {}
    }
  }
}

function broadcastAll(data) {
  for (const [, client] of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(data));
    }
  }
}

function getOnlineRoles() {
  // Возвращаем список уникальных ролей онлайн
  const roles = new Set();
  for (const [, client] of clients) {
    if (client.ws.readyState === WebSocket.OPEN) roles.add(client.role);
  }
  return [...roles];
}

// Получить всех клиентов с нужной ролью (может быть несколько)
function getClientsByRole(role) {
  const result = [];
  for (const [, client] of clients) {
    if (client.role === role && client.ws.readyState === WebSocket.OPEN) {
      result.push(client);
    }
  }
  return result;
}

// ── Обработка соединений ──────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  let myRole       = null;
  let myAstraId    = null;
  let myName       = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      ws.send(JSON.stringify({ type: 'ERROR', text: 'Неверный JSON' }));
      return;
    }

    switch (msg.type) {

      // ── Регистрация ───────────────────────────────────────────────────────
      // Клиент присылает данные пользователя из /go/permission-group.
      // Роль определяется на клиенте по маппингу username → расчёт,
      // сервер сохраняет в БД и может переопределить при несоответствии.
      //
      // { type: 'REGISTER', userId, username, displayName, role }
      //   role = null  →  сервер ответит NEED_ROLE, клиент покажет выбор
      case 'REGISTER': {
        const userId      = msg.userId?.toString() || null;
        const username    = (msg.username    || '').trim();
        const displayName = (msg.displayName || username || 'Неизвестно').trim();
        const role        = (msg.role        || '').toLowerCase().trim() || null;

        if (!username) {
          ws.send(JSON.stringify({ type: 'ERROR', text: 'username обязателен' }));
          return;
        }

        // Проверяем кэш в БД по userId/username
        let resolvedRole = role;
        if (userId) {
          const cached = stmt.getRoleByAstraId.get(userId);
          if (cached) {
            resolvedRole = cached.role;
            log(`🔑 Роль из БД: ${resolvedRole} (${displayName})`);
          }
        }

        // Роль так и не определена — просим клиента выбрать вручную
        if (!resolvedRole || !VALID_ROLES.includes(resolvedRole)) {
          ws.send(JSON.stringify({
            type:       'NEED_ROLE',
            text:       `Не удалось определить расчёт для ${displayName}. Выберите вручную.`,
            validRoles: VALID_ROLES,
          }));
          return;
        }

        // Сохраняем/обновляем в БД
        stmt.upsertUser.run({
          astra_id:     userId || username,
          role:         resolvedRole,
          display_name: displayName,
          token_hint:   username,
        });

        myRole    = resolvedRole;
        myAstraId = userId || username;
        myName    = displayName;
        const myOfficeId = (msg.officeId && OFFICES[msg.officeId]) ? msg.officeId : 'HQ';

        clients.set(myAstraId, { ws, role: myRole, astraId: myAstraId, displayName: myName, officeId: myOfficeId });
        log(`✅ ${myName} [${myRole}] подключён`);

        ws.send(JSON.stringify({
          type:        'REGISTERED',
          role:        myRole,
          displayName: myName,
          officeId:    myOfficeId,
          online:      getOnlineByOffice(),
        }));

        // Непрочитанные задачи (только со статусом 'новая')
        const pending = stmt.getPendingTasks.all(myRole);
        if (pending.length > 0) {
          ws.send(JSON.stringify({ type: 'PENDING_TASKS', tasks: pending.map(normalizeTask) }));
        }

        // История задач этого расчёта (последние 100)
        const history = stmt.getRecentTasks.all(myRole, myRole);
        ws.send(JSON.stringify({ type: 'TASKS_HISTORY', tasks: history.map(normalizeTask) }));

        broadcast({ type: 'USER_ONLINE', role: myRole, displayName: myName, officeId: myOfficeId, online: getOnlineByOffice() }, myRole);
        break;
      }

      // ── Новая задача ──────────────────────────────────────────────────────
      // { type: 'NEW_TASK', to: 'разведка', targetId, targetTitle, text }
      case 'NEW_TASK': {
        if (!myRole) { ws.send(JSON.stringify({ type: 'ERROR', text: 'Сначала REGISTER' })); return; }

        const toRole = (msg.to || '').toLowerCase().trim();
        if (!VALID_ROLES.includes(toRole)) {
          ws.send(JSON.stringify({ type: 'ERROR', text: `Неизвестный расчёт: ${toRole}` })); return;
        }

        // Проверка прав по офисам
        const myClient    = clients.get(myAstraId);
        const fromOffice  = myClient?.officeId || 'HQ';
        const toOfficeId  = msg.toOfficeId || fromOffice;
        if (!canAssignTask(fromOffice, toOfficeId)) {
          ws.send(JSON.stringify({ type: 'ERROR', text: 'Нет прав назначать задачи этому офису' })); return;
        }
        if (!msg.text?.trim()) {
          ws.send(JSON.stringify({ type: 'ERROR', text: 'Текст задачи обязателен' })); return;
        }

        // Сохраняем в SQLite
        const info = stmt.insertTask.run({
          from_role:    myRole,
          to_role:      toRole,
          target_id:    msg.targetId   || null,
          target_title: msg.targetTitle || '',
          text:         msg.text.trim(),
        });
        const task = stmt.getTask.get(info.lastInsertRowid);
        log(`📋 Задача #${task.id}: ${myRole} → ${toRole} | ${task.text}`);

        const nTask = normalizeTask(task);
        ws.send(JSON.stringify({ type: 'TASK_SENT', task: nTask }));

        const delivered = sendTo(toRole, { type: 'NEW_TASK', task: nTask });
        log(`   Доставлено: ${delivered ? 'да' : 'офлайн — сохранено в БД'}`);

        // Всем наблюдателям (КНП видит всё)
        for (const [role, client] of clients) {
          if (role === myRole || role === toRole) continue;
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'TASK_UPDATE', task: normalizeTask(task) }));
          }
        }
        break;
      }

      // ── Смена статуса задачи ──────────────────────────────────────────────
      // { type: 'UPDATE_TASK', taskId: 3, status: 'принята' }
      case 'UPDATE_TASK': {
        if (!myRole) return;

        const VALID_STATUSES = ['новая', 'принята', 'в работе', 'выполнена', 'отклонена',
                               'поражена', 'не поражена', 'доразведка', 'подтверждено', 'подавлено',
                               'перенесена'];
        if (!VALID_STATUSES.includes(msg.status)) {
          ws.send(JSON.stringify({ type: 'ERROR', text: `Неверный статус: ${msg.status}` })); return;
        }

        stmt.updateTaskStatus.run({ id: msg.taskId, status: msg.status, updated_by: myRole });
        // Если задача перенесена — сохраняем новую дату в заметку
        if (msg.status === 'перенесена' && msg.rescheduleDate) {
          db.prepare(`UPDATE tasks SET text = text || ' [перенесена на ' || ? || ']' WHERE id = ?`)
            .run(msg.rescheduleDate, msg.taskId);
        }
        const task = stmt.getTask.get(msg.taskId);
        if (!task) { ws.send(JSON.stringify({ type: 'ERROR', text: `Задача #${msg.taskId} не найдена` })); return; }

        log(`🔄 Задача #${task.id} → ${task.status} (${myRole})`);
        broadcastAll({ type: 'TASK_UPDATED', task: normalizeTask(task) });
        break;
      }

      // ── Обновление карты ──────────────────────────────────────────────────
      case 'UPDATE': {
        if (!myRole) return;
        log(`🗺️  Обновление карты от: ${myRole}`);
        broadcast({ type: 'UPDATE', from: myRole, displayName: myName }, myRole);
        break;
      }

      // ── Создать план ─────────────────────────────────────────────────────
      // { type: 'CREATE_PLAN', planDate, targetId, targetData, note }
      case 'CREATE_PLAN': {
        if (!myRole) return;
        if (!msg.planDate || !msg.targetId) {
          ws.send(JSON.stringify({ type: 'ERROR', text: 'planDate и targetId обязательны' }));
          return;
        }
        const info = stmt.insertPlan.run({
          target_id:   String(msg.targetId),
          target_data: JSON.stringify(msg.targetData || {}),
          plan_date:   msg.planDate,
          created_by:  myRole,
          note:        msg.note || '',
        });

        // INSERT OR IGNORE: если дубль — changes=0, lastInsertRowid=0
        if (info.changes === 0) {
          log(`⚠️  Дубль плана: цель ${msg.targetId} на ${msg.planDate} уже есть — пропущено`);
          ws.send(JSON.stringify({ type: 'ERROR', text: `Цель ${msg.targetId} уже запланирована на ${msg.planDate}` }));
          return;
        }

        const plan = stmt.getPlanById.get(info.lastInsertRowid);
        log(`📅 План #${plan.id}: ${myRole} → ${plan.plan_date} цель ${plan.target_id}`);
        broadcastAll({ type: 'PLAN_CREATED', plan });
        break;
      }

      // ── Получить планы за дату ────────────────────────────────────────────
      // { type: 'GET_PLANS', planDate }
      case 'GET_PLANS': {
        if (!msg.planDate) return;
        // Отдаём только неопубликованные — опубликованные уже есть в AstraMap
        const plans = stmt.getPlansForDate.all(msg.planDate)
          .filter(p => !p.published);
        ws.send(JSON.stringify({ type: 'PLANS_FOR_DATE', planDate: msg.planDate, plans }));
        break;
      }

      // ── Удалить план ──────────────────────────────────────────────────────
      // { type: 'DELETE_PLAN', planId }
      case 'DELETE_PLAN': {
        if (!myRole) return;
        stmt.deletePlan.run(msg.planId);
        broadcastAll({ type: 'PLAN_DELETED', planId: msg.planId });
        break;
      }

      // ── Получить черновые планы за дату ─────────────────────────────────────
      case 'GET_DRAFT_CHECK': {
        // Проверяем есть ли неопубликованные планы за дату
        if (!msg.planDate) return;
        const plans = stmt.getUnpublishedPlans.all(msg.planDate);
        if (plans.length > 0) {
          ws.send(JSON.stringify({
            type: 'DRAFT_EXISTS',
            planDate: msg.planDate,
            count: plans.length
          }));
        }
        break;
      }

      case 'GET_DRAFT_PLANS': {
        if (!msg.planDate) return;
        const plans = stmt.getPlansByDate.all(msg.planDate);
        ws.send(JSON.stringify({ type: 'DRAFT_PLANS', planDate: msg.planDate, plans }));
        break;
      }

      // ── Отметить план как опубликованный ─────────────────────────────────────
      case 'MARK_PUBLISHED': {
        if (!myRole || !msg.planId) return;
        stmt.markPlanPublished.run(msg.planId);
        const plan = stmt.getPlanById.get(msg.planId);
        broadcastAll({ type: 'PLAN_PUBLISHED', plan });
        break;
      }

      case 'PING':
        ws.send(JSON.stringify({ type: 'PONG' }));
        break;

      default:
        log(`⚠️  Неизвестный тип: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    if (myAstraId) {
      clients.delete(myAstraId);
      log(`🔴 ${myName || myRole} [${myRole}] отключился`);
      broadcast({ type: 'USER_OFFLINE', role: myRole, online: getOnlineRoles() });
    }
  });

  ws.on('error', (err) => {
    log(`❌ WS ошибка (${myName || myRole || 'незарег.'}): ${err.message}`);
  });
});

log(`🟢 WS-сервер запущен на порту 5000 (ws://)`);
log(`   БД: ${path.join(__dirname, 'data.db')}`);
log(`   Расчёты: ${VALID_ROLES.join(', ')}`);
