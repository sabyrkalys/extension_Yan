/// ======================== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ========================
// Состояние приложения — store.js (content/store/store.js)
// Используем геттеры/сеттеры: store.get('myRole'), store.set('myRole', val)
// Локальные UI-переменные (не нужны в store):
let popupElement = null;
let lon = null;
let lat = null;
let map = null;

// Прокси-переменные — позволяют старому коду работать без изменений
let myRole        = null;
let myUsername    = null;
let myDisplayName = null;
let myUserId      = null;
let activeFolderId   = null;
let activeFolderDate = null;
let latestFolderId   = null;
let latestFolderDate = null;

// Счётчик непрочитанных задач — используется в tasks.js и wsHandlers.js
let unreadTaskCount = 0;

// ROLE_TO_USERS определён в config.js (подключается первым в manifest.json)

// Определить роль по username — перебираем все роли и ищем username в массиве
function resolveRoleLocally(username) {
  for (const [role, users] of Object.entries(ROLE_TO_USERS)) {
    if (users.includes(username)) return role;
  }
  return null; // не найден — покажем ручной выбор
}

// Проверка при старте — тихое предупреждение, без alert (токен может появиться позже)
if (!getToken()) {
  console.warn('⚠️ [config] Токен авторизации не найден — ожидаем входа пользователя');
}

// convertWgs84ToSk42, convertSk42ToWgs84 — content/utils/coords.js

// ======================== API НАСТРОЙКИ ========================
// ASTRA_API, ROOT_FOLDER_ID, CACHE_KEY_PREFIX, CACHE_KEY_DATES, CACHE_TTL_MS
// — определены в config.js (подключается первым в manifest.json)

// cleanOldCache, cacheGet, cacheSet, cacheDelete, cacheClearAll — content/cache/cache.js

// connectWS, wsSend, wsRegister, wsRegisterWithUser — content/ws/wsClient.js

// handleWsMessage, handleIncomingTask, wsRegisterWithUser, wsRegister, wsSend — content/ws/

// ── Рендер ячейки «Назначить задачу» в основной таблице ─────────────────────────
// Показывает текущую активную задачу по цели (видят все) + кнопку назначить новую.
// renderTaskCell, openNewTaskModal — content/ui/tasks.js


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
// → content/ui/tasks.js или content/ui/planning.js


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
                  ${r._date.slice(8)}.${r._date.slice(5,7)}<br>
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
                      data-plan-date="today"
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
                      data-plan-date="tomorrow"
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

    // Обработчик кнопки удалить — защита от двойного клика
    panel.querySelectorAll('.planning-delete-btn').forEach(btn => {
      btn.addEventListener('click', withLock(btn, async () => {
        const targetId = btn.getAttribute('data-target-id');
        if (!confirm(`Удалить цель ${targetId} из AstraMap?`)) return;
        await apiDeleteTarget(targetId);
      }, { label: '⏳' }));
    });

    // Кнопки планирования — защита от двойного клика
    panel.querySelectorAll('.planning-task-btn').forEach(btn => {
      btn.addEventListener('click', withLock(btn, async () => {
        if (!myRole) { showToast('Сначала войдите — расчёт не определён', 'error'); return; }

        const targetId    = btn.getAttribute('data-target-id');
        const targetTitle = btn.getAttribute('data-target-title');
        // Дата всегда пересчитывается в момент клика — не из атрибута
        const _planMarker = btn.getAttribute('data-plan-date');
        const today    = getMoscowDateStr();
        const tomorrow = new Date(Date.now() + 3*3600000 + 86400000)
                           .toISOString().slice(0,10);
        let planDate;
        if (_planMarker === 'today')    planDate = today;
        else if (_planMarker === 'tomorrow') planDate = tomorrow;
        else if (_planMarker === 'pick') {
          planDate = await showDatePickerModal(tomorrow);
          if (!planDate) return;
        } else {
          planDate = _planMarker; // явная дата
        }

        if (planDate < today) {
          showToast('❌ Нельзя планировать на прошедшую дату', 'error');
          return;
        }

        console.log('[plan] Планируем на:', planDate, '(маркер:', _planMarker + ')');

        const row     = btn.closest('tr');
        const rowDate = row?.getAttribute('data-row-date');
        const rowData = {
          targetNumber:   targetId,
          characteristic: targetTitle,
          coordX:         btn.getAttribute('data-coord-x') || '',
          coordY:         btn.getAttribute('data-coord-y') || '',
          impactTime:     btn.getAttribute('data-impact-time') || '',
          result:         'вскрыто',
          defeatDate:     btn.getAttribute('data-defeat-date') || rowDate || '',
          _date:          rowDate || activeFolderDate || '',
        };
        await planTargetForDate(targetId, targetTitle, planDate, rowData);
      }, { label: '⏳' }));
    });

  } catch (err) {
    console.error('[planning]', err);
    panel.innerHTML = '<div style="padding:20px;color:#dc3545;">Ошибка загрузки</div>';
  }
}

