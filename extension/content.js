/// ======================== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ========================

let isPopupVisible = false;
let popupElement = null;
let lon = null;
let lat = null;
let map = null;

// Данные текущего пользователя из AstraMap
let myRole        = null;  // расчёт: разведка | рэб | ...
let myUsername    = null;  // username из AstraMap (kalys_MP)
let myDisplayName = null;  // verboseName (Калыс МП)
let myUserId      = null;  // числовой id

// Счётчик непрочитанных задач (для бейджа)
let unreadTaskCount = 0;
// ID задач которые уже были показаны — не считаем повторно при реконнекте
const seenTaskIds = new Set();

// Хранилище последних задач по каждой цели: targetId → task
// Нужно чтобы при перерисовке таблицы показывать статус задачи в строке
const tasksByTarget = {};

// Активная папка (выбранная дата) и крайняя (последняя) папка
let activeFolderId   = null;
let activeFolderDate = null;
let latestFolderId   = null;
let latestFolderDate = null;

// ── Маппинг роль → список username ────────────────────────────────────────
// Роль как ключ, значение — массив всех username этой роли.
// Добавлять нового бойца: просто добавь его username в нужный массив.
const ROLE_TO_USERS = {
  'админ':      ['kalys_MP'],
  'рэб':        ['Sprut_MP'],
  'разведка':   ['Mich_MP', 'Yastreb_MP'],
  'артиллерия': ['Stena_MP'],
  'инженеры':   ['Kometa_MP', 'Prapor_MP'],
  'бпс':        ['Luka_MP'],
  'гооп':       ['Sayn_MP'],
  'босс':       ['Polyana_MP'],
  '177 огвпмп': ['More_MP'],
};

// Определить роль по username — перебираем все роли и ищем username в массиве
function resolveRoleLocally(username) {
  for (const [role, users] of Object.entries(ROLE_TO_USERS)) {
    if (users.includes(username)) return role;
  }
  return null; // не найден — покажем ручной выбор
}

// ✅ FIX: Получаем токен через функцию, чтобы всегда брать актуальное значение
function getToken() {
  return localStorage.getItem('access_token') ||
         localStorage.getItem('token') ||
         sessionStorage.getItem('access_token') ||
         null;
}

// Проверка при старте
// При старте проверяем: есть extension_token → сразу подключаемся по нему
// Нет ни extension_token ни AstraMap-токена → показываем форму ввода
(function checkInitialToken() {
  const extToken = localStorage.getItem('extension_token');
  if (extToken) {
    // extension_token есть — wsRegister отправит его при подключении WS
    console.log('[content] Будет использован extension_token');
    return;
  }
  if (!getToken()) {
    // Нет ничего — показываем модал ввода токена после загрузки страницы
    console.warn('[content] Нет токена — показываем форму ввода');
    setTimeout(() => showTokenInputModal(), 1500);
  }
})();

function convertWgs84ToSk42(lon, lat) {
  if (!window.proj4) {
    console.warn('proj4 не загружен');
    return { x: lon, y: lat };
  }

  try {
    const wgs84 = "EPSG:4326";
    const zone = Math.floor((lon + 6) / 6);
    const lon0 = zone * 6 - 3;
    const sk42 = `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${zone * 1000000 + 500000} +y_0=0 +ellps=krass +units=m +no_defs`;
    const [x, y] = proj4(wgs84, sk42, [lon, lat]);
    return { x: Math.round(x), y: Math.round(y) };
  } catch (error) {
    console.error('Ошибка proj4:', error);
    return { x: lon, y: lat };
  }
}

function convertSk42ToWgs84(x, y) {
  if (!window.proj4) {
    console.warn('proj4 не загружен');
    return { lon: x, lat: y };
  }

  try {
    const wgs84 = "EPSG:4326";
    console.log(x, y);
    const zone = Math.floor(x / 1000000);
    const lon0 = zone * 6 - 3;
    const sk42 = `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${zone * 1000000 + 500000} +y_0=0 +ellps=krass +towgs84=23.92,-141.27,-80.9,0,0,0,0 +units=m +no_defs`;
    const [lon, lat] = proj4(sk42, wgs84, [parseFloat(x), parseFloat(y)]);
    return {
      lon: parseFloat(lon.toFixed(6)),
      lat: parseFloat(lat.toFixed(6))
    };
  } catch (error) {
    console.error('Ошибка proj4:', error);
    return { lon: x, lat: y };
  }
}

// ======================== API НАСТРОЙКИ ========================
const ASTRA_API = {
  createUpdate: 'https://center.astramaps.ru/go/entity-V2',
  search:       'https://center.astramaps.ru/go/entity-V2/search',
  entity:       'https://center.astramaps.ru/go/entity-V2',
  relink:       'https://center.astramaps.ru/go/entity-V2/relink',
};

// ID корневой папки группы (из URL карты или из структуры папок)
// Подставь реальный ID корневой папки твоей группы
const ROOT_FOLDER_ID = 521055;

// Ключ кэша в localStorage
const CACHE_KEY_PREFIX = 'astra_targets_';
const CACHE_KEY_DATES  = 'astra_dates_tree';
const CACHE_TTL_MS     = 14 * 24 * 60 * 60 * 1000; // 2 недели

// Очищаем устаревшие записи кэша при загрузке расширения
(function cleanOldCache() {
  try {
    const now = Date.now();
    const keysToDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(CACHE_KEY_PREFIX) && key !== CACHE_KEY_DATES) continue;
      try {
        const cached = JSON.parse(localStorage.getItem(key));
        if (cached && cached.ts && (now - cached.ts) > CACHE_TTL_MS) {
          keysToDelete.push(key);
        }
      } catch {}
    }
    keysToDelete.forEach(k => localStorage.removeItem(k));
    if (keysToDelete.length > 0) {
      console.log(`[cache] Очищено устаревших записей: ${keysToDelete.length}`);
    }
  } catch {}
})();

// ======================== WS CLIENT ========================
let ws;

function connectWS() {
  // Подключаемся через background.js — без ограничений Mixed Content.
  // Решает проблему на Android с самоподписанным сертификатом.
  try {
    bgPort = chrome.runtime.connect({ name: 'ws-bridge' });

    bgPort.onMessage.addListener((msg) => {
      if (msg.type === 'WS_STATUS') {
        if (msg.status === 'connected') {
          console.log('[content] 🟢 WS подключён (через background)');
          // При каждом подключении пробуем определить профиль если ещё не определён
          if (!myUsername) fetchProfileDirect();
          wsRegister();
        } else {
          console.log('[content] 🔴 WS отключён');
          updateOnlineIndicator([]);
        }
        return;
      }
      handleWsMessage(msg);
    });

    bgPort.onDisconnect.addListener(() => {
      console.warn('[content] Background порт отключился, переподключаемся...');
      bgPort = null;
      setTimeout(connectWS, 2000);
    });

    console.log('[content] Порт к background.js открыт');
  } catch (err) {
    console.error('[content] Ошибка подключения к background:', err);
  }
}

// Зарегистрироваться с данными пользователя из AstraMap
function wsRegisterWithUser(userId, username, displayName, role) {
  // Если есть extension_token — авторизуемся по нему
  const extToken = localStorage.getItem('extension_token');
  if (extToken) {
    wsSend({ type: 'REGISTER', userToken: extToken });
    return;
  }
  // Стандартная авторизация через AstraMap
  wsSend({ type: 'REGISTER', userId, username, displayName, role });
}

// Вызывается при переподключении WS (данные уже есть в памяти)
function wsRegister() {
  const extToken = localStorage.getItem('extension_token');
  if (extToken) {
    wsSend({ type: 'REGISTER', userToken: extToken });
    return;
  }
  if (myUsername) {
    wsRegisterWithUser(myUserId, myUsername, myDisplayName, myRole);
  }
}

// ── Модал ввода токена ────────────────────────────────────────────────────────
function showTokenInputModal() {
  document.querySelector('#tokenInputModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'tokenInputModal';
  modal.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.75);
    display:flex;align-items:center;justify-content:center;z-index:99999;
    font-family:system-ui,sans-serif;
  `;
  modal.innerHTML = `
    <div style="background:#1a2740;border:1px solid #2d4a6a;border-radius:12px;
                padding:28px 24px;width:90%;max-width:420px;color:#e2e8f0;">
      <div style="font-size:20px;font-weight:700;margin-bottom:6px;">🗺 AstraMap Extension</div>
      <div style="font-size:13px;color:#90afc5;margin-bottom:20px;">
        Вставь персональный токен для подключения
      </div>
      <textarea id="tokenInputField"
        placeholder="Вставь токен сюда..."
        style="width:100%;height:72px;padding:10px;border-radius:7px;border:1px solid #2d4a6a;
               background:#0f1e30;color:#e2e8f0;font-size:13px;font-family:monospace;
               resize:none;box-sizing:border-box;outline:none;"></textarea>
      <div id="tokenInputError" style="color:#fc8181;font-size:12px;min-height:18px;margin-top:4px;"></div>
      <button id="tokenConnectBtn"
        style="width:100%;margin-top:14px;padding:11px;background:#2563eb;color:white;
               border:none;border-radius:7px;cursor:pointer;font-size:15px;font-weight:600;">
        🔌 Подключиться
      </button>
      <div style="text-align:center;margin-top:12px;font-size:11px;color:#5a7fa0;">
        Токен выдаётся администратором системы
      </div>
    </div>`;
  document.body.appendChild(modal);

  const field  = modal.querySelector('#tokenInputField');
  const errDiv = modal.querySelector('#tokenInputError');
  const btn    = modal.querySelector('#tokenConnectBtn');

  field.focus();

  btn.addEventListener('click', () => {
    const token = field.value.trim();
    if (!token || token.length < 32) {
      errDiv.textContent = '❌ Неверный формат токена';
      return;
    }
    errDiv.textContent = '';
    btn.textContent    = '⏳ Подключаемся...';
    btn.disabled       = true;
    localStorage.setItem('extension_token', token);
    modal.remove();
    wsSend({ type: 'REGISTER', userToken: token });
  });
}

// ── Обработать ответ TOKEN_GENERATED ─────────────────────────────────────────
function handleTokenGenerated(msg) {
  document.querySelector('#tokenGeneratedModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'tokenGeneratedModal';
  modal.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.75);
    display:flex;align-items:center;justify-content:center;z-index:99999;
    font-family:system-ui,sans-serif;
  `;
  modal.innerHTML = `
    <div style="background:#1a2740;border:1px solid #2d4a6a;border-radius:12px;
                padding:24px;width:90%;max-width:480px;color:#e2e8f0;">
      <div style="font-size:16px;font-weight:700;margin-bottom:4px;">
        ✅ Токен создан для ${msg.displayName}
      </div>
      <div style="font-size:12px;color:#90afc5;margin-bottom:16px;">
        Роль: <b>${msg.role}</b> | Подразделение: <b>${msg.officeId}</b>
      </div>
      <div style="font-size:12px;color:#90afc5;margin-bottom:6px;">Сообщение для отправки:</div>
      <textarea id="generatedMessage" readonly
        style="width:100%;height:200px;padding:10px;border-radius:7px;
               border:1px solid #2d4a6a;background:#0f1e30;color:#c8e6c9;
               font-size:12px;font-family:monospace;resize:none;box-sizing:border-box;">
${msg.message}
      </textarea>
      <div style="display:flex;gap:10px;margin-top:14px;">
        <button id="copyMsgBtn"
          style="flex:1;padding:10px;background:#28a745;color:white;border:none;
                 border-radius:7px;cursor:pointer;font-size:14px;font-weight:600;">
          📋 Скопировать
        </button>
        <button id="closeTokenModal"
          style="padding:10px 20px;background:#4a5568;color:white;border:none;
                 border-radius:7px;cursor:pointer;font-size:14px;">
          Закрыть
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const textarea = modal.querySelector('#generatedMessage');
  textarea.value = msg.message;

  modal.querySelector('#copyMsgBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(msg.message).then(() => {
      modal.querySelector('#copyMsgBtn').textContent = '✅ Скопировано!';
      setTimeout(() => { modal.querySelector('#copyMsgBtn').textContent = '📋 Скопировать'; }, 2000);
    });
  });
  modal.querySelector('#closeTokenModal').addEventListener('click', () => modal.remove());

  // Обновляем список токенов если он открыт
  wsSend({ type: 'LIST_TOKENS' });
  showToast(`✅ Токен создан для ${msg.displayName}`, 'success');
}

// ── Отрисовать список токенов (в панели токенов) ──────────────────────────────
function renderTokensList(tokens) {
  const container = document.querySelector('#tokensListContainer');
  if (!container) return;

  if (!tokens || !tokens.length) {
    container.innerHTML = '<div style="padding:20px;color:#90afc5;text-align:center;">Нет выданных токенов</div>';
    return;
  }

  container.innerHTML = `
    <div style="overflow-y:auto;flex:1;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:#0f1e30;">
            <th style="padding:7px 8px;border:1px solid #2d4a6a;text-align:left;">Пользователь</th>
            <th style="padding:7px 8px;border:1px solid #2d4a6a;">Роль</th>
            <th style="padding:7px 8px;border:1px solid #2d4a6a;">Подр.</th>
            <th style="padding:7px 8px;border:1px solid #2d4a6a;">Выдал</th>
            <th style="padding:7px 8px;border:1px solid #2d4a6a;">Последний вход</th>
            <th style="padding:7px 8px;border:1px solid #2d4a6a;"></th>
          </tr>
        </thead>
        <tbody>
          ${tokens.map(t => `
            <tr>
              <td style="padding:6px 8px;border:1px solid #2d4a6a;">
                <b>${t.display_name}</b><br>
                <span style="color:#5a7fa0;font-size:10px;">${t.username}</span>
              </td>
              <td style="padding:6px 8px;border:1px solid #2d4a6a;text-align:center;">${t.role}</td>
              <td style="padding:6px 8px;border:1px solid #2d4a6a;text-align:center;">${t.office_id}</td>
              <td style="padding:6px 8px;border:1px solid #2d4a6a;text-align:center;color:#90afc5;">${t.created_by||'—'}</td>
              <td style="padding:6px 8px;border:1px solid #2d4a6a;text-align:center;color:#90afc5;font-size:11px;">
                ${t.last_used ? t.last_used.slice(0,16) : '—'}
              </td>
              <td style="padding:6px 8px;border:1px solid #2d4a6a;text-align:center;">
                <button class="del-token-btn"
                  data-hint="${t.token_hint}"
                  style="padding:3px 8px;background:#dc3545;color:white;border:none;
                         border-radius:4px;cursor:pointer;font-size:11px;">🗑</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  // Кнопки удаления — нужен полный токен, но у нас только hint
  // Добавляем подтверждение
  container.querySelectorAll('.del-token-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const hint = btn.getAttribute('data-hint');
      if (!confirm(`Удалить токен ${hint}... ?`)) return;
      // Запрашиваем полный список и удаляем по hint
      showToast('⚠️ Для удаления используй полный токен пользователя', 'info');
    });
  });
}

// Отправить WS-сообщение через background.js
function wsSend(data) {
  if (bgPort) {
    try { bgPort.postMessage(data); return; } catch (err) {
      console.warn('[content] bgPort ошибка:', err);
    }
  }
  console.warn('[content] WS не подключён:', data.type);
}

// Центральный обработчик всех входящих WS-сообщений
function handleWsMessage(msg) {
  switch (msg.type) {

    case 'REGISTERED':
      myRole = msg.role;
      console.log('[content] Зарегистрирован:', msg.role, msg.displayName);
      updateOnlineIndicator(msg.online || []);
      myDisplayName = msg.displayName || myDisplayName || '';
      // Если авторизовались по extension_token — заполняем myUsername тоже
      if (!myUsername && msg.displayName) myUsername = msg.displayName;
      // Офис из токен-авторизации
      if (msg.officeId) store.set('myOfficeId', msg.officeId);
      updateRoleTag();
      // Показываем кнопку Токены только для админа
      if (typeof updateTokensBtnVisibility === 'function') updateTokensBtnVisibility();
      break;

    // Сервер не смог определить роль автоматически — показываем выбор вручную
    case 'NEED_ROLE':
      showRoleSelector(msg.validRoles || []);
      break;

    case 'TASKS_HISTORY':
      // История при входе — заполняем тихо, бейдж не трогаем.
      // Помечаем все как виденные чтобы при реконнекте не считать повторно.
      (msg.tasks || []).forEach(task => {
        if (task.id) seenTaskIds.add(task.id); // помечаем как виденные
        const tid = task.target_id || task.targetId;
        if (tid) {
          if (!tasksByTarget[tid] || task.id >= tasksByTarget[tid].id) {
            tasksByTarget[tid] = task;
          }
        }
        addTaskToPanel(task);
      });
      refreshAllTaskCells();
      refreshAllBadges();
      break;

    case 'USER_ONLINE':
    case 'USER_OFFLINE':
      updateOnlineIndicator(msg.online || []);
      showToast(`${msg.role} ${msg.type === 'USER_ONLINE' ? 'онлайн 🟢' : 'офлайн 🔴'}`, 'info');
      break;

    case 'UPDATE':
      // Другой расчёт обновил карту — перезагружаем данные
      console.log('📡 Обновление карты от:', msg.from);
      loadData();
      break;

    case 'NEW_TASK': {
      const isForMe = (msg.task.to_role || msg.task.to) === myRole;
      // Всплывашка и звук — только если задача адресована именно этому расчёту
      handleIncomingTask(msg.task, isForMe);
      refreshTaskCellByTargetId(msg.task);
      break;
    }

    case 'TASK_SENT':
      // Мы отправили задачу — тихо добавляем в свою панель без всплывашки
      addTaskToPanel(msg.task);
      refreshTaskCellByTargetId(msg.task);
      showToast(`✅ Задача → ${msg.task.to || msg.task.to_role}`, 'success');
      break;

    case 'TASK_UPDATED': {
      updateTaskInPanel(msg.task);
      refreshTaskCellByTargetId(msg.task);
      // Тост только если это наша задача (мы отправляли) и статус изменился
      const fromMe = (msg.task.from_role || msg.task.from) === myRole;
      if (fromMe) {
        const to     = msg.task.to_role || msg.task.to || '';
        const status = msg.task.status || '';
        showToast(`${to} → ${status}`, 'info');
      }
      break;
    }

    case 'TASK_UPDATE':
      updateTaskInPanel(msg.task);
      refreshTaskCellByTargetId(msg.task);
      refreshAllBadges();
      break;

    case 'DRAFT_EXISTS':
      console.log('[draft] Черновой план за', msg.planDate, '— добавляем кнопку');
      addDraftDateBtn(msg.planDate);
      break;

    case 'PLAN_CREATED':
      showToast(`📅 План на ${(msg.plan.plan_date||'').slice(8)}.${(msg.plan.plan_date||'').slice(5,7)} от ${msg.plan.created_by}`, 'info');
      if (activeFolderDate === msg.plan.plan_date) appendPlanRowToTable(msg.plan);
      updatePlanDateInPlanning(msg.plan);
      addDraftDateBtn(msg.plan.plan_date);
      break;

    case 'PLANS_FOR_DATE':
      (msg.plans || []).forEach(plan => appendPlanRowToTable(plan));
      if (msg.plans?.length > 0) updatePublishBtn(activeFolderDate);
      break;

    case 'PLAN_DELETED': {
      const pRow = document.querySelector(`#statusTable tr[data-plan-id="${msg.planId}"]`);
      if (pRow) pRow.remove();
      break;
    }

    case 'DRAFT_PLANS':
      if (window._pendingPublish && window._pendingPublish.planDate === msg.planDate) {
        const { planDate, folderId } = window._pendingPublish;
        window._pendingPublish = null;
        executePlanPublish(planDate, msg.plans, folderId);
      }
      break;

    case 'PLAN_PUBLISHED': {
      const pRow2 = document.querySelector(`#planningPanel tr[data-target-id="${msg.plan?.target_id}"]`);
      if (pRow2 && pRow2.cells[5]) pRow2.cells[5].innerHTML = '<span style="color:#28a745;font-size:11px;">✅ опубликовано</span>';
      break;
    }

    case 'PENDING_TASKS': {
      // Задачи накопились пока были офлайн — тихо добавляем в таблицу.
      // Считаем только те которых ещё не видели (защита от дублей при реконнекте).
      let newCount = 0;
      (msg.tasks || []).forEach(task => {
        const isNew = !seenTaskIds.has(task.id);
        if (task.id) seenTaskIds.add(task.id);
        addTaskToPanel(task);
        refreshTaskCellByTargetId(task);
        if (isNew) newCount++;
      });
      if (newCount > 0) {
        unreadTaskCount += newCount;
        updateTaskBadge();
        showToast(`📋 ${newCount} непрочитанных задач`, 'info');
      }
      break;
    }

    case 'ERROR':
      console.error('Ошибка от сервера:', msg.text);
      showToast('Ошибка: ' + msg.text, 'error');
      // Если токен неверный — показываем форму ввода снова
      if (msg.text && msg.text.includes('Недействительный токен')) {
        localStorage.removeItem('extension_token');
        setTimeout(() => showTokenInputModal(), 500);
      }
      break;

    case 'TOKEN_GENERATED':
      handleTokenGenerated(msg);
      break;

    case 'TOKENS_LIST':
      renderTokensList(msg.tokens);
      break;

    case 'TOKEN_DELETED':
      showToast('✅ Токен удалён', 'success');
      wsSend({ type: 'LIST_TOKENS' });
      break;
  }
}