// ── Перенос задачи на другой день ────────────────────────────────────────────
// showRescheduleModal — content/ui/tasks.js

  // const today = getMoscowDateStr();
  // if (!activeFolderDate || activeFolderDate >= today) return;
  // document.querySelectorAll('#statusTable td[data-target-id] button').forEach(btn => {
  //   btn.disabled = true;
  //   btn.style.opacity = '0.35';
  //   btn.style.cursor  = 'not-allowed';
  //   btn.title = 'Недоступно для прошедших дат';
  // });


// ── Перерисовать все ячейки задач в таблице целей (после загрузки истории)
// → content/ui/tasks.js или content/ui/planning.js

// Обновить ячейку задачи в таблице целей при изменении статуса
// → content/ui/tasks.js или content/ui/planning.js

// showRoleSelector, selectRoleManually — content/ui/roleSelector.js




// showToast — content/ui/toast.js

  // const el = document.createElement('div');
  // el.style.cssText = `
  //   position: fixed; top: 80px; right: 20px; z-index: 99998;
  //   background: white; border-left: 4px solid #fd7e14;
  //   border-radius: 8px; padding: 16px 20px; width: 300px;
  //   box-shadow: 0 6px 24px rgba(0,0,0,0.2); font-family: system-ui, sans-serif;
  //   animation: slideInToast 0.3s ease;
  // `;
  // const fromName = task.from_role || task.from || '?';
  // const targetHint = task.targetTitle || task.target_title || '';

  // el.innerHTML = `
  //   <div style="font-weight:600;color:#fd7e14;margin-bottom:6px;">📋 Новая задача от: ${fromName}</div>
  //   <div style="font-size:13px;color:#333;margin-bottom:4px;">${task.text}</div>
  //   ${targetHint ? `<div style="font-size:12px;color:#666;">Объект: ${targetHint}</div>` : ''}
  //   <div style="display:flex;gap:8px;margin-top:12px;">
  //     <button class="notif-accept" style="flex:1;padding:6px;background:#28a745;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">✅ Принять</button>
  //     <button class="notif-reject" style="flex:1;padding:6px;background:#dc3545;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">❌ Отклонить</button>
  //   </div>
  // `;

  // // addEventListener вместо onclick — content.js изолирован от window страницы
  // el.querySelector('.notif-accept').addEventListener('click', () => {
  //   acceptTask(task.id);
  //   el.remove();
  // });
  // el.querySelector('.notif-reject').addEventListener('click', () => {
  //   rejectTask(task.id);
  //   el.remove();
  // });

  // document.body.appendChild(el);
  // setTimeout(() => el.remove(), 15000); 



// toISOWithTime, utcIsoToMskTime, utcIsoToMskDate,
// getMoscowNowISO, getMoscowDateStr, getMoscowTimeStr — content/utils/date.js

// async function getTargetById(id) { → content/api/astraApi.js

// async function getHeightAtPoint(lon, lat) { → content/api/astraApi.js

// function parseCoord(coordStr) { → content/api/astraApi.js

// ✅ FIX: Исправлен маппинг — "не поражена" → "Не поражена" (не "Вскрыто")
// function mapResult(result) { → content/api/astraApi.js

// function mapTargetType(characteristic) { → content/api/astraApi.js

// inject.js загружается браузером напрямую (world: MAIN в manifest.json)
// — динамический injectScript() больше не нужен

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

  const resolved = resolveOfficeAndRole(username);
  if (resolved) {
    myRole = resolved.role;
    store.set('myOfficeId', resolved.officeId);
    console.log('[content] ✅ Роль определена:', myRole, '| Офис:', resolved.officeId);
  } else {
    const localRole = resolveRoleLocally(username);
    if (localRole) { myRole = localRole; }
    store.set('myOfficeId', store.get('myOfficeId') || 'HQ');
    console.log('[content] ⚠️ Роль/офис не найдены для:', username, '→ используем HQ');
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
let _fetchProfileInProgress = false;
async function fetchProfileDirect() {
  if (_fetchProfileInProgress) return;
  if (myUsername) return; // уже определили — до флага чтобы не залочить
  _fetchProfileInProgress = true;

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
  } finally {
    _fetchProfileInProgress = false;
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

// apiSendTarget → content/api/astraApi.js

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
      showToast(`За ${date} целей не найдено`, 'info');
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

      const categoryValue  = params["6"]?.value || '';
      const resultCategory = TARGET_TYPE_MAP[categoryValue] || '';

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

    // Дедупликация — убираем дубли по targetNumber (могут появиться при двойном клике)
    const uniqueRows = deduplicateById(tableRows, 'targetNumber');
    if (uniqueRows.length < tableRows.length) {
      console.warn(`[load] Убрано дублей: ${tableRows.length - uniqueRows.length}`);
    }

    populateTable(uniqueRows);
    showToast(`✅ Загружено ${uniqueRows.length} целей за ${date}`, 'success');

  } catch (error) {
    console.error('Ошибка поиска:', error);
    showToast(`❌ Не удалось загрузить данные за ${date}`, 'error');
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
    const targetNumber = cells[0]?.innerText.trim() || (idx + 1).toString();
    const characteristicSelect = cells[1]?.querySelector('select');
    const characteristic = characteristicSelect ? characteristicSelect.value : '';
    const coordX = cells[2]?.innerText.trim() || '';
    const coordY = cells[3]?.innerText.trim() || '';
    const impactTime = cells[4]?.innerText.trim() || '';
    const resultSelect = cells[5]?.querySelector('select');
    const result = resultSelect ? resultSelect.value : '';
    const defeatDate = cells[6]?.innerText.trim() || '';
    data.push({ targetNumber, characteristic, coordX, coordY, impactTime, result, defeatDate });
  });
  return data;
}