// ── Обработка входящей задачи ─────────────────────────────────────────────────
// notify=true  → задача пришла прямо сейчас, показываем всплывашку и звук
// notify=false → история/pending при входе, тихо добавляем в таблицу
function handleIncomingTask(task, notify = true) {
  const taskId = task.id;
  const alreadySeen = seenTaskIds.has(taskId);
  if (taskId) seenTaskIds.add(taskId);

  addTaskToPanel(task);

  // Считаем и уведомляем только если задача новая (не видели раньше)
  if (notify && !alreadySeen) {
    unreadTaskCount++;
    updateTaskBadge();
    renderTaskNotification(task);
    playNotificationSound();
  }
}

// ── Рендер ячейки «Назначить задачу» в основной таблице ─────────────────────────
// Показывает текущую активную задачу по цели (видят все) + кнопку назначить новую.
function renderTaskCell(cell, targetId, targetTitle, canAssign = true) {
  const task = tasksByTarget[targetId] || null;

  const FINAL = ['поражена', 'не поражена', 'подтверждено', 'подавлено', 'отклонена'];
  const STATUS_COLOR = {
    'новая':         '#fd7e14',
    'принята':       '#17a2b8',
    'в работе':      '#007bff',
    'поражена':      '#28a745',
    'не поражена':   '#dc3545',
    'доразведка':    '#6f42c1',
    'подтверждено':  '#28a745',
    'подавлено':     '#20c997',
    'отклонена':     '#6c757d',
  };

  // Очищаем ячейку
  cell.innerHTML = '';

  if (task) {
    // Есть задача — показываем кому и статус (без кнопки создания)
    const color  = STATUS_COLOR[task.status] || '#888';
    const toRole = task.to_role || task.to || '?';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;';

    const toDiv = document.createElement('div');
    toDiv.style.cssText = 'font-size:11px;color:#555;';
    toDiv.innerHTML = `→ <b>${toRole}</b>`;
    wrap.appendChild(toDiv);

    const badge = document.createElement('span');
    badge.style.cssText = `background:${color};color:white;padding:1px 8px;border-radius:10px;font-size:11px;white-space:nowrap;`;
    badge.textContent = task.status;
    wrap.appendChild(badge);

    cell.appendChild(wrap);
  } else {
    if (canAssign) {
      // Текущий день — кнопка активна
      const btn = document.createElement('button');
      btn.style.cssText = 'padding:4px 10px;background:#fd7e14;color:white;border:none;border-radius:5px;cursor:pointer;font-size:12px;white-space:nowrap;';
      btn.textContent = '+ Задача';
      btn.addEventListener('click', () => openNewTaskModal(targetId, targetTitle));
      cell.appendChild(btn);
    } else {
      // Прошедший день — не активна
      cell.innerHTML = '<span style="color:#ccc;font-size:11px;">—</span>';
    }
  }
}

// Открыть модал новой задачи с предзаполненной целью
function openNewTaskModal(targetId, targetTitle) {
  if (!myRole) { showToast('Сначала войдите — расчёт не определён', 'error'); return; }

  const modal = document.querySelector('#newTaskModal');
  if (!modal) return;

  // Предзаполняем цель
  const targetSelect = modal.querySelector('#taskTargetSelect');
  if (targetSelect) {
    // Обновляем список из текущей таблицы
    targetSelect.innerHTML = '<option value="">— без привязки к цели —</option>';
    document.querySelectorAll('#statusTable tbody tr').forEach(row => {
      const id    = row.cells[0]?.innerText.trim();
      const title = row.cells[1]?.querySelector('select')?.value || '';
      const opt   = document.createElement('option');
      opt.value   = id;
      opt.textContent = `#${id} ${title}`;
      if (id === String(targetId)) opt.selected = true;
      targetSelect.appendChild(opt);
    });
  }

  // Показываем модал (переключаем на вкладку целей если нужно)
  const tasksPanel   = document.querySelector('#tasksPanel');
  const tableWrapper = document.querySelector('.table-wrapper');
  if (tasksPanel && tasksPanel.style.display !== 'none') {
    // Уже на вкладке задач — просто открываем модал
  } else {
    // Переключаемся на вкладку задач
    if (tasksPanel)   { tasksPanel.style.display = 'flex'; tasksPanel.style.flexDirection = 'column'; }
    if (tableWrapper) tableWrapper.style.display = 'none';
    const btn = document.querySelector('#showTasksBtn');
    if (btn) btn.textContent = '🗺️ Цели';
  }

  modal.style.display = 'flex';
}

// ── Бейдж непоражённых целей на вкладке даты ────────────────────────────────
function updateUndefeatedBadge(date, rows) {
  const DEFEATED = ['поражена', 'подтверждено', 'подавлено'];
  const count = rows.filter(r => !DEFEATED.includes(r.result)).length;
  const badge = document.querySelector(`.date-undefeated-badge[data-date="${date}"]`);
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

// Загрузить цели за все даты в фоне и обновить бейджи
async function loadAllDatesBadgesInBackground() {
  try {
    const tree  = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
    const dates = tree?.dates || [];
    if (!dates.length) return;
    console.log(`[badges] Фоновая загрузка бейджей для ${dates.length} дат...`);
    // Загружаем по 3 параллельно — не перегружаем API
    const BATCH = 3;
    for (let i = 0; i < dates.length; i += BATCH) {
      const batch = dates.slice(i, i + BATCH);
      await Promise.all(batch.map(async d => {
        try {
          const cacheKey   = CACHE_KEY_PREFIX + d.date;
          const cachedData = JSON.parse(localStorage.getItem(cacheKey) || 'null');
          let rows;
          if (cachedData?.rows?.length > 0) {
            rows = cachedData.rows; // из кэша мгновенно
          } else {
            rows = await loadTargetsFromFolder(d.folderIds || d.folderId, d.date);
          }
          if (rows?.length > 0) updateUndefeatedBadge(d.date, rows);
        } catch {}
      }));
    }
    console.log('[badges] Готово');
  } catch {}
}

// Обновить счётчик непоражённых в astra_dates_tree для конкретной даты
function updateUndefeatedCountInTree(dateKey, rows) {
  try {
    const DEFEATED = ['поражена', 'подтверждено', 'подавлено'];
    const count    = rows.filter(r => !DEFEATED.includes(r.result)).length;
    const tree     = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
    if (!tree?.dates) return;

    const idx = tree.dates.findIndex(d => d.date === dateKey);
    if (idx >= 0) {
      tree.dates[idx].undefeatedCount = count;
      localStorage.setItem(CACHE_KEY_DATES, JSON.stringify(tree));
    }
  } catch {}
}

// Инициализация бейджей из кэша при загрузке страницы
// Сначала быстро из счётчика в дереве, потом уточняем из кэша целей
async function initBadgesFromCache() {
  try {
    const tree  = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
    const dates = tree?.dates || [];

    for (const d of dates) {
      const badge = document.querySelector(`.date-undefeated-badge[data-date="${d.date}"]`);
      if (!badge) continue;

      // Быстрый путь — счётчик уже сохранён в дереве
      if (typeof d.undefeatedCount === 'number') {
        if (d.undefeatedCount > 0) {
          badge.textContent    = d.undefeatedCount;
          badge.style.display  = 'inline-flex';
          badge.style.background = '#e53e3e';
          badge.title          = `Непоражённых целей: ${d.undefeatedCount}`;
        } else {
          badge.style.display = 'none';
        }
      }

      // Уточняем из полного кэша целей (учитывает задачи)
      try {
        const cachedRows = JSON.parse(localStorage.getItem(CACHE_KEY_PREFIX + d.date) || 'null');
        if (cachedRows?.rows?.length > 0) {
          updateUndefeatedBadge(d.date, cachedRows.rows);
        }
      } catch {}
    }
  } catch {}
}

// Обновить все бейджи при изменении задач (из кэша)
function refreshAllBadges() {
  document.querySelectorAll('.date-undefeated-badge').forEach(badge => {
    const date = badge.getAttribute('data-date');
    if (!date) return;
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY_PREFIX + date) || 'null');
      if (cached?.rows) updateUndefeatedBadge(date, cached.rows);
    } catch {}
  });
}


// ── Панель Планирование — все непоражённые цели по всем датам ────────────────
async function loadPlanningTargets() {
  const panel = document.querySelector('#planningPanel');
  if (!panel) return;

  panel.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">⏳ Загружаем...</div>';

  try {
    // Берём все даты из кэша
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
    const dates  = cached?.dates || [];

    if (!dates.length) {
      panel.innerHTML = '<div style="padding:20px;color:#666;">Нет данных. Сначала загрузи даты.</div>';
      return;
    }

    const DEFEATED = ['поражена', 'подтверждено', 'подавлено'];
    let allUndefeated = [];

    // Загружаем из всех дат (из кэша если есть)
    for (const d of dates) {
      try {
        const rows = await loadTargetsFromFolder(d.folderIds || d.folderId, d.date);
        const undefeated = rows
          .filter(r => !DEFEATED.includes(r.result))
          .map(r => ({ ...r, _date: d.date }));
        allUndefeated = allUndefeated.concat(undefeated);
      } catch {}
    }

    // Сортируем: свежие даты сверху
    allUndefeated.sort((a, b) => b._date.localeCompare(a._date));

    if (!allUndefeated.length) {
      panel.innerHTML = '<div style="padding:20px;color:#28a745;text-align:center;">✅ Все цели поражены</div>';
      return;
    }

    // Рендерим таблицу
    panel.innerHTML = `
      <div style="padding:8px 12px;font-size:13px;color:#555;border-bottom:1px solid #e0e0e0;">
        Непоражённые цели: <b>${allUndefeated.length}</b>
      </div>
      <div style="overflow-y:auto;flex:1;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:#f0f4f8;position:sticky;top:0;">
              <th style="padding:6px 8px;border:1px solid #d0d7de;">Дата</th>
              <th style="padding:6px 8px;border:1px solid #d0d7de;">№</th>
              <th style="padding:6px 8px;border:1px solid #d0d7de;">Характеристика</th>
              <th style="padding:6px 8px;border:1px solid #d0d7de;">Координаты X/Y</th>
              <th style="padding:6px 8px;border:1px solid #d0d7de;">Результат</th>
              <th style="padding:6px 8px;border:1px solid #d0d7de;">Задача</th>
            </tr>
          </thead>
          <tbody>
            ${allUndefeated.map(r => `
              <tr data-row-date="${r._date}" data-target-id="${r.targetNumber}">
                <td style="padding:5px 8px;border:1px solid #d0d7de;color:#888;font-size:11px;white-space:nowrap;">
                  ${r._date.slice(5).replace('-','.')}<br>
                  <span style="font-size:10px;">${r.impactTime || '--:--'}</span>
                </td>
                <td style="padding:5px 8px;border:1px solid #d0d7de;">${r.targetNumber}</td>
                <td style="padding:5px 8px;border:1px solid #d0d7de;">${r.characteristic}</td>
                <td style="padding:5px 8px;border:1px solid #d0d7de;font-size:11px;">${r.coordX} / ${r.coordY}</td>
                <td style="padding:5px 8px;border:1px solid #d0d7de;">
                  <span style="background:#fd7e14;color:white;padding:1px 6px;border-radius:8px;font-size:10px;">${r.result}</span>
                </td>
                <td style="padding:5px 8px;border:1px solid #d0d7de;text-align:center;font-size:11px;color:#2563eb;font-weight:500;">
                  —
                </td>
                <td style="padding:5px 8px;border:1px solid #d0d7de;text-align:center;">
                  <a href="https://center.astramaps.ru/map/${r.targetNumber}"
                    target="_blank" rel="noopener noreferrer"
                    style="display:inline-block;padding:4px 8px;background:#2c7da0;color:white;border-radius:4px;font-size:14px;text-decoration:none;">👁️</a>
                </td>
                <td style="padding:5px 8px;border:1px solid #d0d7de;text-align:center;">
                  <div style="display:flex;flex-direction:column;gap:3px;align-items:center;">
                    <button
                      data-target-id="${r.targetNumber}"
                      data-target-title="${r.characteristic}"
                      data-plan-date="${getMoscowDateStr()}"
                      data-coord-x="${r.coordX || ''}"
                      data-coord-y="${r.coordY || ''}"
                      data-impact-time="${r.impactTime || ''}"
                      data-defeat-date="${r._date || ''}"
                      class="planning-task-btn"
                      style="padding:3px 8px;background:#17a2b8;color:white;border:none;border-radius:4px;cursor:pointer;font-size:10px;white-space:nowrap;">
                      📅 Сегодня
                    </button>
                    <button
                      data-target-id="${r.targetNumber}"
                      data-target-title="${r.characteristic}"
                      data-plan-date="${(() => { const t = new Date(Date.now()+3*3600000+86400000); return t.toISOString().slice(0,10); })()}"
                      data-coord-x="${r.coordX || ''}"
                      data-coord-y="${r.coordY || ''}"
                      data-impact-time="${r.impactTime || ''}"
                      data-defeat-date="${r._date || ''}"
                      class="planning-task-btn"
                      style="padding:3px 8px;background:#fd7e14;color:white;border:none;border-radius:4px;cursor:pointer;font-size:10px;white-space:nowrap;">
                      📅 Завтра
                    </button>
                  </div>
                </td>
                <td style="padding:5px 8px;border:1px solid #d0d7de;text-align:center;">
                  <button class="planning-delete-btn"
                    data-target-id="${r.targetNumber}"
                    style="padding:3px 8px;background:#dc3545;color:white;border:none;border-radius:4px;cursor:pointer;font-size:11px;">🗑</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    // Обработчик кнопки удалить
    panel.querySelectorAll('.planning-delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const targetId = btn.getAttribute('data-target-id');
        if (!confirm(`Удалить цель ${targetId} из AstraMap?`)) return;
        await deleteTargetFromAstraMap(targetId);
      });
    });

    // Навешиваем обработчики кнопок планирования
    panel.querySelectorAll('.planning-task-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!myRole) { showToast('Сначала войдите — расчёт не определён', 'error'); return; }

        const targetId    = btn.getAttribute('data-target-id');
        const targetTitle = btn.getAttribute('data-target-title');
        let   planDate    = btn.getAttribute('data-plan-date');

        // Если выбрать дату вручную
        // Проверяем что дата не в прошлом
        const today = getMoscowDateStr();
        if (planDate !== 'pick' && planDate < today) {
          showToast('❌ Нельзя планировать на прошедшую дату', 'error');
          return;
        }

        if (planDate === 'pick') {
          const tomorrow = new Date(Date.now() + 3*3600000 + 86400000).toISOString().slice(0,10);
          planDate = await showDatePickerModal(tomorrow);
          if (!planDate) return;
        }

        // Собираем данные цели из строки для передачи в БД
        const row     = btn.closest('tr');
        const rowDate = row?.getAttribute('data-row-date');

        // Данные берём из data-атрибутов кнопки — точные значения без зависимости от структуры таблицы
        const rowData = {
          targetNumber:   targetId,
          characteristic: targetTitle,
          coordX:         btn.getAttribute('data-coord-x') || '',
          coordY:         btn.getAttribute('data-coord-y') || '',
          impactTime:     btn.getAttribute('data-impact-time') || '',
          result:         'вскрыто',
          defeatDate:     btn.getAttribute('data-defeat-date') || rowDate || '',
        };
        await planTargetForDate(targetId, targetTitle, planDate, rowData);
      });
    });

  } catch (err) {
    console.error('[planning]', err);
    panel.innerHTML = '<div style="padding:20px;color:#dc3545;">Ошибка загрузки</div>';
  }
}

// ── Перенос задачи на другой день ────────────────────────────────────────────
function showRescheduleModal(taskId) {
  document.querySelector('#rescheduleModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'rescheduleModal';
  modal.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.6);
    display:flex;align-items:center;justify-content:center;z-index:10002;
    font-family:system-ui,sans-serif;
  `;

  // Минимальная дата — завтра по МСК
  const tomorrow = new Date(Date.now() + 3*60*60*1000 + 24*60*60*1000)
    .toISOString().slice(0,10);

  modal.innerHTML = `
    <div style="background:white;border-radius:10px;padding:24px;width:90%;max-width:360px;">
      <h3 style="margin:0 0 16px;font-size:16px;">📅 Перенести задачу</h3>
      <label style="font-size:13px;color:#555;display:block;margin-bottom:6px;">
        Выберите новую дату выполнения:
      </label>
      <input id="rescheduleDate" type="date" min="${tomorrow}"
        style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;
               font-size:14px;box-sizing:border-box;" />
      <div style="margin-top:8px;font-size:12px;color:#888;">
        Нельзя выбрать прошедшую дату
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
        <button id="cancelReschedule"
          style="padding:7px 16px;border:1px solid #ccc;border-radius:6px;
                 cursor:pointer;background:white;">Отмена</button>
        <button id="confirmReschedule"
          style="padding:7px 16px;background:#2563eb;color:white;border:none;
                 border-radius:6px;cursor:pointer;font-weight:600;">Перенести</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  modal.querySelector('#cancelReschedule').addEventListener('click', () => modal.remove());

  modal.querySelector('#confirmReschedule').addEventListener('click', () => {
    const date = modal.querySelector('#rescheduleDate').value;
    if (!date) { showToast('Выберите дату', 'error'); return; }
    if (date < tomorrow) { showToast('Нельзя выбрать прошедшую дату', 'error'); return; }

    wsSend({ type: 'UPDATE_TASK', taskId, status: 'перенесена', rescheduleDate: date });
    showToast(`Задача перенесена на ${date.slice(8)}.${date.slice(5,7)}`, 'info');
    modal.remove();
  });
}

function updatePlanDateInPlanning(plan) {
  const parts     = (plan.plan_date || '').split('-');
  const dateShort = parts.length === 3 ? `${parts[2]}.${parts[1]}` : plan.plan_date;
  // Ищем строку по targetId в любой таблице (панель может быть скрыта но строка есть)
  const row = document.querySelector(`tr[data-target-id="${plan.target_id}"]`);
  if (row && row.cells[5]) {
    row.cells[5].innerHTML = `<span style="color:#2563eb;font-weight:600;font-size:12px;">${dateShort}</span>`;
  }
}

function loadPlansForDate(date) {
  if (!myRole) return; // не подключены — пропускаем
  wsSend({ type: 'GET_PLANS', planDate: date });
}


function appendPlanRowToTable(plan) {
  const tbody = document.querySelector('#statusTable tbody');
  if (!tbody) return;

  // Не дублируем если план уже показан
  if (tbody.querySelector(`[data-plan-id="${plan.id}"]`)) return;

  // Не добавляем если объект уже загружен из AstraMap (опубликованный план)
  // Проверяем по номеру цели в обычных строках таблицы
  const existingRows = tbody.querySelectorAll('tr:not([data-plan-id])');
  for (const row of existingRows) {
    if (row.cells[0]?.textContent?.trim() === String(plan.target_id)) return;
  }

  let data = {};
  try { data = JSON.parse(plan.target_data); } catch {}

  const parts     = (plan.plan_date || '').split('-');
  const dateShort = parts.length === 3 ? `${parts[2]}.${parts[1]}` : plan.plan_date;

  const row = tbody.insertRow(0);
  row.setAttribute('data-plan-id', plan.id);
  row.style.background = 'rgba(37,99,235,0.08)';
  row.style.borderLeft = '3px solid #2563eb';

  // Колонки должны совпадать с заголовком таблицы:
  // 0: Номер цели
  // 1: Характеристика цели
  // 2: X координата
  // 3: Y координата
  // 4: Время обнаружения
  // 5: Результат
  // 6: Дата обнаружения
  // 7: Просмотр в AstraM
  // 8: Назначить задачу
  // 9: Сформировать формуляр / удалить

  // Новая структура: 0:Дата 1:№ 2:Характер 3:Место 4:X 5:Y 6:Просмотр 7:Результат 8:Задача 9:Дата уничт. 10:Формуляр
  const cols = [
    { val: `<span style="font-size:11px;">${dateShort}</span>` },              // 0 дата
    { val: data.targetNumber || plan.target_id },                               // 1 номер
    { val: data.characteristic || '' },                                         // 2 характер
    { val: '' },                                                                // 3 место
    { val: data.coordX || '' },                                                 // 4 X
    { val: data.coordY || '' },                                                 // 5 Y
    { val: `<a href="https://center.astramaps.ru/map/${plan.target_id}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:4px 8px;background:#2c7da0;color:white;border-radius:4px;font-size:12px;text-decoration:none;">👁️</a>` }, // 6
    { val: `<span style="background:#e0e7ff;color:#2563eb;padding:2px 8px;border-radius:8px;font-size:11px;">📅 план на ${dateShort}</span>` }, // 7 результат
    { val: plan.created_by || '' },                                             // 8 задача
    { val: data.defeatDate || '' },                                             // 9 дата уничт.
    { val: '' },                                                                // 10 формуляр
  ];

  cols.forEach((col, i) => {
    const td = row.insertCell(i);
    td.style.cssText = 'padding:5px 8px;font-size:12px;text-align:center;vertical-align:middle;';
    td.innerHTML = String(col.val);
  });

  // Кнопка удаления в последней колонке
  const delBtn = document.createElement('button');
  delBtn.textContent = '✕';
  delBtn.style.cssText = 'padding:3px 8px;background:#dc3545;color:white;border:none;border-radius:4px;cursor:pointer;font-size:11px;';
  delBtn.addEventListener('click', () => wsSend({ type: 'DELETE_PLAN', planId: plan.id }));
  row.cells[10].appendChild(delBtn);
}

// Блокировать кнопки задач для прошедших дат
function disableTaskButtonsIfPast() {
  const today = getMoscowDateStr();
  if (!activeFolderDate || activeFolderDate >= today) return;
  document.querySelectorAll('#statusTable .task-cell button').forEach(btn => {
    btn.disabled = true;
    btn.style.opacity = '0.35';
    btn.style.cursor  = 'not-allowed';
    btn.title = 'Недоступно для прошедших дат';
  });
}

// ── Перерисовать все ячейки задач в таблице целей (после загрузки истории)
function refreshAllTaskCells() {
  document.querySelectorAll('#statusTable tbody tr').forEach(row => {
    const targetId = row.getAttribute('data-target-id');
    if (!targetId) return;
    const cell  = row.querySelector('.task-cell');
    const title = row.querySelector('.char-cell select')?.value || '';
    if (cell) renderTaskCell(cell, targetId, title);
  });
}

// Обновить ячейку задачи в таблице целей при изменении статуса
function refreshTaskCellByTargetId(task) {
  const targetId = task.target_id || task.targetId;
  if (!targetId) return;

  // Сохраняем актуальную задачу
  const existing = tasksByTarget[targetId];
  const FINAL = ['поражена', 'не поражена', 'подтверждено', 'подавлено', 'отклонена'];
  // Обновляем только если новая задача или изменился статус
  if (!existing || task.id >= existing.id) {
    tasksByTarget[targetId] = task;
  }

  // Находим ячейку в таблице и перерисовываем
  const cell = document.querySelector(`#statusTable td[data-target-id="${targetId}"]`);
  if (cell) {
    const row   = cell.closest('tr');
    const title = row?.querySelector('.char-cell select')?.value || '';
    renderTaskCell(cell, targetId, title);
  }
}

// ── Ручной выбор расчёта (если сервер не смог определить автоматически) ────────
function showRoleSelector(validRoles) {
  // Убираем старый селектор если есть
  document.querySelector('#manual-role-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'manual-role-modal';
  modal.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center; z-index: 100000;
    font-family: system-ui, sans-serif;
  `;
  modal.innerHTML = `
    <div style="background:white;border-radius:12px;padding:24px;width:320px;text-align:center;">
      <h3 style="margin:0 0 8px;color:#1e3a5f;">Выберите свой расчёт</h3>
      <p style="font-size:13px;color:#666;margin:0 0 16px;">
        Не удалось определить автоматически из профиля AstraMap
      </p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${validRoles.map(r => `
          <button onclick="selectRoleManually('${r}')"
            style="padding:10px;background:#1e3a5f;color:white;border:none;
                   border-radius:6px;cursor:pointer;font-size:14px;text-align:left;">
            ${r.charAt(0).toUpperCase() + r.slice(1)}
          </button>`).join('')}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function selectRoleManually(role) {
  document.querySelector('#manual-role-modal')?.remove();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const token = getToken();
  // Отправляем снова с явным role как запасным вариантом
  ws.send(JSON.stringify({ type: 'REGISTER', token, role }));
}

// ── Звуковое уведомление ──────────────────────────────────────────────────────
function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch {}
}

// ── Всплывающее уведомление (toast) ───────────────────────────────────────────
function showToast(text, type = 'info') {
  const colors = { info: '#17a2b8', success: '#28a745', error: '#dc3545', task: '#fd7e14' };
  const toast = document.createElement('div');
  toast.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 99999;
    background: ${colors[type] || colors.info}; color: white;
    padding: 12px 18px; border-radius: 8px; font-size: 14px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3); max-width: 320px;
    animation: slideInToast 0.3s ease; font-family: system-ui, sans-serif;
  `;
  toast.textContent = text;
  if (!document.querySelector('#toast-style')) {
    const s = document.createElement('style');
    s.id = 'toast-style';
    s.textContent = '@keyframes slideInToast{from{transform:translateX(120%)}to{transform:translateX(0)}}';
    document.head.appendChild(s);
  }
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Уведомление о новой задаче (большой попап) ────────────────────────────────
function renderTaskNotification(task) {
  const el = document.createElement('div');
  el.style.cssText = `
    position: fixed; top: 80px; right: 20px; z-index: 99998;
    background: white; border-left: 4px solid #fd7e14;
    border-radius: 8px; padding: 16px 20px; width: 300px;
    box-shadow: 0 6px 24px rgba(0,0,0,0.2); font-family: system-ui, sans-serif;
    animation: slideInToast 0.3s ease;
  `;
  const fromName = task.from_role || task.from || '?';
  const targetHint = task.targetTitle || task.target_title || '';

  el.innerHTML = `
    <div style="font-weight:600;color:#fd7e14;margin-bottom:6px;">📋 Новая задача от: ${fromName}</div>
    <div style="font-size:13px;color:#333;margin-bottom:4px;">${task.text}</div>
    ${targetHint ? `<div style="font-size:12px;color:#666;">Объект: ${targetHint}</div>` : ''}
    <div style="display:flex;gap:8px;margin-top:12px;">
      <button class="notif-accept" style="flex:1;padding:6px;background:#28a745;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">✅ Принять</button>
      <button class="notif-reject" style="flex:1;padding:6px;background:#dc3545;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">❌ Отклонить</button>
    </div>
  `;

  // addEventListener вместо onclick — content.js изолирован от window страницы
  el.querySelector('.notif-accept').addEventListener('click', () => {
    acceptTask(task.id);
    el.remove();
  });
  el.querySelector('.notif-reject').addEventListener('click', () => {
    rejectTask(task.id);
    el.remove();
  });

  document.body.appendChild(el);
  setTimeout(() => el.remove(), 15000);
}

// ── Принять/отклонить задачу ──────────────────────────────────────────────────
function acceptTask(taskId) {
  wsSend({ type: 'UPDATE_TASK', taskId, status: 'принята' });
  unreadTaskCount = Math.max(0, unreadTaskCount - 1);
  updateTaskBadge();
  showToast('Задача принята', 'success');
}
function rejectTask(taskId) {
  wsSend({ type: 'UPDATE_TASK', taskId, status: 'отклонена' });
  unreadTaskCount = Math.max(0, unreadTaskCount - 1);
  updateTaskBadge();
  showToast('Задача отклонена', 'info');
}

// ── Обновление плашки имени/расчёта в шапке ─────────────────────────────────────
function updateRoleTag() {
  const tag = document.querySelector('#myRoleTag');
  if (!tag) return; // попап ещё не создан — ничего страшного
  if (myRole && myDisplayName) {
    tag.textContent = `${myDisplayName} [${myRole}]`;
    tag.style.background = '#1a5276'; // чуть ярче когда определён
  } else {
    tag.textContent = '🔄 Определяю расчёт...';
  }
}

// ── Индикатор онлайн-расчётов ─────────────────────────────────────────────────
function updateOnlineIndicator(onlineRoles) {
  const el = document.querySelector('#online-indicator');
  if (!el) return;
  const allRoles = ['разведка', 'рэб', 'инженеры', 'артиллерия', 'бпс', 'админ', 'гооп', 'босс', '177 огвпмп'];
  el.innerHTML = allRoles.map(r =>
    `<span title="${r}" style="display:inline-flex;align-items:center;gap:3px;font-size:11px;margin-right:6px;color:${onlineRoles.includes(r) ? '#28a745' : '#aaa'};">
      <span style="width:7px;height:7px;border-radius:50%;background:${onlineRoles.includes(r) ? '#28a745' : '#ccc'};display:inline-block;"></span>${r}
    </span>`
  ).join('');
}

// ── Бейдж непрочитанных задач ─────────────────────────────────────────────────
function updateTaskBadge() {
  const badge = document.querySelector('#task-badge');
  if (!badge) return;
  badge.textContent = unreadTaskCount || '';
  badge.style.display = unreadTaskCount > 0 ? 'flex' : 'none';
}

// ── Панель задач: добавить задачу ─────────────────────────────────────────────
function addTaskToPanel(task) {
  const tbody = document.querySelector('#tasksTable tbody');
  if (!tbody) return;
  const existing = tbody.querySelector(`[data-task-id="${task.id}"]`);
  if (existing) { updateTaskRowEl(existing, task); return; }
  // Нормализуем поля для единообразия
  if (!task.from && task.from_role) task.from = task.from_role;
  if (!task.to   && task.to_role)   task.to   = task.to_role;
  const row = renderTaskRow(task);
  tbody.insertBefore(row, tbody.firstChild); // новые сверху
}

// ── Панель задач: обновить задачу ────────────────────────────────────────────
function updateTaskInPanel(task) {
  const tbody = document.querySelector('#tasksTable tbody');
  if (!tbody) return;
  const existing = tbody.querySelector(`[data-task-id="${task.id}"]`);
  if (existing) updateTaskRowEl(existing, task);
  else addTaskToPanel(task);
}

const STATUS_COLORS = {
  'новая':       '#fd7e14',
  'принята':     '#17a2b8',
  'в работе':    '#007bff',
  'выполнена':   '#28a745',
  'поражена':    '#28a745',
  'не поражена': '#dc3545',
  'доразведка':  '#6f42c1',
  'подтверждено':'#28a745',
  'подавлено':   '#20c997',
  'перенесена':  '#0097a7',
  'отклонена':   '#6c757d',
};

function renderTaskRow(task) {
  const tr = document.createElement('tr');
  tr.setAttribute('data-task-id', task.id);
  updateTaskRowEl(tr, task);
  return tr;
}

function updateTaskRowEl(tr, task) {
  const color = STATUS_COLORS[task.status] || '#888';

  // Поля могут называться from_role/to_role (из SQLite) или from/to (при трансляции)
  const fromRole = task.from_role || task.from || '?';
  const toRole   = task.to_role   || task.to   || '?';

  const isMyTask = toRole === myRole;
  const dateStr  = task.created_at || task.createdAt || '';
  const time     = dateStr
    ? new Date(dateStr).toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'})
    : '';

  // Статусы-ответы для колонки «Действие» — формализованные результаты
  const ACTION_STATUSES = [
    { value: 'принята',            label: '✅ Принята' },
    { value: 'в работе',           label: '🔄 В работе' },
    { value: 'поражена',           label: '💥 Поражена' },
    { value: 'не поражена',        label: '❌ Не поражена' },
    { value: 'доразведка',         label: '🔍 Проводится доразведка' },
    { value: 'подтверждено',       label: '✔️ Подтверждено' },
    { value: 'подавлено',          label: '📡 Подавлено' },
    { value: 'отклонена',          label: '🚫 Отклонить' },
  ];

  const canAct = isMyTask && !['поражена','не поражена','подтверждено','подавлено','отклонена'].includes(task.status);

  // actionCell строим после innerHTML через DOM — onchange в innerHTML не работает
  // в изолированном контексте расширения
  tr.innerHTML = `
    <td style="font-size:12px;color:#666;padding:6px 8px;">${time}</td>
    <td style="font-size:12px;padding:6px 8px;font-weight:500;">${fromRole}</td>
    <td style="font-size:12px;padding:6px 8px;font-weight:500;">${toRole}</td>
    <td style="font-size:12px;padding:6px 8px;">
      ${task.text}
      ${task.targetTitle ? `<br><span style="color:#888;font-size:11px;">📍 ${task.targetTitle}</span>` : ''}
      ${task.target_title && !task.targetTitle ? `<br><span style="color:#888;font-size:11px;">📍 ${task.target_title}</span>` : ''}
    </td>
    <td style="padding:6px 8px;">
      <span style="background:${color};color:white;padding:2px 8px;border-radius:10px;font-size:11px;white-space:nowrap;">
        ${task.status}
      </span>
    </td>
    <td style="padding:6px 8px;" class="task-action-cell"></td>
  `;

  // Строим ячейку действия через DOM после установки innerHTML
  const actionTd = tr.querySelector('.task-action-cell');
  if (canAct) {
    const sel = document.createElement('select');
    sel.style.cssText = 'font-size:11px;padding:3px 6px;border-radius:4px;border:1px solid #ccc;cursor:pointer;';
    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = '— ответ —';
    sel.appendChild(defOpt);
    ACTION_STATUSES.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.value;
      opt.textContent = s.label;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function() {
      if (this.value) changeTaskStatus(task.id, this.value);
    });
    actionTd.appendChild(sel);
  } else {
    actionTd.innerHTML = `<span style="font-size:11px;color:#888;">${isMyTask ? task.status : '—'}</span>`;
  }
}

function changeTaskStatus(taskId, status) {
  if (!status) return;
  wsSend({ type: 'UPDATE_TASK', taskId, status });
}

// Московское время = UTC+3.
// Пользователь вводит время в московской зоне — вычитаем 3 часа для получения UTC.
function toISOWithTime(dateStr, timeStr) {
  try {
    if (!dateStr) {
      // Нет даты — берём текущий момент в московском времени и отдаём UTC
      return getMoscowNowISO();
    }
    const time = timeStr && timeStr.trim() ? timeStr : "00:00";
    // Парсим как московское: создаём дату в UTC, затем вычитаем смещение МСК (3 часа)
    const [hours, minutes] = time.split(':').map(Number);
    const [year, month, day] = dateStr.split('-').map(Number);
    // Date.UTC — всегда UTC, поэтому добавляем смещение МСК вручную
    const utcMs = Date.UTC(year, month - 1, day, hours - 3, minutes, 0, 0);
    return new Date(utcMs).toISOString();
  } catch {
    return getMoscowNowISO();
  }
}

// Возвращает текущий момент как ISO-строку UTC (для внутреннего использования)

// Перевод UTC ISO строки в МСК время HH:MM (UTC+3)
function utcIsoToMskTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    const mskMs = d.getTime() + 3 * 60 * 60 * 1000;
    const msk   = new Date(mskMs);
    return msk.toISOString().slice(11, 16);
  } catch { return ''; }
}

// Перевод UTC ISO строки в МСК дату YYYY-MM-DD
function utcIsoToMskDate(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    const mskMs = d.getTime() + 3 * 60 * 60 * 1000;
    return new Date(mskMs).toISOString().slice(0, 10);
  } catch { return ''; }
}
function getMoscowNowISO() {
  return new Date().toISOString();
}

// Возвращает текущую дату в московском часовом поясе в формате YYYY-MM-DD
function getMoscowDateStr() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
}

// Возвращает текущее время в московском часовом поясе в формате HH:MM
function getMoscowTimeStr() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000)
    .toISOString().slice(11, 16);
}

async function getTargetById(id) {
  const token = getToken(); // ✅ FIX: используем функцию

  const res = await fetch(ASTRA_API.search, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ ids: [id], maxDepth: 1 })
  });

  const data = await res.json();
  return data.entities?.[0]?.entity || null;
}

async function getHeightAtPoint(lon, lat) {
  const token = getToken(); // ✅ FIX: используем функцию
  if (!token) {
    console.error('❌ Токен не найден. Авторизуйтесь на сайте.');
    return;
  }

  try {
    const response = await fetch(
      `https://center.astramaps.ru/viewshed/height?lon=${lon}&lat=${lat}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`✅ Высота в точке (${lon}, ${lat}): ${data.height} м`);
    return data;
  } catch (error) {
    console.error('❌ Ошибка получения высоты:', error.message);
  }
}