// ✅ FIX: убран параметр coordinates (теперь каждая строка содержит свои originalLon/Lat)
function populateTable(dataArray) {
  const tbody = document.querySelector('#statusTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  // Дедупликация по targetNumber — защита от двойной загрузки
  const rows = deduplicateById(dataArray, 'targetNumber');
  if (rows.length < dataArray.length) {
    console.warn(`[table] Убрано дублей: ${dataArray.length - rows.length}`);
  }

  rows.forEach((item, idx) => {
    const row = tbody.insertRow();

    // Выделяем поражённые цели оранжевым фоном
    const DEFEATED_RESULTS = ['поражена', 'подтверждено', 'подавлено'];
    if (DEFEATED_RESULTS.includes(item.result)) {
      row.style.background = 'rgba(255, 140, 0, 0.15)';
      row.style.borderLeft = '3px solid #fd7e14';
    }

    const cellNum = row.insertCell(0);
    cellNum.innerText = item.targetNumber || (idx + 1).toString();

    const cellChar = row.insertCell(1);
    const selectChar = document.createElement('select');
    const categories = ['ПУ', 'ПУ БПЛА', 'Точка влета', 'РЛС', 'РЭБ', 'ЗРК', 'Укрытие', 'Связь', 'Танк', 'БМП', 'ББМ', 'Склад', 'КНП'];
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Категория';
    defaultOpt.disabled = true;
    defaultOpt.selected = true;
    selectChar.appendChild(defaultOpt);
    categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      if (item.characteristic === cat) opt.selected = true;
      selectChar.appendChild(opt);
    });
    cellChar.appendChild(selectChar);

    const cellX = row.insertCell(2);
    cellX.innerText = item.coordX || '';
    cellX.setAttribute('contenteditable', 'true');
    cellX.setAttribute('cellX', item.originalLon ?? '');  // lon для обратной конвертации
    cellX.classList.add('editable');

    const cellY = row.insertCell(3);
    cellY.innerText = item.coordY || '';
    cellY.setAttribute('contenteditable', 'true');
    cellY.setAttribute('cellY', item.originalLat ?? '');  // lat для обратной конвертации
    cellY.classList.add('editable');

    const cellTime = row.insertCell(4);
    cellTime.innerText = item.impactTime || '';
    cellTime.setAttribute('contenteditable', 'true');
    cellTime.classList.add('editable');

    const cellRes = row.insertCell(5);
    const selectRes = document.createElement('select');
    const defaultRes = document.createElement('option');
    defaultRes.value = '';
    defaultRes.textContent = 'Результат';
    defaultRes.disabled = true;
    defaultRes.selected = true;
    selectRes.appendChild(defaultRes);
    const resOpts = [
      { val: 'поражена', txt: 'Поражена' },
      { val: 'не_поражена', txt: 'Не поражена' },
      { val: 'вскрыто', txt: 'Вскрыто' },
      { val: 'передано_на_доразведку', txt: 'Передано на доразведку' },
      { val: 'подтверждено', txt: 'Подтверждено' },
      { val: 'принято_на_доразведку', txt: 'Принято на доразведку' },
    ];
    resOpts.forEach(opt => {
      const option = document.createElement('option');
      option.value = opt.val;
      option.textContent = opt.txt;
      if (item.result === opt.val) option.selected = true;
      selectRes.appendChild(option);
    });
    cellRes.appendChild(selectRes);

    const cellDate = row.insertCell(6);
    cellDate.innerText = item.defeatDate || '';
    cellDate.classList.add('date-cell');

    const cellView = row.insertCell(7);
    const btnView = document.createElement('a');
    btnView.classList.add("btnView");
    // ID объекта вставляется прямо в путь URL — приложение само перейдёт к нужной цели
    const targetEntityId = item.targetNumber || '';
    btnView.href = `https://center.astramaps.ru/map/${targetEntityId}`;
    btnView.setAttribute('data-entity-id', targetEntityId);
    btnView.target = '_blank';       // открываем в новой вкладке — текущая остаётся
    btnView.rel = 'noopener noreferrer';
    btnView.innerHTML = '👁️';
    btnView.title = 'Просмотр в AstraM (откроется в новой вкладке)';
    btnView.style.cssText = 'display:inline-block; padding: 5px 10px; background: #2c7da0; color: white; border-radius: 4px; cursor: pointer; font-size: 18px; text-decoration: none;';

    const cellTask = row.insertCell(8);
    cellTask.setAttribute('data-target-id', item.targetNumber || '');
    cellTask.style.cssText = 'text-align:center; vertical-align:middle; padding:4px 6px;';

    // Рендерим содержимое ячейки задачи
    // Кнопка задачи активна только если открыт сегодняшний день
    // или дата не выбрана (кнопка Сегодня)
    const today   = getMoscowDateStr();
    const isToday = activeFolderDate === today || activeFolderDate === null;
    renderTaskCell(cellTask, item.targetNumber || '', item.characteristic || '', isToday);

    // Обработчик не нужен — браузер сам открывает target="_blank" в новой вкладке.
    // Логируем клик для отладки.
    btnView.addEventListener('click', (e) => {
      const entityId = e.currentTarget.getAttribute('data-entity-id');
      console.log('[btnView] Открываем объект', entityId, '→', e.currentTarget.href);
    });
    cellView.appendChild(btnView);

    const cellForm = row.insertCell(9);
    const btnForm = document.createElement('button');
    btnForm.classList.add("btnForm");
    btnForm.innerText = 'Сформировать';
    btnForm.style.cssText = 'padding: 5px 10px; background: #2c7da0; color: white; border: none; border-radius: 4px; cursor: pointer;';
    btnForm.addEventListener('click', withLock(btnForm, async (e) => {
      e.stopPropagation();
      const currentRowData = {
        targetNumber:   cellNum.innerText.trim(),
        characteristic: selectChar.value,
        coordX:         cellX.innerText.trim(),
        coordY:         cellY.innerText.trim(),
        impactTime:     cellTime.innerText.trim(),
        result:         selectRes.value,
        defeatDate:     cellDate.innerText.trim()
      };
      await apiSendTarget(currentRowData);
    }, { label: '⏳ Отправка...' }));
    cellForm.appendChild(btnForm);
  });
}