function parseCoord(coordStr) {
  if (!coordStr) return null;
  const num = parseFloat(coordStr);
  return isNaN(num) ? null : num;
}

// ✅ FIX: Исправлен маппинг — "не поражена" → "Не поражена" (не "Вскрыто")
function mapResult(result) {
  const map = {
    "поражена": "Поражена",
    "не поражена": "Не поражена",
    "подана на доразведку": "На доразведку",
    "подтверждено": "Подтверждено"
  };
  return map[result] || "Вскрыто";
}

function mapTargetType(characteristic) {
  const map = {
    'ПУ': '1010000',
    'ПУ БПЛА': '1080300',
    'Точка влета': '1080200',
    'РЭБ': '1100000',
    'ЗРК': '1040503',
    'Связь': '1090000',
    'Танк': '1040202',
    'БМП': '1040204',
    'ББМ': '1040205',
    'РЛС': '1040402',
    'Склад': '1130900',
    'КНП': '1011100',
    'Укрытие': '1110100'
  };
  return map[characteristic] || '1100000';
}

function injectScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}
injectScript();

// ── Получаем данные пользователя от inject.js ─────────────────────────────
// inject.js перехватывает ответ /go/permission-group и диспатчит это событие.
// Срабатывает автоматически при загрузке страницы — никакого клика не нужно.
// Обрабатываем данные пользователя (из любого источника)
function handleUserIdentified(userId, username, displayName) {
  if (myUsername === username) return; // уже обработали

  myUserId      = userId;
  myUsername    = username;
  myDisplayName = displayName;

  console.log('[content] 👤 Пользователь:', displayName, '/', username);

  const localRole = resolveRoleLocally(username);
  if (localRole) {
    myRole = localRole;
    console.log('[content] ✅ Роль определена:', myRole);
  } else {
    console.log('[content] ⚠️ Роль не найдена для:', username);
  }

  wsRegisterWithUser(userId, username, displayName, myRole);
  updateRoleTag();
}

// Источник 1: inject.js перехватил permission-group
window.addEventListener('ASTRA_USER_IDENTIFIED', (event) => {
  const { userId, username, displayName } = event.detail;
  handleUserIdentified(userId, username, displayName);
});

// Источник 2: прямой запрос из content.js (резерв если inject.js опоздал)
// Запускается сразу и повторяется пока не получит данные
async function fetchProfileDirect() {
  if (myUsername) return; // уже определили

  const token = getToken();
  if (!token) return;

  try {
    const res = await fetch('https://center.astramaps.ru/go/permission-group', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) return;

    const data = await res.json();
    const groups  = Array.isArray(data) ? data : [data];
    const myGroups = groups.filter(g => g.myMembership);
    if (!myGroups.length) return;

    // Берём группу с наибольшим числом членов
    const group = myGroups.reduce((best, g) =>
      (g.members || []).length > (best.members || []).length ? g : best
    , myGroups[0]);

    const m = group.myMembership;
    console.log('[content] 👤 Профиль (прямой запрос):', m.username);
    handleUserIdentified(m.id, m.username, m.verboseName);

  } catch (err) {
    console.warn('[content] Ошибка прямого запроса профиля:', err.message);
  }
}

// Запускаем с повторными попытками пока не получим профиль
// Интервал: 0, 1, 2, 4, 8 секунд (экспоненциальный backoff)
(function retryFetchProfile(attempt = 0) {
  const delays = [0, 1000, 2000, 4000, 8000];
  const delay  = delays[attempt] ?? null;
  if (delay === null) {
    console.warn('[content] Профиль не определён после всех попыток');
    return;
  }
  setTimeout(async () => {
    if (myUsername) return; // уже определили — стоп
    await fetchProfileDirect();
    if (!myUsername) retryFetchProfile(attempt + 1); // не получилось — следующая попытка
  }, delay);
})();