// ======================== СОЗДАНИЕ ПОПАПА ========================
// function createPopup() { → content/ui/panel.js

// ======================== КНОПКА ЗАКРЫТИЯ ========================
// function closeBtn() { → content/ui/panel.js

// ======================== ДОБАВЛЕНИЕ КНОПКИ НА КАРТУ ========================
// function findAndAddButton() { → content/ui/panel.js

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
// function ContenNew() { → content/ui/panel.js

// Обновить кнопку «+ Добавить цель»
// function updateAddTargetBtn() { → content/ui/panel.js

// ── Найти или создать папку "спланировано на DD.MM.YY г." ──────────────────
// async function findOrCreatePlanFolder(parentFolder → content/api/astraApi.js

// ── Переместить объект в папку (изменить parentEntityID) ─────────────────────
// async function moveEntityToFolder(entityId, newPar → content/api/astraApi.js

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
    const monthId = first ? await apiGetParentFolderId(first.folderId) : null;
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

// async function getParentFolderId(folderId) { → content/api/astraApi.js

// async function findOrCreateDayFolder(parentId, dat → content/api/astraApi.js

// async function deleteTargetFromAstraMap(targetId)  → content/api/astraApi.js

async function planTargetForDate(targetId, targetTitle, planDate, rowData) {
  try {
    showToast('⏳ Планируем...', 'info');

    // Шаг 1: найти folderId целевой папки-дня
    const tree      = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
    const dateEntry = tree?.dates?.find(d => d.date === planDate);
    const folderId  = dateEntry?.folderId || null;

    console.log('[plan] targetId:', targetId, 'planDate:', planDate,
                'folderId:', folderId, 'tree dates:', tree?.dates?.map(d=>d.date));

    if (!folderId) {
      // Попробуем обновить дерево дат и найти снова
      showToast(`⏳ Ищем папку ${planDate}...`, 'info');
      await loadDateFolders(true);
      const tree2      = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
      const dateEntry2 = tree2?.dates?.find(d => d.date === planDate);
      const folderId2  = dateEntry2?.folderId || null;
      if (!folderId2) {
        showToast(`⚠️ Папка для ${planDate} не найдена — создайте её в AstraMap`, 'error');
        return;
      }
      // Рекурсивно вызываем с обновлённым деревом
      return planTargetForDate(targetId, targetTitle, planDate, rowData);
    }

    // Шаг 2: переместить объект в папку нужного дня (relink в AstraMap)
    try {
      const moveResult = await apiMoveEntity(Number(targetId), folderId);
      console.log(`[plan] ✅ Объект ${targetId} перемещён → папка ${folderId} (${planDate})`, moveResult);
    } catch (moveErr) {
      console.warn('[plan] Не удалось переместить объект:', moveErr.message);
      showToast('⚠️ Ошибка перемещения: ' + moveErr.message, 'error');
      return;
    }

    // Шаг 3: записать план в БД
    wsSend({
      type:       'CREATE_PLAN',
      planDate,
      targetId:   String(targetId),
      targetData: rowData || { targetNumber: targetId, characteristic: targetTitle },
      note:       'Запланировано из панели Спланировано',
    });

    // Шаг 4: обновить UI
    const parts = planDate.split('-');
    showToast(`✅ Цель перенесена на ${parts[2]}.${parts[1]}`, 'success');
    updatePlanDateInPlanning({ plan_date: planDate, target_id: String(targetId) });

    // Шаг 5: сбросить кэш исходной папки (_date из rowData) и целевой
    const sourceDateKey = rowData?._date || activeFolderDate || '';
    if (sourceDateKey) cacheDelete(CACHE_KEY_PREFIX + sourceDateKey);
    cacheDelete(CACHE_KEY_PREFIX + planDate);

    // Шаг 6: перезагрузить текущую открытую таблицу чтобы цель исчезла
    if (sourceDateKey && sourceDateKey !== planDate) {
      const sourceEntry = tree?.dates?.find(d => d.date === sourceDateKey);
      if (sourceEntry) {
        const rows = await loadTargetsFromFolder(
          sourceEntry.folderIds || sourceEntry.folderId,
          sourceDateKey,
          true   // forceRefresh
        );
        populateTable(rows);
        refreshAllTaskCells();
        updateUndefeatedBadge(sourceDateKey, rows);
      }
    }

    // Сбрасываем кэш обеих дат
    cacheDelete(CACHE_KEY_PREFIX + sourceDateKey);
    cacheDelete(CACHE_KEY_PREFIX + planDate);

    // Ждём пока AstraMap применит relink на сервере
    showToast('⏳ Обновляем таблицу...', 'info');
    await new Promise(r => setTimeout(r, 1500));

    // Переключаемся на целевую дату в основной таблице
    const planningPanel = document.querySelector('#planningPanel');
    const tableWrapper  = document.querySelector('.table-wrapper');
    const planBtn       = document.querySelector('#showPlanningBtn');
    if (planningPanel) planningPanel.style.display = 'none';
    if (tableWrapper)  tableWrapper.style.display  = '';
    if (planBtn)       planBtn.textContent          = '📅 Спланировано';

    // Находим кнопку нужной даты в панели дат и кликаем
    const targetDateBtn = document.querySelector(`#dates-list button[data-date="${planDate}"]`);
    if (targetDateBtn) {
      targetDateBtn.click();
    } else {
      // Кнопки даты нет — обновляем дерево и таблицу
      await renderDatePanel(true);
      const newTree = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
      const entry   = newTree?.dates?.find(d => d.date === planDate);
      if (entry) {
        const rows = await loadTargetsFromFolder(entry.folderIds || entry.folderId, planDate, true);
        populateTable(rows);
        updateUndefeatedBadge(planDate, rows);
      }
    }
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
// apiFetchFolderChildren → content/api/astraApi.js

// Разобрать title папки в дату. Форматы: "20 мая 2026 г.", "19 мая 2026г.", "2026-05-20"
const MONTH_MAP = {
  'января':1,'февраля':2,'марта':3,'апреля':4,'мая':5,'июня':6,
  'июля':7,'августа':8,'сентября':9,'октября':10,'ноября':11,'декабря':12
};

// function parseFolderDate(title) { → content/api/astraApi.js

// Получить список дат из папок (с кэшем в localStorage)
// Парсим название папки-месяца в номер месяца и год
// Форматы: "Май 2026 г.", "май 2026г.", "05.2026 г.", "2026-05"
// function parseMonthFolder(title) { → content/api/astraApi.js

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
    const level1 = await apiFetchFolderChildren(ROOT_FOLDER_ID);
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
      const days = await apiFetchFolderChildren(mf.id);
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

    const characteristic = TARGET_TYPE_MAP[params['6']?.value] || '';

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

  // Сортируем по времени обнаружения убыванию — самое позднее время сверху
  tableRows.sort((a, b) => {
    const ta = a.impactTime || '';
    const tb = b.impactTime || '';
    // Сравниваем как строки HH:MM — работает корректно (лексикографически)
    return tb.localeCompare(ta);
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

    btn.addEventListener('click', withLockKey('loadDate', btn, async () => {
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

      // Переключаемся на вкладку целей
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

      let rows = [];
      try {
        rows = await loadTargetsFromFolder(d.folderIds || d.folderId, d.date, true);
        populateTable(rows);
        refreshAllTaskCells();
        loadPlansForDate(d.date);
        disableTaskButtonsIfPast();
      } catch (err) {
        console.error('[dates] Ошибка загрузки целей:', err);
        showToast('Ошибка загрузки целей', 'error');
      } finally {
        updateUndefeatedBadge(d.date, rows);
      }
    }, { label: '⏳' }));


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