// ======================== ОТПРАВКА ========================
async function sendTargetToAstraMap(rowData) {
  console.log(rowData);
  const { targetNumber, characteristic, coordX, coordY, impactTime, result, defeatDate } = rowData;

  // Таблица: колонка Х = northing (Y по проекции), колонка У = easting (X по проекции).
  // convertSk42ToWgs84(x, y): x=easting(У), y=northing(Х)
  const sk42easting  = parseFloat(coordY); // колонка «У»
  const sk42northing = parseFloat(coordX); // колонка «Х»

  if (isNaN(sk42easting) || isNaN(sk42northing)) {
    alert('❌ Некорректные координаты (не числа)');
    return;
  }

  const coord = convertSk42ToWgs84(sk42easting, sk42northing);
  const lon = typeof coord.lon === 'number' ? coord.lon : parseCoord(coord.lon);
  const lat = typeof coord.lat === 'number' ? coord.lat : parseCoord(coord.lat);

  if (lon === null || lat === null || isNaN(lon) || isNaN(lat)) {
    alert('❌ Некорректные координаты');
    return;
  }

  console.log(`СК-42 easting(У)=${sk42easting} northing(Х)=${sk42northing} → WGS84 lon=${lon} lat=${lat}`);

  const datetimeISO = toISOWithTime(defeatDate, impactTime);

  const colorMap = {
    'ПУ БПЛА': '#f44336',
    'РЭБ': '#2196f3',
    'Артиллерия': '#ff9800',
    'Укрытие': '#4caf50',
    'Связь': '#9c27b0',
    'Танк': '#795548'
  };

  const title = characteristic || `Цель №${targetNumber || '-'}`;
  const color = colorMap[characteristic] || '#888888';

  const payload = {
    id: 0,
    parentEntityID: latestFolderId || 741186,
    templateID: 2,
    title: title,
    parameters: {
      "1": {
        value: {
          type: "Point",
          coordinates: [lon, lat]
        },
        metadata: { properties: { subtype: "point" } }
      },
      "3": { value: 25 },
      "4": { value: "" },
      "5": { value: color },
      "6": { value: mapTargetType(characteristic) },
      "7": { value: mapResult(result) },
      "8": { value: [] },
      "9": { value: "ВР Войсковая разведка" },
      "10": { value: "Почти наверняка" },
      "11": { value: "Актуально" },
      "12": { value: datetimeISO },
      "14": { value: 0 },
      "17": { value: "Второй" },
      "18": { value: null }
    },
    mediaParamKeyID: "8",
    createdBy: {}
  };

  const token = getToken(); // ✅ FIX: всегда свежий токен

  try {
    const response = await fetch(ASTRA_API.createUpdate, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json, text/plain, */*'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text);
    }

    const resultJson = await response.json();
    console.log('✅ Успешно отправлено:', resultJson);

    wsSend({ type: 'UPDATE' });

    return resultJson;

  } catch (error) {
    console.error('❌ Ошибка отправки:', error);
    throw error;
  }
}

// ======================== ПОЛУЧЕНИЕ ДАННЫХ С КАРТЫ ========================
async function loadFromAstraMap(date) {
  const startDate = new Date(date + 'T00:00:00.000Z');
  const endDate = new Date(date + 'T23:59:59.999Z');

  const requestBody = {
    maxDepth: 10,
    withCounters: false,
    countTemplateIDs: [1, 2],
    countFromEntityIDs: [0],
    sortingParams: { field: "title", destination: "desc", folderFirst: "desc" },
    filterCriteria: [],
    relevantUpdatedAtFilter: {
      relevance: "custom",
      gte: startDate.toISOString(),
      lte: endDate.toISOString()
    },
    templateIDs: [1, 2],
    parentEntityID: 521055
  };

  const token = getToken(); // ✅ FIX: всегда свежий токен

  try {
    const response = await fetch('https://center.astramaps.ru/go/entity-V2/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    let allItems = data.entities || data.items || data.results || [];
    console.log('Данные с карты:', allItems);
    if (!Array.isArray(allItems)) allItems = [];

    const items = allItems.filter(item => {
      return item.entity &&
             item.entity.parameters &&
             typeof item.entity.parameters === 'object' &&
             item.entity.templateID === 2 &&
             item.entity.parameters["1"] &&
             item.entity.parameters["1"].value &&
             item.entity.parameters["1"].value.coordinates;
    });

    console.log(items);
    console.log(`Найдено всего: ${allItems.length}, отфильтровано целей: ${items.length}`);

    if (!Array.isArray(items) || items.length === 0) {
      alert(`⚠️ Цели за ${date} не найдены. Таблица будет очищена.`);
      populateTable([]);
      return;
    }

    // ✅ FIX: coordinates теперь хранятся в каждой строке отдельно
    const tableRows = items.map(item => {
      const params = item.entity.parameters || {};
      const coords = params["1"].value.coordinates;
      console.log(coords);
      const lon = coords[0];
      const lat = coords[1];
      const converted = convertWgs84ToSk42(lon, lat);
      console.log(converted);

      const defeatTimeISO = params["12"]?.value || '';
      let defeatDate = '', impactTime = '';
      if (defeatTimeISO) {
        defeatDate = defeatTimeISO.split('T')[0];
        impactTime = defeatTimeISO.split('T')[1]?.split('.')[0]?.slice(0, 5) || '';
      }

      const resultValue = params["7"]?.value || '';
      let result = '';
      if (resultValue === 'Поражена') result = 'поражена';
      else if (resultValue === 'Не поражена') result = 'не_поражена';
      else if (resultValue === 'Вскрыто') result = 'вскрыто';
      else if (resultValue === 'Передано на доразведку') result = 'передано_на_доразведку';
      else if (resultValue === 'Принятно на доразведку') result = 'принятно_на_доразведку';
      else if (resultValue === 'Подтверждена') result = 'подтверждена';

      const categoryValue = params["6"]?.value || '';
      let resultCategory = '';
      switch (categoryValue) {
        case '1010000': resultCategory = 'ПУ'; break;
        case '1080300': resultCategory = 'ПУ БПЛА'; break;
        case '1080200': resultCategory = 'Точка влета'; break;
        case '1100000': resultCategory = 'РЭБ'; break;
        case '1040503': resultCategory = 'ЗРК'; break;
        case '1090000': resultCategory = 'Связь'; break;
        case '1040202': resultCategory = 'Танк'; break;
        case '1040204': resultCategory = 'БМП'; break;
        case '1040205': resultCategory = 'ББМ'; break;
        case '1040402': resultCategory = 'РЛС'; break;
        case '1130900': resultCategory = 'Склад'; break;
        case '1011100': resultCategory = 'КНП'; break;
        case '1110100': resultCategory = 'Укрытие'; break;
        default: resultCategory = '';
      }

      return {
        targetNumber: item.entity.id || '',
        characteristic: resultCategory || '',
        coordX: converted.y,
        coordY: converted.x,
        // ✅ FIX: сохраняем оригинальные WGS84-координаты для каждой строки
        originalLon: lon,
        originalLat: lat,
        impactTime: impactTime,
        result: result,
        defeatDate: defeatDate
      };
    });

    populateTable(tableRows);
    alert(`✅ Загружено ${tableRows.length} целей за ${date}`);

  } catch (error) {
    console.error('Ошибка поиска:', error);
    alert(`❌ Не удалось загрузить данные за ${date}. Проверьте консоль.`);
  }
}

// ======================== РАБОТА С ТАБЛИЦЕЙ ========================
function getTableData() {
  const tbody = document.querySelector('#statusTable tbody');
  if (!tbody) return [];
  const rows = tbody.querySelectorAll('tr');
  const data = [];
  rows.forEach((row, idx) => {
    const cells = row.cells;
    // Новая структура:
    // 0: Дата обнаруж.  1: Номер цели  2: Характер  3: Место
    // 4: X  5: Y  6: Просмотр  7: Результат  8: Задача  9: Дата уничтожения  10: Формуляр
    const dateTimeCell = cells[0]?.innerText.trim() || '';
    const targetNumber = cells[1]?.innerText.trim() || (idx + 1).toString();
    const charSelect   = cells[2]?.querySelector('select');
    const characteristic = charSelect ? charSelect.value : (cells[2]?.innerText.trim() || '');
    const place    = cells[3]?.querySelector('input')?.value || cells[3]?.innerText.trim() || '';
    const coordX   = cells[4]?.innerText.trim() || '';
    const coordY   = cells[5]?.innerText.trim() || '';
    const resSelect  = cells[7]?.querySelector('select');
    const result     = resSelect ? resSelect.value : '';
    const destroyDate = cells[9]?.querySelector('input')?.value || cells[9]?.innerText.trim() || '';
    // impactTime берём из data-атрибута строки
    const impactTime = row.getAttribute('data-impact-time') || '';
    data.push({ targetNumber, characteristic, coordX, coordY, impactTime, result,
                defeatDate: destroyDate, place, dateTime: dateTimeCell });
  });
  return data;
}

// Иерархические категории для select
const CHAR_CATEGORIES = [
  { group: 'Пункты управления', opts: [
    'ПУ', 'КНП', 'ПУ армии', 'ПУ корпуса', 'ПУ дивизии',
    'ПУ бригады', 'ПУ полка', 'ПУ батальона', 'ПУ роты',
  ]},
  { group: 'Бронетехника', opts: [
    'Танк', 'БМП', 'ББМ', 'БТР', 'БРДМ', 'БМД', 'МТ-ЛБ', 'Бронеавтомобиль',
  ]},
  { group: 'Артиллерия', opts: [
    'Гаубица', 'САУ', 'РСЗО', 'Миномёт', 'Пушка', 'ПТРК',
  ]},
  { group: 'ПВО / ЗРК', opts: [
    'ЗРК', 'ПЗРК', 'ЗРК малой дальн.', 'ЗРК средней дальн.', 'ЗРК большой дальн.', 'ЗАК',
  ]},
  { group: 'РЛС', opts: [
    'РЛС', 'РЛС АРТ', 'РЛС ПВО', 'РЛС БПЛА', 'РЛС разв.',
  ]},
  { group: 'РЭБ', opts: [
    'РЭБ', 'РЭБ (станция)', 'РЭБ (комплекс)', 'РЭБ БПЛА',
  ]},
  { group: 'БПЛА', opts: [
    'БПЛА', 'ПУ БПЛА', 'Точка влета', 'БПЛА разв.', 'Аэродром БПЛА',
  ]},
  { group: 'Связь', opts: [
    'Связь', 'Узел связи', 'Ретранслятор', 'Радиостанция',
  ]},
  { group: 'Укрытия / Позиции', opts: [
    'Укрытие', 'Блиндаж', 'Окоп', 'Траншея', 'ДОТ', 'Позиция', 'Рубеж',
  ]},
  { group: 'Склады', opts: [
    'Склад', 'Склад БП', 'Склад ГСМ', 'Склад техники',
  ]},
  { group: 'Прочее', opts: [
    'Личный состав', 'Авиация', 'Инженерные объекты', 'Тыловые объекты',
    'Инфраструктура', 'Гражданский объект', 'Местный предмет',
  ]},
];

function buildCharSelect(currentVal) {
  const sel = document.createElement('select');
  sel.style.cssText = 'width:100%;font-size:11px;padding:2px 3px;border-radius:4px;border:1px solid #ccc;max-width:140px;';
  const defOpt = document.createElement('option');
  defOpt.value = ''; defOpt.textContent = '— Характер —';
  if (!currentVal) { defOpt.selected = true; }
  sel.appendChild(defOpt);

  for (const grp of CHAR_CATEGORIES) {
    const og = document.createElement('optgroup');
    og.label = grp.group;
    for (const cat of grp.opts) {
      const o = document.createElement('option');
      o.value = cat; o.textContent = cat;
      if (cat === currentVal) o.selected = true;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  // Если значение из старого маппинга не попало в список — добавляем как отдельный option
  if (currentVal && !sel.querySelector(`option[value="${CSS.escape(currentVal)}"]`)) {
    const extra = document.createElement('option');
    extra.value = currentVal; extra.textContent = currentVal; extra.selected = true;
    sel.insertBefore(extra, sel.options[1]);
  }
  return sel;
}

// Кэш медиа-флагов (in-memory, не сбрасывается при перерисовке таблицы)
const _mediaFlags = {};

function populateTable(dataArray) {
  const tbody = document.querySelector('#statusTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  // Дедупликация по targetNumber
  const rows = deduplicateById(dataArray, 'targetNumber');
  if (rows.length < dataArray.length) {
    console.warn(`[table] Убрано дублей: ${dataArray.length - rows.length}`);
  }

  const today   = getMoscowDateStr();
  const isToday = activeFolderDate === today || activeFolderDate === null;

  rows.forEach((item, idx) => {
    const row = tbody.insertRow();
    row.setAttribute('data-target-id', item.targetNumber || '');
    row.setAttribute('data-impact-time', item.impactTime || '');

    // Оранжевый фон для поражённых
    const DEFEATED_RESULTS = ['поражена', 'подтверждено', 'подавлено'];
    if (DEFEATED_RESULTS.includes(item.result)) {
      row.style.background = 'rgba(255,140,0,0.12)';
      row.style.borderLeft = '3px solid #fd7e14';
    }

    // ── col 0: Дата обнаруж. (дата + время) ──────────────────────────────
    const cellDate = row.insertCell(0);
    const datePart = item.defeatDate || '';
    const timePart = item.impactTime || '';
    const dateDisp = datePart ? datePart.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3.$2') : '';
    cellDate.innerHTML = `<span style="font-size:11px;white-space:nowrap;">${dateDisp || '—'}<br><span style="color:#888;">${timePart}</span></span>`;
    cellDate.style.cssText = 'text-align:center;padding:4px 6px;vertical-align:middle;';

    // ── col 1: Номер цели ─────────────────────────────────────────────────
    const cellNum = row.insertCell(1);
    cellNum.innerText = item.targetNumber || (idx + 1).toString();
    cellNum.style.cssText = 'text-align:center;font-size:12px;padding:4px 6px;';

    // ── col 2: Характер цели (иерархический select) ───────────────────────
    const cellChar = row.insertCell(2);
    cellChar.classList.add('char-cell');
    cellChar.style.cssText = 'padding:3px 4px;vertical-align:middle;';
    const selectChar = buildCharSelect(item.characteristic || '');
    cellChar.appendChild(selectChar);

    // ── col 3: Место ──────────────────────────────────────────────────────
    const cellPlace = row.insertCell(3);
    cellPlace.style.cssText = 'padding:3px 4px;vertical-align:middle;';
    const inputPlace = document.createElement('input');
    inputPlace.type  = 'text';
    inputPlace.value = item.place || '';
    inputPlace.placeholder = 'Место';
    inputPlace.style.cssText = 'width:100%;font-size:11px;padding:3px 6px;border-radius:4px;border:1px solid #ccc;max-width:90px;box-sizing:border-box;';
    cellPlace.appendChild(inputPlace);

    // ── col 4: X (read-only) ──────────────────────────────────────────────
    const cellX = row.insertCell(4);
    cellX.innerText = item.coordX || '';
    cellX.setAttribute('data-lon', item.originalLon ?? '');
    cellX.style.cssText = 'text-align:center;font-size:11px;padding:4px 6px;white-space:nowrap;';

    // ── col 5: Y (read-only) ──────────────────────────────────────────────
    const cellY = row.insertCell(5);
    cellY.innerText = item.coordY || '';
    cellY.setAttribute('data-lat', item.originalLat ?? '');
    cellY.style.cssText = 'text-align:center;font-size:11px;padding:4px 6px;white-space:nowrap;';

    // ── col 6: Просмотр на карте (👁 + медиа-индикатор) ───────────────────
    const cellView = row.insertCell(6);
    cellView.style.cssText = 'text-align:center;vertical-align:middle;padding:4px;';

    const targetEntityId = item.targetNumber || '';
    const btnView = document.createElement('a');
    btnView.classList.add('btnView');
    btnView.href   = `https://center.astramaps.ru/map/${targetEntityId}`;
    btnView.target = '_blank';
    btnView.rel    = 'noopener noreferrer';
    btnView.innerHTML = '👁️';
    btnView.title  = 'Просмотр в AstraMap';
    btnView.style.cssText = 'display:inline-block;padding:4px 8px;background:#2c7da0;color:white;border-radius:4px;font-size:15px;text-decoration:none;margin-bottom:3px;';
    btnView.addEventListener('click', e =>
      console.log('[btnView]', e.currentTarget.getAttribute('href'))
    );

    // Медиа-индикатор (фото/видео)
    const hasMedia = !!_mediaFlags[targetEntityId];
    const btnMedia = document.createElement('button');
    btnMedia.title    = hasMedia ? 'Фото/видео есть' : 'Нет фото/видео';
    btnMedia.innerHTML = '📷';
    btnMedia.style.cssText = `display:block;margin:2px auto 0;padding:2px 6px;font-size:13px;
      border:none;border-radius:4px;cursor:pointer;
      background:${hasMedia ? '#28a745' : '#e9ecef'};
      color:${hasMedia ? 'white' : '#aaa'};
      opacity:${hasMedia ? '1' : '0.5'};`;
    btnMedia.addEventListener('click', () => {
      _mediaFlags[targetEntityId] = !_mediaFlags[targetEntityId];
      const on = _mediaFlags[targetEntityId];
      btnMedia.title    = on ? 'Фото/видео есть' : 'Нет фото/видео';
      btnMedia.style.background = on ? '#28a745' : '#e9ecef';
      btnMedia.style.color      = on ? 'white'    : '#aaa';
      btnMedia.style.opacity    = on ? '1'        : '0.5';
    });

    cellView.appendChild(btnView);
    cellView.appendChild(btnMedia);

    // ── col 7: Результат ──────────────────────────────────────────────────
    const cellRes = row.insertCell(7);
    cellRes.style.cssText = 'padding:3px 4px;vertical-align:middle;';
    const selectRes = document.createElement('select');
    selectRes.style.cssText = 'width:100%;font-size:11px;padding:2px 4px;border-radius:4px;border:1px solid #ccc;';
    const resOpts = [
      { val: '',                       txt: '— Результат —', dis: true },
      { val: 'вскрыто',                txt: 'Вскрыт' },
      { val: 'передано_на_доразведку', txt: 'Передано на доразведку' },
      { val: 'подтверждено',           txt: 'Подтверждено' },
      { val: 'поражена',               txt: 'Поражена' },
      { val: 'не_поражена',            txt: 'Не поражена' },
      { val: 'подавлено',              txt: 'Подавлено' },
      { val: 'уничтожена',             txt: 'Уничтожена' },
    ];
    resOpts.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.val; opt.textContent = o.txt;
      if (o.dis) opt.disabled = true;
      if (o.val === item.result) opt.selected = true;
      if (o.val === '' && !item.result) opt.selected = true;
      selectRes.appendChild(opt);
    });
    cellRes.appendChild(selectRes);

    // ── col 8: Назначить задачу ───────────────────────────────────────────
    const cellTask = row.insertCell(8);
    cellTask.setAttribute('data-target-id', item.targetNumber || '');
    cellTask.classList.add('task-cell');
    cellTask.style.cssText = 'text-align:center;vertical-align:middle;padding:4px 6px;';
    renderTaskCell(cellTask, item.targetNumber || '', item.characteristic || '', isToday);

    // ── col 9: Дата уничтожения ───────────────────────────────────────────
    const cellDestroy = row.insertCell(9);
    cellDestroy.style.cssText = 'text-align:center;padding:3px 4px;vertical-align:middle;';
    const inputDestroy = document.createElement('input');
    inputDestroy.type  = 'date';
    inputDestroy.value = item.defeatDate || '';
    inputDestroy.style.cssText = 'font-size:11px;padding:2px 4px;border-radius:4px;border:1px solid #ccc;max-width:110px;';
    cellDestroy.appendChild(inputDestroy);

    // ── col 10: Сформировать формуляр ────────────────────────────────────
    const cellForm = row.insertCell(10);
    cellForm.style.cssText = 'text-align:center;padding:4px;vertical-align:middle;';
    const btnForm = document.createElement('button');
    btnForm.classList.add('btnForm');
    btnForm.innerText = 'Сформировать';
    btnForm.style.cssText = 'padding:5px 8px;background:#2c7da0;color:white;border:none;border-radius:4px;cursor:pointer;font-size:11px;white-space:nowrap;';
    btnForm.addEventListener('click', withLock(btnForm, async (e) => {
      e.stopPropagation();
      const currentRowData = {
        targetNumber:   cellNum.innerText.trim(),
        characteristic: selectChar.value,
        coordX:         cellX.innerText.trim(),
        coordY:         cellY.innerText.trim(),
        impactTime:     row.getAttribute('data-impact-time') || '',
        result:         selectRes.value,
        defeatDate:     inputDestroy.value || '',
        place:          inputPlace.value || '',
      };
      await apiSendTarget(currentRowData);
    }, { label: '⏳ Отправка...' }));
    cellForm.appendChild(btnForm);
  });
}

// ======================== СОЗДАНИЕ ПОПАПА ========================
function createPopup() {
  if (popupElement) return popupElement;

  popupElement = document.createElement('div');
  popupElement.id = 'extension-popup';
  popupElement.innerHTML = `
  <div style="
    position: fixed;
    top: 25px;
    right: 20px;
    width: 60%;
    max-height: calc(100vh - 40px);
    background: white;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.25);
    z-index: 10;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: system-ui, sans-serif;
  ">
    <style>
      #statusTable { width: 100%; min-width:900px; border-collapse: collapse; font-size: 12px; }
      #statusTable th, #statusTable td { padding: 6px 6px; border: 1px solid #d0d7de; text-align: center; vertical-align: middle; }
      #statusTable th:nth-child(3), #statusTable td:nth-child(3) { min-width:130px; max-width:160px; }
      #statusTable th:nth-child(4), #statusTable td:nth-child(4) { min-width:80px; }
      #statusTable th:nth-child(1), #statusTable td:nth-child(1) { min-width:70px; white-space:nowrap; }
      .editable { background: #fff9e6; min-height: 44px; }
      select, button { font-size: 12px; min-height: 44px; padding: 8px 12px; touch-action: manipulation; border-radius: 8px; }
      .table-wrapper { overflow-y: auto; -webkit-overflow-scrolling: touch; }
      .table-wrapper::-webkit-scrollbar,
      #tasksPanel::-webkit-scrollbar,
      #planningPanel::-webkit-scrollbar { width: 8px; height: 8px; }
      .table-wrapper::-webkit-scrollbar-track,
      #tasksPanel::-webkit-scrollbar-track,
      #planningPanel::-webkit-scrollbar-track { background: #e9ecef; border-radius: 4px; }
      .table-wrapper::-webkit-scrollbar-thumb,
      #tasksPanel::-webkit-scrollbar-thumb,
      #planningPanel::-webkit-scrollbar-thumb { background: #2c7da0; border-radius: 4px; }
      .table-wrapper::-webkit-scrollbar-thumb:hover,
      #tasksPanel::-webkit-scrollbar-thumb:hover,
      #planningPanel::-webkit-scrollbar-thumb:hover { background: #1e3a5f; }
      #statusTable thead th { background: #fff; }
      .eye-icon { font-size: 15px; padding: 5px 10px; background: #2c7da0; color: white; border: none; border-radius: 4px; cursor: pointer; }
      @media (max-width: 800px) { #statusTable { font-size: 12px; } #statusTable th, #statusTable td { padding: 8px 6px; } button { padding: 10px 14px; } }
      @media (max-width: 600px) { #statusTable { min-width: 600px; font-size: 12px; } }
      .button-panel { display: flex; justify-content: flex-end; gap: 12px; flex-wrap: wrap; padding: 12px 16px; background: #e9ecef; border-top: 1px solid #ced4da; flex-shrink: 0; }
    </style>

    <div style="padding: 5px 14px; background: #1e3a5f; color: white; display: flex; flex-direction: column; flex-shrink: 0;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <h3 style="margin: 0; font-size: 16px;">📋 Таблица учёта целей</h3>
          <button id="addTargetBtn" style="background:#28a745; color:white; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:14px;">+ Добавить цель</button>
          <!-- Кнопка задач с бейджем -->
          <div style="position:relative; display:inline-block;">
            <button id="showTasksBtn" style="background:#fd7e14; color:white; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:14px;">📋 Задачи</button>
            <span id="task-badge" style="display:none; position:absolute; top:-6px; right:-6px; background:#dc3545; color:white; border-radius:50%; width:18px; height:18px; font-size:11px; align-items:center; justify-content:center; font-weight:600;"></span>
          </div>
          <button id="showPlanningBtn" style="background:#6f42c1; color:white; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:14px;">📅 Спланировано</button>
          <button id="showTokensBtn" style="display:none;background:#0097a7; color:white; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:14px;">🔑 Токены</button>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <!-- Плашка с именем и расчётом (заполняется автоматически после REGISTER) -->
          <span id="myRoleTag" style="font-size:12px;background:#2c5282;padding:4px 10px;border-radius:6px;white-space:nowrap;">
            🔄 Определяю расчёт...
          </span>
          <button id="closePopupBtn" style="background: none; border: none; color: white; font-size: 28px; padding: 2px 12px; cursor: pointer;">&times;</button>
        </div>
      </div>
      <!-- Индикатор онлайн-расчётов -->
      <div id="online-indicator" style="padding: 4px 0; font-size: 11px; opacity: 0.8; min-height: 18px;"></div>
    </div>

    <!-- Панель дат — между расчётами и таблицей -->
    <div id="dates-panel" style="
      background: #162d4a;
      padding: 6px 14px;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      flex-shrink: 0;
      border-bottom: 1px solid #0d1f33;
      min-height: 36px;
    ">
      <span style="font-size:11px;color:#7aa3c8;margin-right:4px;">📅 Даты:</span>
      <div id="dates-list" style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;">
        <span style="font-size:11px;color:#5a7fa0;">загрузка...</span>
      </div>
      <div style="margin-left:auto;display:flex;gap:6px;align-items:center;">
        <button id="publishPlanBtn" title="Опубликовать план в AstraMap" style="
          display:none; background:#28a745; border:none; color:white;
          border-radius:4px; padding:3px 10px; cursor:pointer; font-size:11px;
        ">📤 Опубликовать план</button>
        <button id="refreshDatesBtn" title="Обновить список дат" style="
          background:none; border:1px solid #4a7a9b;
          color:#7aa3c8; border-radius:4px; padding:2px 8px;
          cursor:pointer; font-size:11px;
        ">🔄</button>
      </div>
    </div>

    <div class="table-wrapper" style="flex: 1; overflow-y: auto; padding: 12px; background: #f5f7fa; color: black;">
      <table id="statusTable">
        <thead>
          <tr>
            <th rowspan="2" style="min-width:80px;">Дата обнаруж.</th>
            <th rowspan="2">Номер цели</th>
            <th rowspan="2" style="min-width:140px;">Характер цели</th>
            <th rowspan="2" style="min-width:90px;">Место</th>
            <th colspan="2">Координаты</th>
            <th rowspan="2">Просмотр на карте</th>
            <th rowspan="2" style="min-width:130px;">Результат</th>
            <th rowspan="2" style="min-width:130px;">Назначить задачу</th>
            <th rowspan="2" style="min-width:80px;">Дата уничтожения</th>
            <th rowspan="2">Сформировать формуляр</th>
          </tr>
          <tr><th>X</th><th>Y</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <!-- Панель задач (скрыта по умолчанию) -->
    <div id="tasksPanel" style="display:none; flex:1; overflow-y:auto; padding:12px; background:#f5f7fa; color:black;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <strong style="font-size:14px;">Задачи между расчётами</strong>
        <button id="newTaskBtn" style="background:#fd7e14;color:white;border:none;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:12px;">+ Новая задача</button>
      </div>
      <table id="tasksTable" style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:#e9ecef;">
            <th style="padding:6px;border:1px solid #d0d7de;text-align:left;">Время</th>
            <th style="padding:6px;border:1px solid #d0d7de;">От</th>
            <th style="padding:6px;border:1px solid #d0d7de;">Кому</th>
            <th style="padding:6px;border:1px solid #d0d7de;text-align:left;">Задача</th>
            <th style="padding:6px;border:1px solid #d0d7de;">Статус</th>
            <th style="padding:6px;border:1px solid #d0d7de;">Действие</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <!-- Панель Токены — управление доступом (только админ) -->
    <div id="tokensPanel" style="display:none;flex-direction:column;flex:1;overflow:hidden;background:#1a2740;padding:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <span style="font-weight:600;color:#e2e8f0;font-size:14px;">🔑 Управление токенами доступа</span>
        <button id="refreshTokensBtn" style="padding:4px 10px;background:#2d4a6a;color:#90cdf4;border:none;border-radius:5px;cursor:pointer;font-size:12px;">🔄 Обновить</button>
      </div>
      <!-- Форма создания нового токена -->
      <div style="background:#0f1e30;border:1px solid #2d4a6a;border-radius:8px;padding:14px;margin-bottom:12px;">
        <div style="font-size:13px;color:#90afc5;margin-bottom:10px;font-weight:600;">Создать токен для пользователя</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <input id="newTokenName" placeholder="Имя (напр. Иванов И.И.)"
            style="padding:7px 10px;border-radius:6px;border:1px solid #2d4a6a;background:#1a2740;color:#e2e8f0;font-size:13px;" />
          <input id="newTokenUsername" placeholder="Логин (латиница)"
            style="padding:7px 10px;border-radius:6px;border:1px solid #2d4a6a;background:#1a2740;color:#e2e8f0;font-size:13px;" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px;">
          <select id="newTokenRole"
            style="padding:7px 8px;border-radius:6px;border:1px solid #2d4a6a;background:#1a2740;color:#e2e8f0;font-size:13px;">
            <option value="">— Роль —</option>
          </select>
          <select id="newTokenOffice"
            style="padding:7px 8px;border-radius:6px;border:1px solid #2d4a6a;background:#1a2740;color:#e2e8f0;font-size:13px;">
            <option value="">— Подразделение —</option>
          </select>
          <button id="generateTokenBtn"
            style="padding:7px 12px;background:#2563eb;color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">
            ➕ Создать
          </button>
        </div>
      </div>
      <!-- Список выданных токенов -->
      <div id="tokensListContainer" style="flex:1;overflow-y:auto;color:#e2e8f0;font-size:12px;">
        <div style="color:#5a7fa0;text-align:center;padding:20px;">Нажмите 🔄 для загрузки списка</div>
      </div>
    </div>

    <!-- Панель Спланировано — непоражённые цели по всем датам -->
    <div id="planningPanel" style="
      display:none; flex-direction:column; flex:1;
      overflow:hidden; background:#f5f7fa; color:black;
    "></div>

    <!-- Модал: создать новую задачу -->
    <div id="newTaskModal" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);display:none;justify-content:center;align-items:center;z-index:10001;">
      <div style="background:white;width:90%;max-width:420px;border-radius:10px;padding:20px;display:flex;flex-direction:column;gap:10px;">
        <h3 style="margin:0;font-size:16px;">Новая задача</h3>
        <label style="font-size:12px;color:#555;">Кому:</label>
        <select id="taskTo" style="padding:6px;border-radius:5px;border:1px solid #ccc;">
          <option value="">— выберите расчёт —</option>
          <option value="разведка">Разведка</option>
          <option value="рэб">РЭБ</option>
          <option value="инженеры">Инженеры</option>
          <option value="артиллерия">Артиллерия</option>
          <option value="бпс">БПС</option>
          <option value="админ">Админ</option>
          <option value="гооп">ГООП</option>
          <option value="босс">Босс</option>
          <option value="177 огвпмп">177 ОГВПМП</option>
        </select>
        <label style="font-size:12px;color:#555;">Объект (необязательно):</label>
        <select id="taskTargetSelect" style="padding:6px;border-radius:5px;border:1px solid #ccc;">
          <option value="">— без привязки к цели —</option>
        </select>
        <label style="font-size:12px;color:#555;">Текст задачи:</label>
        <textarea id="taskText" rows="3" placeholder="Например: Доразведать объект, уточнить координаты" style="padding:6px;border-radius:5px;border:1px solid #ccc;resize:vertical;font-size:13px;"></textarea>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="cancelNewTask" style="padding:6px 14px;border-radius:5px;border:1px solid #ccc;cursor:pointer;">Отмена</button>
          <button id="submitNewTask" style="padding:6px 14px;background:#fd7e14;color:white;border:none;border-radius:5px;cursor:pointer;font-weight:600;">Поставить задачу</button>
        </div>
      </div>
    </div>

    <div class="button-panel">
      <button id="exportTableData" style="background:#007bff;color:white;">📎 Экспорт Excel</button>
      <button id="loadTodayMap" style="background:#17a2b8;color:white;">📥 Сегодня</button>
    </div>

    <div id="addTargetModal" style="position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; justify-content: center; align-items: center; z-index: 10000;">
      <div style="background: white; width: 90%; max-width: 500px; border-radius: 10px; padding: 20px; display: flex; flex-direction: column; gap: 10px;">
        <h3 style="margin:0;">Добавление цели</h3>
        <input id="targetTitle" placeholder="Название цели" />
        <select id="targetType">
          <option selected>Категория</option>
          <option value="ПУ">ПУ</option>
          <option value="ПУ БПЛА">ПУ БПЛА</option>
          <option value="Точка влета">Точка взлета</option>
          <option value="РЛС">РЛС</option>
          <option value="РЭБ">РЭБ</option>
          <option value="Связь">Связь</option>
          <option value="ЗРК">ЗРК</option>
          <option value="Танк">Танк</option>
          <option value="БМП">БМП</option>
          <option value="ББМ">ББМ</option>
          <option value="Склад">Склад</option>
          <option value="КНП">КНП</option>
          <option value="Укрытие">Укрытие</option>
        </select>
        <input id="coordX" type="number" placeholder="Координата X" />
        <input id="coordY" type="number" placeholder="Координата Y" />
        <!-- ✅ FIX: опечатка исправлена -->
        <input id="impactTime" type="time" placeholder="Время обнаружения" />
        <input id="impactDate" type="date" placeholder="Дата обнаружения" />
        <select id="impactResult">
          <option selected>Вскрыто</option>
          <option>Поражена</option>
          <option>Не поражена</option>
          <option>Подана на доразведку</option>
          <option>Принято на доразведку</option>
          <option>Подтверждено</option>
        </select>
        <div style="display:flex; gap:10px; justify-content:flex-end;">
          <button id="cancelAddTarget">Отмена</button>
          <button id="submitAddTarget" style="background:#28a745;color:white;">💾 Добавить</button>
        </div>
      </div>
    </div>
  </div>
  `;

  popupElement.style.display = 'none';
  document.body.appendChild(popupElement);

  const modal = popupElement.querySelector('#addTargetModal');

  popupElement.querySelector('#addTargetBtn').addEventListener("click", function () {
    // Подставляем московское время (UTC+3) в поля при каждом открытии
    popupElement.querySelector('#impactDate').value = getMoscowDateStr();
    popupElement.querySelector('#impactTime').value = getMoscowTimeStr();
    modal.style.display = 'flex';
  });

  popupElement.querySelector('#cancelAddTarget').onclick = () => {
    modal.style.display = 'none';
  };

  popupElement.querySelector('#submitAddTarget').onclick = async () => {
    try {
      const data = {
        targetNumber: '1',
        characteristic: popupElement.querySelector('#targetType').value,
        coordX: popupElement.querySelector('#coordX').value,
        coordY: popupElement.querySelector('#coordY').value,
        impactTime: popupElement.querySelector('#impactTime').value,
        result: popupElement.querySelector('#impactResult').value,
        defeatDate: popupElement.querySelector('#impactDate').value,
      };

      const existing = getTableData();
      existing.push(data);
      populateTable(existing);

      await sendTargetToAstraMap(data);

      loadFromAstraMap(getMoscowDateStr());

      // ✅ FIX: сброс полей после закрытия модала
      modal.style.display = 'none';
      popupElement.querySelector('#targetTitle').value = '';
      popupElement.querySelector('#targetType').selectedIndex = 0;
      popupElement.querySelector('#coordX').value = '';
      popupElement.querySelector('#coordY').value = '';
      popupElement.querySelector('#impactTime').value = '';
      popupElement.querySelector('#impactDate').value = '';
      popupElement.querySelector('#impactResult').selectedIndex = 0;

      alert('Цель добавлена');
    } catch (e) {
      modal.style.display = 'none'; // ✅ FIX: закрываем модал даже при ошибке
      alert('Ошибка отправки');
      console.error(e);
    }
  };

  popupElement.querySelector('#closePopupBtn').addEventListener('click', () => {
    popupElement.style.display = 'none';
  });

  popupElement.querySelector('#publishPlanBtn').addEventListener('click', () => {
    const btn      = popupElement.querySelector('#publishPlanBtn');
    const planDate = btn?.getAttribute('data-plan-date');
    if (!planDate) { showToast('Дата плана не определена', 'error'); return; }
    if (!confirm(`Опубликовать план на ${planDate.slice(8)}.${planDate.slice(5,7)} в AstraMap?`)) return;
    publishPlan(planDate);
  });

  // ── Кнопка Планирование ─────────────────────────────────────────────────
  const tableWrapper  = popupElement.querySelector('.table-wrapper');
  const tasksPanel    = popupElement.querySelector('#tasksPanel');
  const planningPanel = popupElement.querySelector('#planningPanel');

  popupElement.querySelector('#showPlanningBtn').addEventListener('click', () => {
    const isOpen = planningPanel && planningPanel.style.display !== 'none';
    // Скрываем все панели
    if (tableWrapper)  tableWrapper.style.display  = 'none';
    if (tasksPanel)    tasksPanel.style.display     = 'none';
    if (planningPanel) planningPanel.style.display  = 'none';
    popupElement.querySelector('#showTasksBtn').textContent    = '📋 Задачи';
    popupElement.querySelector('#showPlanningBtn').textContent = '📅 Спланировано';

    if (!isOpen) {
      if (planningPanel) {
        planningPanel.style.display     = 'flex';
        planningPanel.style.flexDirection = 'column';
      }
      popupElement.querySelector('#showPlanningBtn').textContent = '🗺️ Цели';
      loadPlanningTargets();
    } else {
      if (tableWrapper) tableWrapper.style.display = '';
    }
  });

  // ── Панель Токены (только для админа) ───────────────────────────────────
  const tokensPanel = popupElement.querySelector('#tokensPanel');
  const showTokensBtn = popupElement.querySelector('#showTokensBtn');

  // Показываем кнопку только для админа
  function updateTokensBtnVisibility() {
    if (showTokensBtn) showTokensBtn.style.display = myRole === 'админ' ? '' : 'none';
  }

  if (showTokensBtn) {
    showTokensBtn.addEventListener('click', () => {
      const isOpen = tokensPanel && tokensPanel.style.display !== 'none';
      // Скрываем все панели
      if (tableWrapper)  tableWrapper.style.display  = 'none';
      if (tasksPanel)    tasksPanel.style.display     = 'none';
      if (planningPanel) planningPanel.style.display  = 'none';
      if (tokensPanel)   tokensPanel.style.display    = 'none';
      popupElement.querySelector('#showTasksBtn').textContent    = '📋 Задачи';
      popupElement.querySelector('#showPlanningBtn').textContent = '📅 Спланировано';
      showTokensBtn.textContent = '🔑 Токены';

      if (!isOpen) {
        if (tokensPanel) {
          tokensPanel.style.display     = 'flex';
          tokensPanel.style.flexDirection = 'column';
        }
        showTokensBtn.textContent = '🗺️ Цели';

        // Заполняем роли и подразделения
        const roleSelect   = tokensPanel.querySelector('#newTokenRole');
        const officeSelect = tokensPanel.querySelector('#newTokenOffice');
        if (roleSelect && !roleSelect.options.length > 1) {
          Object.values(OFFICES).forEach(office => {
            Object.keys(office.roles).forEach(role => {
              if (![...roleSelect.options].find(o => o.value === role)) {
                const opt = document.createElement('option');
                opt.value = role; opt.textContent = role;
                roleSelect.appendChild(opt);
              }
            });
          });
        }
        if (officeSelect && officeSelect.options.length <= 1) {
          Object.entries(OFFICES).forEach(([id, office]) => {
            const opt = document.createElement('option');
            opt.value = id; opt.textContent = `${office.short} — ${office.name}`;
            officeSelect.appendChild(opt);
          });
        }

        wsSend({ type: 'LIST_TOKENS' });
      } else {
        if (tableWrapper) tableWrapper.style.display = '';
      }
    });
  }

  // Генерация токена
  popupElement.querySelector('#generateTokenBtn')?.addEventListener('click', () => {
    const name     = popupElement.querySelector('#newTokenName')?.value.trim();
    const username = popupElement.querySelector('#newTokenUsername')?.value.trim();
    const role     = popupElement.querySelector('#newTokenRole')?.value;
    const officeId = popupElement.querySelector('#newTokenOffice')?.value || 'HQ';
    if (!name || !username || !role) {
      showToast('Заполни все поля', 'error'); return;
    }
    wsSend({ type: 'GENERATE_TOKEN', username, role, displayName: name, officeId });
  });

  // Обновить список
  popupElement.querySelector('#refreshTokensBtn')?.addEventListener('click', () => {
    wsSend({ type: 'LIST_TOKENS' });
  });

  // ── Переключение между таблицей целей и панелью задач ───────────────────


  popupElement.querySelector('#showTasksBtn').addEventListener('click', () => {
    const isTasksVisible = tasksPanel.style.display !== 'none';
    if (isTasksVisible) {
      tasksPanel.style.display = 'none';
      tableWrapper.style.display = '';
      popupElement.querySelector('#showTasksBtn').textContent = '📋 Задачи';
    } else {
      tasksPanel.style.display = 'flex';
      tasksPanel.style.flexDirection = 'column';
      tableWrapper.style.display = 'none';
      popupElement.querySelector('#showTasksBtn').textContent = '🗺️ Цели';
      // Сбрасываем счётчик когда открыли панель задач
      unreadTaskCount = 0;
      updateTaskBadge();
    }
  });

  // ── Модал новой задачи ───────────────────────────────────────────────────
  const newTaskModal = popupElement.querySelector('#newTaskModal');

  popupElement.querySelector('#newTaskBtn').addEventListener('click', () => {
    if (!myRole) { showToast('Сначала выберите свой расчёт', 'error'); return; }
    // Заполняем список целей из текущей таблицы
    const targetSelect = newTaskModal.querySelector('#taskTargetSelect');
    targetSelect.innerHTML = '<option value="">— без привязки к цели —</option>';
    const rows = document.querySelectorAll('#statusTable tbody tr');
    rows.forEach(row => {
      const id    = row.cells[0]?.innerText.trim();
      const title = row.cells[1]?.querySelector('select')?.value || '';
      const opt   = document.createElement('option');
      opt.value   = id;
      opt.textContent = `#${id} ${title}`;
      targetSelect.appendChild(opt);
    });
    newTaskModal.style.display = 'flex';
  });

  popupElement.querySelector('#cancelNewTask').addEventListener('click', () => {
    newTaskModal.style.display = 'none';
  });

  popupElement.querySelector('#submitNewTask').addEventListener('click', () => {
    const to          = newTaskModal.querySelector('#taskTo').value;
    const text        = newTaskModal.querySelector('#taskText').value.trim();
    const targetSel   = newTaskModal.querySelector('#taskTargetSelect');
    const targetId    = targetSel.value;
    const targetTitle = targetId ? targetSel.options[targetSel.selectedIndex].text : '';

    if (!to)   { showToast('Укажите адресата', 'error'); return; }
    if (!text) { showToast('Введите текст задачи', 'error'); return; }
    if (!myRole) { showToast('Сначала выберите свой расчёт', 'error'); return; }

    wsSend({ type: 'NEW_TASK', to, text, targetId, targetTitle });

    newTaskModal.style.display = 'none';
    newTaskModal.querySelector('#taskTo').value = '';
    newTaskModal.querySelector('#taskText').value = '';
    newTaskModal.querySelector('#taskTargetSelect').value = '';
  });

  popupElement.querySelector('#exportTableData').addEventListener('click', () => {
    alert('Экспорт в Excel – функция в разработке');
  });

  // Кнопка обновления дат
  popupElement.querySelector('#refreshDatesBtn').addEventListener('click', () => {
    // Сбрасываем кэш дат
    localStorage.removeItem(CACHE_KEY_DATES);
    // Сбрасываем кэш целей за все даты
    const keysToDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CACHE_KEY_PREFIX)) keysToDelete.push(key);
    }
    keysToDelete.forEach(k => localStorage.removeItem(k));
    console.log(`[cache] Сброшено ${keysToDelete.length + 1} записей кэша`);
    renderDatePanel(true);
  });

  popupElement.querySelector('#loadTodayMap').addEventListener('click', async () => {
    const today = getMoscowDateStr();
    await loadByDateFromPanel(today);
  });



  return popupElement;
}

// ======================== КНОПКА ЗАКРЫТИЯ ========================
function closeBtn() {
  const closeBtnElem = document.querySelector("#closePopupBtn");
  if (closeBtnElem && !closeBtnElem.hasListener) {
    closeBtnElem.addEventListener("click", function () {
      const popup = document.querySelector("#extension-popup");
      if (popup) popup.style.display = "none";
    });
    closeBtnElem.hasListener = true;
    return true;
  }
  return false;
}

// ======================== ДОБАВЛЕНИЕ КНОПКИ НА КАРТУ ========================
function findAndAddButton() {
  const target = document.querySelector('.mapToolsControl__X3RqH');
  if (!target) return false;
  if (target.querySelector('#extension-trigger-btn')) return true;

  const btn = document.createElement('button');
  btn.id = 'extension-trigger-btn';
  btn.textContent = '📋 Формуляр цели';
  btn.style.cssText = 'padding: 6px 12px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; margin: 4px;';

  const popup = createPopup();
  btn.onclick = (e) => {
    e.stopPropagation();
    const isOpening = popup.style.display === 'none';
    popup.style.display = isOpening ? 'flex' : 'none';
    if (isOpening) {
      renderDatePanel().then(() => {
        initBadgesFromCache();
        loadAllDatesBadgesInBackground();
        restoreDraftDateBtns();
      });
      updateRoleTag();
    }
  };
  target.appendChild(btn);
  return true;
}

// ======================== ИНТЕРВАЛЫ ========================
let attemptsClose = 0;
const intervalClose = setInterval(() => {
  if (closeBtn()) clearInterval(intervalClose);
  attemptsClose++;
  if (attemptsClose > 5) clearInterval(intervalClose);
}, 1000);

let attemptsAdd = 0;
const intervalAdd = setInterval(() => {
  if (findAndAddButton()) clearInterval(intervalAdd);
  attemptsAdd++;
  if (attemptsAdd > 20) clearInterval(intervalAdd);
}, 1000);

// ======================== ОСНОВНАЯ ЛОГИКА ========================
function ContenNew() {
  console.log('[Content] Инициализация Astra Maps Collector...');

  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
    @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
  `;
  document.head.appendChild(style);

  const checkModules = setInterval(() => {
    if (window.authMonitor && window.dataCollector) {
      clearInterval(checkModules);
      console.log('[Content] Оба модуля загружены');
      initCoordinator();
    }
  }, 100);
}

// Обновить кнопку «+ Добавить цель»
function updateAddTargetBtn() {
  const btn = document.querySelector('#addTargetBtn');
  if (!btn) return;
  const isLatest = activeFolderId && latestFolderId && activeFolderId === latestFolderId;
  const noDate   = !activeFolderId;
  if (isLatest || noDate) {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor  = 'pointer';
    btn.title = '';
  } else {
    btn.disabled = true;
    btn.style.opacity = '0.4';
    btn.style.cursor  = 'not-allowed';
    btn.title = `Только просмотр. Добавление в крайнюю папку (${latestFolderDate})`;
  }
}

// ── Найти или создать папку "спланировано на DD.MM.YY г." ──────────────────
async function findOrCreatePlanFolder(parentFolderId, planDate) {
  const token = getToken();

  // Форматируем название папки: "спланировано на 24.05.26г."
  const parts    = planDate.split('-'); // YYYY-MM-DD
  const dayMonth = `${parts[2]}.${parts[1]}.${parts[0].slice(2)}г.`;
  const folderTitle = `спланировано на ${dayMonth}`;

  // Ищем существующую папку среди дочерних
  const children = await fetchFolderChildren(parentFolderId);
  const existing = children.find(item => {
    const e = item.entity || item;
    return e.templateID === 1 &&
           e.title?.toLowerCase().includes(parts[2] + '.' + parts[1]);
  });

  if (existing) {
    const e = existing.entity || existing;
    console.log(`[plan] Папка найдена: "${e.title}" id=${e.id}`);
    return e.id;
  }

  // Создаём новую папку внутри папки дня
  console.log(`[plan] Создаём папку: "${folderTitle}" в parentEntityID=${parentFolderId}`);
  const res = await fetch(ASTRA_API.createUpdate, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json, text/plain, */*'
    },
    body: JSON.stringify({
      id:             0,
      parentEntityID: parentFolderId,
      templateID:     1,
      title:          folderTitle,
      parameters:     {},
      createdBy:      {}
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Ошибка создания папки: HTTP ${res.status} — ${txt}`);
  }
  const data = await res.json();
  const newId = data.id || data.entity?.id;
  console.log(`[plan] Папка создана: id=${newId}`);
  return newId;
}

// ── Переместить объект в папку (изменить parentEntityID) ─────────────────────
async function moveEntityToFolder(entityId, newParentId, entityData) {
  const token = getToken();

  // AstraMap требует отдельный эндпоинт /relink для перемещения существующих объектов
  // POST /go/entity-V2/relink
  // { entityID: id, newParentEntityID: newParentId }
  // Поля согласно BulkRelinkRequest схеме AstraMap
  const payload = {
    EntityID:    entityId,
    NewParentID: newParentId,
  };

  console.log('[plan] relink payload:', JSON.stringify(payload));

  const res = await fetch(ASTRA_API.relink, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json, text/plain, */*'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error('[plan] relink ошибка:', txt);
    throw new Error(`Ошибка перемещения: HTTP ${res.status} — ${txt}`);
  }

  // relink может возвращать пустой ответ
  const txt = await res.text();
  return txt ? JSON.parse(txt) : { success: true };
}

// ── Спланировать цель на дату ─────────────────────────────────────────────────
// Находит папку дня → находит/создаёт подпапку "спланировано на..." →
// перемещает объект → уведомляет всех
// Роли с правом публикации плана
const PUBLISH_ROLES = ['гооп', 'админ', 'босс'];
function canPublish() { return PUBLISH_ROLES.includes(myRole); }

// Восстановить кнопки черновых дат — вызывается после renderDatePanel
function restoreDraftDateBtns() {
  if (!myRole) return;
  const tomorrow = new Date(Date.now() + 3*3600000 + 86400000).toISOString().slice(0,10);
  const dayAfter  = new Date(Date.now() + 3*3600000 + 2*86400000).toISOString().slice(0,10);
  const in3days   = new Date(Date.now() + 3*3600000 + 3*86400000).toISOString().slice(0,10);
  [tomorrow, dayAfter, in3days].forEach(date => {
    wsSend({ type: 'GET_DRAFT_CHECK', planDate: date });
  });
}

// Добавить кнопку черновой даты в панель дат если её ещё нет
function addDraftDateBtn(planDate) {
  const list = document.querySelector('#dates-list');
  if (!list) return;

  // Проверяем — кнопка уже есть?
  if (list.querySelector(`button[data-date="${planDate}"]`)) {
    // Уже есть — показываем кнопку публикации если нужно
    updatePublishBtn(planDate);
    return;
  }

  const parts     = planDate.split('-');
  const shortDate = parts.length === 3 ? `${parts[2]}.${parts[1]}` : planDate;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;display:inline-flex;';

  const btn = document.createElement('button');
  btn.setAttribute('data-date', planDate);
  btn.setAttribute('data-folder-id', '');  // нет папки — черновик
  btn.setAttribute('data-draft', 'true');
  btn.classList.add('date-tab-btn');
  btn.title = `Черновой план на ${shortDate} (не опубликован)`;
  btn.innerHTML = `${shortDate} <span style="font-size:9px;">✏️</span>`;
  btn.style.cssText = `
    padding: 3px 7px; border-radius: 12px; font-size: 10px; cursor: pointer;
    border: 1px solid rgb(99,102,241); background: rgb(30,27,75);
    color: rgb(199,210,254); transition: 0.15s; min-height: 32px;
    white-space: nowrap; display:inline-flex; align-items:center; gap:3px;
  `;

  // Бейдж
  const badge = document.createElement('span');
  badge.classList.add('date-undefeated-badge');
  badge.setAttribute('data-date', planDate);
  badge.style.cssText = `
    display:none; position:absolute; top:-6px; right:-6px;
    background:#6366f1; color:white; border-radius:50%;
    min-width:16px; height:16px; font-size:9px; font-weight:700;
    align-items:center; justify-content:center; padding:0 3px;
    border:1px solid rgb(30,27,75);
  `;

  btn.addEventListener('click', async () => {
    // Переключаем активную вкладку
    list.querySelectorAll('button').forEach(b => {
      b.classList.remove('active-date');
      b.style.background = b.getAttribute('data-draft') ? 'rgb(30,27,75)' : 'rgb(30,58,95)';
      b.style.color      = b.getAttribute('data-draft') ? 'rgb(199,210,254)' : 'rgb(168,204,232)';
      b.style.border     = b.getAttribute('data-draft') ? '1px solid rgb(99,102,241)' : '1px solid rgb(74,122,155)';
    });
    btn.classList.add('active-date');
    btn.style.background = 'rgb(79,70,229)';
    btn.style.color      = '#fff';
    btn.style.border     = '1px solid rgb(129,140,248)';

    activeFolderId   = null;
    activeFolderDate = planDate;

    // Показываем пустую таблицу + загружаем планы из SQLite
    const tasksPanel   = document.querySelector('#tasksPanel');
    const tableWrapper = document.querySelector('.table-wrapper');
    const planningP    = document.querySelector('#planningPanel');
    if (tasksPanel)  tasksPanel.style.display   = 'none';
    if (planningP)   planningP.style.display    = 'none';
    if (tableWrapper) tableWrapper.style.display = '';

    populateTable([]);  // очищаем таблицу
    loadPlansForDate(planDate);  // загружаем черновики из SQLite
    updatePublishBtn(planDate);
    updateAddTargetBtn();
  });

  wrap.appendChild(btn);
  wrap.appendChild(badge);

  // Вставляем в начало списка (новые даты слева)
  list.insertBefore(wrap, list.firstChild);
  updatePublishBtn(planDate);
}

function updatePublishBtn(planDate) {
  const btn = document.querySelector('#publishPlanBtn');
  if (!btn) return;
  const tomorrow = new Date(Date.now() + 3*3600000 + 86400000).toISOString().slice(0,10);
  if (planDate === tomorrow && canPublish()) {
    btn.style.display = 'block';
    btn.setAttribute('data-plan-date', planDate);
  } else {
    btn.style.display = 'none';
  }
}

async function publishPlan(planDate) {
  if (!canPublish()) { showToast('❌ Нет прав для публикации', 'error'); return; }
  const tree      = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
  const dateEntry = tree?.dates?.find(d => d.date === planDate);
  window._pendingPublish = { planDate, folderId: dateEntry?.folderId || null };
  wsSend({ type: 'GET_DRAFT_PLANS', planDate });
  showToast('⏳ Загружаем планы...', 'info');
}

async function executePlanPublish(planDate, plans, targetFolderId) {
  const token       = getToken();
  const unpublished = plans.filter(p => !p.published);
  if (!unpublished.length) { showToast('Нет новых планов для публикации', 'info'); return; }
  showToast(`⏳ Публикуем ${unpublished.length} целей...`, 'info');

  let dayFolderId = targetFolderId;
  if (!dayFolderId) {
    const tree    = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
    const first   = tree?.dates?.[0];
    const monthId = first ? await getParentFolderId(first.folderId) : null;
    if (monthId) dayFolderId = await findOrCreateDayFolder(monthId, planDate);
  }
  if (!dayFolderId) { showToast('❌ Не удалось найти папку для даты', 'error'); return; }

  let success = 0, errors = 0;
  for (const plan of unpublished) {
    try {
      const res = await fetch(ASTRA_API.relink, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Accept': 'application/json, text/plain, */*' },
        body: JSON.stringify({ EntityID: parseInt(plan.target_id), NewParentID: dayFolderId })
      });
      if (res.ok) { wsSend({ type: 'MARK_PUBLISHED', planId: plan.id }); success++; }
      else { console.error('[publish]', await res.text()); errors++; }
    } catch (err) { console.error('[publish]', err); errors++; }
  }
  showToast(`✅ Опубликовано: ${success}${errors ? `, ошибок: ${errors}` : ''}`, success > 0 ? 'success' : 'error');
  localStorage.removeItem(CACHE_KEY_DATES);
  await renderDatePanel(true);
}

async function getParentFolderId(folderId) {
  try {
    const res = await fetch(`${ASTRA_API.entity}/${folderId}`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
    if (!res.ok) return null;
    return (await res.json()).parentEntityID || null;
  } catch { return null; }
}

async function findOrCreateDayFolder(parentId, date) {
  const parts  = date.split('-');
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const title  = `${parseInt(parts[2])} ${months[parseInt(parts[1])-1]} ${parts[0]}г.`;
  const children = await fetchFolderChildren(parentId);
  const existing = children.find(item => { const e = item.entity||item; return e.templateID===1 && parseFolderDate(e.title)===date; });
  if (existing) return (existing.entity||existing).id;
  const res = await fetch(ASTRA_API.createUpdate, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}`, 'Accept': 'application/json, text/plain, */*' },
    body: JSON.stringify({ id: 0, parentEntityID: parentId, templateID: 1, title, parameters: {}, createdBy: {} })
  });
  if (!res.ok) throw new Error('Ошибка создания папки дня');
  return (await res.json()).id;
}

async function deleteTargetFromAstraMap(targetId) {
  const token = getToken();
  try {
    showToast('⏳ Удаляем...', 'info');
    const res = await fetch(`${ASTRA_API.delete}/${targetId}?cascade=true`, {
      method: 'DELETE', credentials: 'include',
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json, text/plain, */*' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast(`✅ Цель ${targetId} удалена`, 'success');
    wsSend({ type: 'UPDATE' });
    loadPlanningTargets();
    Object.keys(localStorage).filter(k => k.startsWith(CACHE_KEY_PREFIX)).forEach(k => localStorage.removeItem(k));
  } catch (err) { console.error('[delete]', err); showToast('Ошибка удаления: ' + err.message, 'error'); }
}

async function planTargetForDate(targetId, targetTitle, planDate, rowData) {
  try {
    showToast('⏳ Планируем...', 'info');
    wsSend({
      type:       'CREATE_PLAN',
      planDate,
      targetId:   String(targetId),
      targetData: rowData || { targetNumber: targetId, characteristic: targetTitle },
      note:       'Запланировано из панели Спланировано',
    });
    const parts = planDate.split('-');
    showToast(`✅ Цель запланирована на ${parts[2]}.${parts[1]}`, 'success');
    // Сразу обновляем колонку в текущей таблице без ожидания ответа сервера
    updatePlanDateInPlanning({ plan_date: planDate, target_id: String(targetId) });
    loadPlanningTargets();
  } catch (err) {
    console.error('[plan]', err);
    showToast('Ошибка планирования: ' + err.message, 'error');
  }
}

// Модал выбора даты (возвращает Promise с датой или null)
function showDatePickerModal(minDate) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,0.6);
      display:flex;align-items:center;justify-content:center;z-index:10003;
      font-family:system-ui,sans-serif;
    `;
    modal.innerHTML = `
      <div style="background:white;border-radius:10px;padding:24px;width:90%;max-width:320px;">
        <h3 style="margin:0 0 16px;font-size:16px;">🗓 Выберите дату</h3>
        <input id="customPlanDate" type="date" min="${minDate}"
          style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;
                 font-size:14px;box-sizing:border-box;" />
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
          <button id="cancelPlanDate"
            style="padding:7px 16px;border:1px solid #ccc;border-radius:6px;cursor:pointer;">
            Отмена
          </button>
          <button id="confirmPlanDate"
            style="padding:7px 16px;background:#2563eb;color:white;border:none;
                   border-radius:6px;cursor:pointer;font-weight:600;">
            Выбрать
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#cancelPlanDate').addEventListener('click', () => {
      modal.remove(); resolve(null);
    });
    modal.querySelector('#confirmPlanDate').addEventListener('click', () => {
      const val = modal.querySelector('#customPlanDate').value;
      modal.remove();
      resolve(val || null);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ПАПКИ И ДАТЫ
// ═══════════════════════════════════════════════════════════════════════════

// Загрузить дочерние элементы папки (один уровень)
async function fetchFolderChildren(parentId) {
  const token = getToken();
  const body = {
    maxDepth: 1,
    withCounters: true,
    sortingParams: { field: 'title', destination: 'asc', folderFirst: 'desc' },
    filterCriteria: [],
    templateIDs: [1], // только папки, объекты не нужны при обходе дерева
    parentEntityID: parentId,
  };
  const res = await fetch(ASTRA_API.search, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.entities || data.items || [];
}

// Разобрать title папки в дату. Форматы: "20 мая 2026 г.", "19 мая 2026г.", "2026-05-20"
const MONTH_MAP = {
  'января':1,'февраля':2,'марта':3,'апреля':4,'мая':5,'июня':6,
  'июля':7,'августа':8,'сентября':9,'октября':10,'ноября':11,'декабря':12
};

function parseFolderDate(title) {
  if (!title) return null;
  // Формат "20 мая 2026 г." или "20 мая 2026г."
  const m = title.match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i);
  if (m) {
    const day   = parseInt(m[1]);
    const month = MONTH_MAP[m[2].toLowerCase()];
    const year  = parseInt(m[3]);
    if (month) return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }
  // Формат ISO "2026-05-20"
  if (/^\d{4}-\d{2}-\d{2}$/.test(title.trim())) return title.trim();
  return null;
}

// Получить список дат из папок (с кэшем в localStorage)
// Парсим название папки-месяца в номер месяца и год
// Форматы: "Май 2026 г.", "май 2026г.", "05.2026 г.", "2026-05"
function parseMonthFolder(title) {
  if (!title) return null;

  // Формат "Май 2026 г." / "май 2026г."
  const mRu = title.match(/([а-яё]+)\s+(\d{4})/i);
  if (mRu) {
    const month = MONTH_MAP[mRu[1].toLowerCase()];
    const year  = parseInt(mRu[2]);
    if (month && year) return { month, year };
  }

  // Формат "05.2026" / "05.2026 г."
  const mDot = title.match(/(\d{2})\.(\d{4})/);
  if (mDot) return { month: parseInt(mDot[1]), year: parseInt(mDot[2]) };

  // Формат "2026-05"
  const mIso = title.match(/(\d{4})-(\d{2})/);
  if (mIso) return { month: parseInt(mIso[2]), year: parseInt(mIso[1]) };

  return null;
}

async function loadDateFolders(forceRefresh = false) {
  // Проверяем кэш
  if (!forceRefresh) {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        console.log('[dates] Из кэша:', cached.dates.length, 'дат');
        return cached.dates;
      }
    } catch {}
  }

  console.log('[dates] Загружаем папки...');

  try {
    // Текущий месяц и предыдущий (на случай перехода месяца)
    const now      = new Date(Date.now() + 3 * 60 * 60 * 1000); // МСК
    const curYear  = now.getFullYear();
    const curMonth = now.getMonth() + 1;

    // Предыдущий месяц
    const prevMonth = curMonth === 1 ? 12 : curMonth - 1;
    const prevYear  = curMonth === 1 ? curYear - 1 : curYear;

    // Шаг 1: дочерние папки ГООП — ищем папки текущего и предыдущего месяца
    const level1 = await fetchFolderChildren(ROOT_FOLDER_ID);
    console.log('[dates] Папок в ГООП:', level1.length);

    // Находим папки нужных месяцев
    const monthFolders = [];
    for (const item of level1) {
      const e = item.entity || item;
      if (!e || e.templateID !== 1) continue;

      const parsed = parseMonthFolder(e.title);
      if (!parsed) continue;

      const isCurrent  = parsed.month === curMonth  && parsed.year === curYear;
      const isPrevious = parsed.month === prevMonth && parsed.year === prevYear;

      if (isCurrent || isPrevious) {
        monthFolders.push({ id: e.id, title: e.title, parsed });
        console.log(`[dates] Найдена папка месяца: "${e.title}" (id:${e.id})`);
      }
    }

    if (monthFolders.length === 0) {
      console.warn('[dates] Папки текущего/предыдущего месяца не найдены');
    }

    // Шаг 2: для каждой папки месяца берём дочерние папки-дни
    const dateFolders = [];
    for (const mf of monthFolders) {
      const days = await fetchFolderChildren(mf.id);
      for (const item of days) {
        const e = item.entity || item;
        if (!e || e.templateID !== 1) continue;

        const date = parseFolderDate(e.title);
        if (!date) continue;

        dateFolders.push({
          date,
          title:       e.title,
          folderId:    e.id,
          entityCount: item.childrenCount || 0,
        });
        console.log(`[dates] Папка дня: "${e.title}" → ${date} (${item.childrenCount || 0} объектов)`);
      }
    }

    // Группируем по дате (убираем дубли если одна дата в нескольких ветках)
    const dateMap = {};
    for (const folder of dateFolders) {
      if (!dateMap[folder.date]) {
        dateMap[folder.date] = {
          date:        folder.date,
          title:       folder.title,
          folderIds:   [folder.folderId],
          folderId:    folder.folderId,
          entityCount: folder.entityCount,
        };
      } else {
        dateMap[folder.date].folderIds.push(folder.folderId);
        dateMap[folder.date].entityCount += folder.entityCount;
      }
    }

    // Сортируем по убыванию (новые слева)
    const uniqueDates = Object.values(dateMap)
      .sort((a, b) => b.date.localeCompare(a.date));

    localStorage.setItem(CACHE_KEY_DATES, JSON.stringify({ ts: Date.now(), dates: uniqueDates }));
    console.log('[dates] Итого дат:', uniqueDates.length);
    return uniqueDates;

  } catch (err) {
    console.error('[dates] Ошибка:', err);
    return [];
  }
}

// Загрузить объекты из папки(ок) даты (с кэшем)
// folderIds — массив всех папок этой даты (могут быть в разных ветках дерева)
async function loadTargetsFromFolder(folderIds, dateKey, forceRefresh = false) {
  const cacheKey = CACHE_KEY_PREFIX + dateKey;

  if (!forceRefresh) {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        console.log(`[dates] Цели за ${dateKey} из кэша:`, cached.rows.length);
        return cached.rows;
      }
    } catch {}
  }

  // Поддержка как массива так и одиночного id (обратная совместимость)
  const ids = Array.isArray(folderIds) ? folderIds : [folderIds];
  console.log(`[dates] Загружаем цели из ${ids.length} папок за ${dateKey}...`);

  const token = getToken();

  // Загружаем из всех папок параллельно
  const allItemsArrays = await Promise.all(ids.map(async folderId => {
    const body = {
      maxDepth: 5, // увеличено — объекты могут лежать в подпапках (напр. "спланировано на...")
      withCounters: false,
      sortingParams: { field: 'title', destination: 'asc', folderFirst: 'desc' },
      filterCriteria: [],
      templateIDs: [1, 2],
      parentEntityID: folderId,
    };
    const res = await fetch(ASTRA_API.search, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.entities || data.items || [];
  }));

  // Объединяем результаты, убираем дубли по id
  const seenIds = new Set();
  let allItems = [];
  for (const items of allItemsArrays) {
    for (const item of items) {
      const id = (item.entity || item)?.id;
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      allItems.push(item);
    }
  }

  // Фильтруем только объекты (templateID=2) с координатами
  console.log(`[dates] Всего элементов из папок:`, allItems.length);

  const items = allItems.filter(item => {
    const e = item.entity || item;
    if (!e) return false;
    // templateID=2 — объект (не папка)
    if (e.templateID !== 2) return false;
    // Проверяем наличие координат
    const hasCoords = e.parameters?.['1']?.value?.coordinates;
    if (!hasCoords) {
      console.warn(`[dates] Объект ${e.id} "${e.title}" без координат — пропускаем`);
    }
    return hasCoords;
  });

  console.log(`[dates] После фильтрации объектов с координатами:`, items.length);

  // Конвертируем в формат таблицы (та же логика что в loadFromAstraMap)
  const tableRows = items.map(item => {
    const e      = item.entity || item;
    const params = e.parameters || {};
    const coords = params['1'].value.coordinates;
    const lon    = coords[0];
    const lat    = coords[1];
    const conv   = convertWgs84ToSk42(lon, lat);

    const defeatTimeISO = params['12']?.value || '';
    let defeatDate = '', impactTime = '';
    if (defeatTimeISO) {
      defeatDate = utcIsoToMskDate(defeatTimeISO);
      impactTime = utcIsoToMskTime(defeatTimeISO);
    }

    const resultValue = params['7']?.value || '';
    const resultMap = {
      'Поражена':'поражена','Не поражена':'не_поражена',
      'Вскрыто':'вскрыто','Передано на доразведку':'передано_на_доразведку',
      'Принятно на доразведку':'принятно_на_доразведку','Подтверждена':'подтверждена'
    };
    const result = resultMap[resultValue] || 'вскрыто';

    const catMap = {
      // Пункты управления
      '1010000':'ПУ','1010100':'ПУ армии','1010200':'ПУ корпуса',
      '1010300':'ПУ дивизии','1010400':'ПУ бригады','1010500':'ПУ полка',
      '1010600':'ПУ батальона','1010700':'ПУ роты','1010800':'ПУ взвода',
      '1010900':'ПУ отделения','1011000':'ПУ группы','1011100':'КНП',
      // Бронетехника
      '1040000':'Бронетехника',
      '1040201':'Т-55','1040202':'Танк','1040203':'Т-72','1040204':'БМП',
      '1040205':'ББМ','1040206':'БТР','1040207':'БРДМ','1040208':'БМД',
      '1040209':'МТ-ЛБ','1040210':'Бронеавтомобиль',
      // Артиллерия
      '1040301':'Гаубица','1040302':'САУ','1040303':'РСЗО',
      '1040304':'Миномёт','1040305':'Пушка','1040306':'ПТРК',
      '1040307':'БМ ПТУР','1040308':'Орудие',
      // РЛС и РЭБ
      '1040401':'РЛС (общ)','1040402':'РЛС','1040403':'РЛС АРТ',
      '1040404':'РЛС ПВО','1040405':'РЛС БПЛА','1040406':'РЛС НРТР',
      '1040407':'РЛС разв.','1040408':'РЛС управл.',
      '1100000':'РЭБ','1100100':'РЭБ (станция)','1100200':'РЭБ (комплекс)',
      '1100300':'РЭБ (авт.)','1100400':'РЭБ (носимый)','1100500':'РЭБ БПЛА',
      // ПВО / ЗРК
      '1040500':'ПВО',
      '1040501':'ПЗРК','1040502':'ЗРК малой дальн.','1040503':'ЗРК',
      '1040504':'ЗРК средней дальн.','1040505':'ЗРК большой дальн.',
      '1040506':'ЗАК','1040507':'ЗРК (авт.)',
      // БПЛА
      '1080000':'БПЛА',
      '1080100':'БПЛА разв.','1080200':'Точка влета','1080300':'ПУ БПЛА',
      '1080301':'ПУ БПЛА (малый)','1080302':'ПУ БПЛА (средний)',
      '1080303':'ПУ БПЛА (большой)','1080304':'ПУ БПЛА (авт.)',
      '1080400':'Аэродром БПЛА',
      // Связь
      '1090000':'Связь','1090100':'Узел связи','1090200':'Ретранслятор',
      '1090300':'Радиостанция','1090400':'КВ-станция','1090500':'УКВ-станция',
      // Укрытия и позиции
      '1110000':'Укрытие',
      '1110100':'Укрытие','1110101':'Блиндаж','1110102':'Окоп',
      '1110103':'Траншея','1110104':'ДЗОТт','1110105':'ДОТ',
      '1110200':'Позиция','1110300':'Рубеж','1110400':'Район',
      // Склады
      '1130000':'Склад','1130900':'Склад','1130901':'Склад БП',
      '1130902':'Склад ГСМ','1130903':'Склад продовольствия',
      '1130904':'Склад техники','1130905':'Склад РАВ',
      // Прочее
      '1020000':'Личный состав','1030000':'Инженерные объекты',
      '1050000':'Авиация','1060000':'ВМФ','1070000':'Тыл',
      '1120000':'Объект инфраструктуры','1140000':'Прочее',
    };
    const characteristic = catMap[params['6']?.value] || '';

    return {
      targetNumber: e.id || '',
      characteristic,
      coordX: conv.y,
      coordY: conv.x,
      originalLon: lon,
      originalLat: lat,
      impactTime,
      result,
      defeatDate,
    };
  });

  // Кэшируем только если есть результат
  if (tableRows.length > 0) {
    localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), rows: tableRows }));

    // Обновляем счётчик непоражённых в astra_dates_tree
    updateUndefeatedCountInTree(dateKey, tableRows);
  } else {
    localStorage.removeItem(cacheKey);
  }
  console.log(`[dates] Загружено ${tableRows.length} целей за ${dateKey}`);
  return tableRows;
}

// Отрисовать кнопки дат в панели
async function renderDatePanel(forceRefresh = false) {
  const list = document.querySelector('#dates-list');
  if (!list) return;

  list.innerHTML = '<span style="font-size:11px;color:#5a7fa0;">загрузка...</span>';

  const dates = await loadDateFolders(forceRefresh);

  if (!dates.length) {
    list.innerHTML = '<span style="font-size:11px;color:#5a7fa0;">папки не найдены</span>';
    return;
  }

  list.innerHTML = '';

  // Берём последние 14 дат
  if (dates.length > 0) {
    latestFolderId   = dates[0].folderId;
    latestFolderDate = dates[0].date;
    console.log('[dates] Крайняя папка:', latestFolderDate, 'id:', latestFolderId);
    updateAddTargetBtn();
  }

  dates.slice(0, 14).forEach(d => {
    const btn = document.createElement('button');

    // Короткий формат даты: "20.05"
    const parts = d.date.split('-');
    const shortDate = parts.length === 3 ? `${parts[2]}.${parts[1]}` : d.date;

    btn.textContent = shortDate;
    btn.title = `${d.title} (${d.entityCount} объектов)`;
    // Обёртка — позиционирует кнопку и бейдж
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;display:inline-flex;';

    btn.setAttribute('data-date', d.date);
    btn.setAttribute('data-folder-id', d.folderId);
    btn.classList.add('date-tab-btn');
    btn.title = `${d.title} (${d.entityCount} объектов)`;
    btn.innerHTML = shortDate;
    btn.style.cssText = `
      padding: 3px 7px; border-radius: 12px; font-size: 10px; cursor: pointer;
      border: 1px solid rgb(74,122,155); background: rgb(30,58,95);
      color: rgb(168,204,232); transition: 0.15s; min-height: 32px;
      white-space: nowrap; display:inline-flex; align-items:center;
    `;

    // Бейдж непоражённых целей
    const badge = document.createElement('span');
    badge.classList.add('date-undefeated-badge');
    badge.setAttribute('data-date', d.date);
    badge.style.cssText = `
      display:none; position:absolute; top:-6px; right:-6px;
      background:#e53e3e; color:white; border-radius:50%;
      min-width:16px; height:16px; font-size:9px; font-weight:700;
      align-items:center; justify-content:center; padding:0 3px;
      border:1px solid rgb(30,58,95);
    `;

    btn.addEventListener('mouseenter', () => {
      if (!btn.classList.contains('active-date')) {
        btn.style.background = 'rgb(44,82,130)';
        btn.style.color = '#fff';
      }
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.classList.contains('active-date')) {
        btn.style.background = 'rgb(30,58,95)';
        btn.style.color = 'rgb(168,204,232)';
      }
    });

    btn.addEventListener('click', async () => {
      // Подсвечиваем активную
      list.querySelectorAll('button').forEach(b => {
        b.classList.remove('active-date');
        b.style.background = '#1e3a5f';
        b.style.color = '#a8cce8';
        b.style.border = '1px solid #4a7a9b';
      });
      btn.classList.add('active-date');
      btn.style.background = '#2563eb';
      btn.style.color = '#fff';
      btn.style.border = '1px solid #60a5fa';

      // Сохраняем активную папку и обновляем кнопку
      activeFolderId   = d.folderId;
      activeFolderDate = d.date;
      updateAddTargetBtn();

      // Переключаемся на вкладку целей — скрываем все панели, показываем таблицу
      const tasksPanel    = document.querySelector('#tasksPanel');
      const tableWrapper  = document.querySelector('.table-wrapper');
      const planningPanel = document.querySelector('#planningPanel');
      if (tasksPanel)    tasksPanel.style.display    = 'none';
      if (planningPanel) planningPanel.style.display = 'none';
      if (tableWrapper)  tableWrapper.style.display  = '';
      const showBtn = document.querySelector('#showTasksBtn');
      if (showBtn) showBtn.textContent = '📋 Задачи';
      const planBtn = document.querySelector('#showPlanningBtn');
      if (planBtn) planBtn.textContent = '📅 Спланировано';

      btn.textContent = '⏳';
      let rows = [];
      try {
        rows = await loadTargetsFromFolder(d.folderIds || d.folderId, d.date, true);
        populateTable(rows);
        // Обновляем tasksByTarget после загрузки
        refreshAllTaskCells();
        loadPlansForDate(d.date);
        disableTaskButtonsIfPast();
      } catch (err) {
        console.error('[dates] Ошибка загрузки целей:', err);
        showToast('Ошибка загрузки целей', 'error');
      } finally {
        btn.innerHTML = shortDate;
        updateUndefeatedBadge(d.date, rows);
      }
    });


    wrap.appendChild(btn);
    wrap.appendChild(badge);
    list.appendChild(wrap);
  });
}

// Загрузить цели за конкретную дату через папки (используется кнопками Сегодня/Вчера)
async function loadByDateFromPanel(date) {
  // Устанавливаем активную дату
  activeFolderDate = date;
  // Берём даты из кэша
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
    const dates  = cached?.dates || [];
    const found  = dates.find(d => d.date === date);

    if (found) {
      // Нашли папку — загружаем из неё
      console.log(`[dates] Загружаем ${date} из папки ${found.folderId}`);
      const rows = await loadTargetsFromFolder(found.folderIds || found.folderId, date);
      populateTable(rows);
      updateUndefeatedBadge(date, rows);
      refreshAllTaskCells();
      // Подсвечиваем кнопку даты если она есть
      loadPlansForDate(date);
      document.querySelectorAll('.date-tab-btn').forEach(b => {
      disableTaskButtonsIfPast();
        const isThis = b.getAttribute('data-date') === date;
        b.classList.toggle('active-date', isThis);
        b.style.background = isThis ? 'rgb(37,99,235)' : 'rgb(30,58,95)';
        b.style.color      = isThis ? '#fff' : 'rgb(168,204,232)';
        b.style.border     = isThis ? '1px solid rgb(96,165,250)' : '1px solid rgb(74,122,155)';
      });
    } else {
      // Папка не найдена — обновляем список дат и пробуем снова
      console.log(`[dates] Папка за ${date} не найдена в кэше, обновляем...`);
      await renderDatePanel(true);
      const fresh  = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
      const found2 = fresh?.dates?.find(d => d.date === date);
      if (found2) {
        const rows = await loadTargetsFromFolder(found2.folderIds || found2.folderId, date);
        populateTable(rows);
        updateUndefeatedBadge(date, rows);
        refreshAllTaskCells();
        loadPlansForDate(date);
      } else {
        disableTaskButtonsIfPast();
        showToast(`Нет папки за ${date}`, 'info');
        populateTable([]);
      }
    }
  } catch (err) {
    console.error('[dates] loadByDateFromPanel:', err);
    showToast('Ошибка загрузки', 'error');
  }
}

connectWS();