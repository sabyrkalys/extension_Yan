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
    // Структура:
    // 0: Дата обнаруж.  1: Номер цели  2: Характер  3: Место
    // 4: X  5: Y  6: Просмотр  7: Результат  8: Задача  9: Дата уничт.  10: Формуляр

    const targetNumber   = cells[1]?.innerText.trim() || (idx + 1).toString();
    const charSelect     = cells[2]?.querySelector('select');
    const characteristic = charSelect ? charSelect.value : (cells[2]?.innerText.trim() || '');
    const place          = cells[3]?.querySelector('input')?.value || cells[3]?.innerText.trim() || '';

    // X/Y + оригинальные WGS84 координаты из data-атрибутов
    const coordX         = cells[4]?.innerText.trim() || '';
    const coordY         = cells[5]?.innerText.trim() || '';
    const originalLon    = parseFloat(cells[4]?.getAttribute('data-lon') || '') || null;
    const originalLat    = parseFloat(cells[5]?.getAttribute('data-lat') || '') || null;

    const resSelect      = cells[7]?.querySelector('select');
    const result         = resSelect ? resSelect.value : '';

    // Дата уничтожения из col 9
    const destroyDate    = cells[9]?.querySelector('input')?.value || cells[9]?.innerText.trim() || '';

    // Время обнаружения из data-атрибута строки
    const impactTime     = row.getAttribute('data-impact-time') || '';

    // Полная строка даты из col 0 (для чтения)
    const dateObserved   = cells[0]?.innerText.trim().replace(/\n/g, ' ') || '';

    data.push({
      targetNumber,
      characteristic,
      place,
      coordX,
      coordY,
      originalLon,
      originalLat,
      impactTime,
      result,
      defeatDate:   destroyDate,
      destroyDate,
      dateObserved,
    });
  });
  return data;
}

// ── Иерархические категории целей ────────────────────────────────────────────
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
  sel.style.cssText = 'width:100%;font-size:11px;padding:2px 3px;border-radius:4px;border:1px solid #ccc;';
  const defOpt = document.createElement('option');
  defOpt.value = ''; defOpt.textContent = '— Характер —';
  if (!currentVal) defOpt.selected = true;
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
  // Если значение из TARGET_TYPE_MAP не в списке — добавляем отдельным option
  if (currentVal && !sel.querySelector(`option[value="${CSS.escape(currentVal)}"]`)) {
    const extra = document.createElement('option');
    extra.value = currentVal; extra.textContent = currentVal; extra.selected = true;
    sel.insertBefore(extra, sel.options[1]);
  }
  return sel;
}

// Кэш медиа-флагов (in-memory)
const _mediaFlags = {};

function populateTable(dataArray) {
  const tbody = document.querySelector('#statusTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const rows = deduplicateById(dataArray, 'targetNumber');
  if (rows.length < dataArray.length) {
    console.warn(`[table] Убрано дублей: ${dataArray.length - rows.length}`);
  }

  const today   = getMoscowDateStr();
  const isToday = activeFolderDate === today || activeFolderDate === null;

  // Стиль ячейки — все по центру
  const CS = 'text-align:center;vertical-align:middle;padding:4px 6px;';

  rows.forEach((item, idx) => {
    const row = tbody.insertRow();
    row.setAttribute('data-target-id', item.targetNumber || '');
    row.setAttribute('data-impact-time', item.impactTime || '');

    // Оранжевый фон для поражённых
    const DEFEATED = ['поражена', 'подтверждено', 'подавлено'];
    if (DEFEATED.includes(item.result)) {
      row.style.background = 'rgba(255,140,0,0.12)';
      row.style.borderLeft = '3px solid #fd7e14';
    }

    // ── col 0: Дата обнаруж. ──────────────────────────────────────────────
    const cellDate = row.insertCell(0);
    const datePart = item.defeatDate || '';
    const timePart = item.impactTime || '';
    const dateDisp = datePart ? datePart.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3.$2') : '';
    cellDate.innerHTML = `<span style="font-size:11px;white-space:nowrap;">${dateDisp || '—'}<br><span style="color:#888;">${timePart}</span></span>`;
    cellDate.style.cssText = CS;

    // ── col 1: Номер цели ─────────────────────────────────────────────────
    const cellNum = row.insertCell(1);
    cellNum.innerText = item.targetNumber || (idx + 1).toString();
    cellNum.style.cssText = CS + 'font-size:12px;';

    // ── col 2: Характер цели ──────────────────────────────────────────────
    const cellChar = row.insertCell(2);
    cellChar.classList.add('char-cell');
    cellChar.style.cssText = CS + 'padding:3px 4px;';
    const selectChar = buildCharSelect(item.characteristic || '');
    selectChar.style.cssText = 'width:100%;font-size:11px;padding:2px 3px;border-radius:4px;border:1px solid #ccc;';
    cellChar.appendChild(selectChar);

    // ── col 3: Адрес цели (read-only — вводится через модал) ─────────────
    const cellPlace = row.insertCell(3);
    cellPlace.style.cssText = CS + 'padding:3px 4px;';
    const placeSpan = document.createElement('span');
    placeSpan.innerText = item.place || '';
    placeSpan.title     = item.place || 'Адрес не указан';
    placeSpan.style.cssText = 'font-size:11px;color:#555;display:block;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    cellPlace.appendChild(placeSpan);

    // ── col 4: X (read-only, фикс. ширина) ───────────────────────────────
    const cellX = row.insertCell(4);
    cellX.innerText = item.coordX || '';
    cellX.setAttribute('data-lon', item.originalLon ?? '');
    cellX.style.cssText = CS + 'font-size:11px;white-space:nowrap;width:80px;min-width:80px;max-width:80px;';

    // ── col 5: Y (read-only, та же ширина что X) ──────────────────────────
    const cellY = row.insertCell(5);
    cellY.innerText = item.coordY || '';
    cellY.setAttribute('data-lat', item.originalLat ?? '');
    cellY.style.cssText = CS + 'font-size:11px;white-space:nowrap;width:80px;min-width:80px;max-width:80px;';

    // ── col 6: Просмотр на карте ──────────────────────────────────────────
    const cellView = row.insertCell(6);
    cellView.style.cssText = CS;

    const targetEntityId = item.targetNumber || '';

    const btnView = document.createElement('a');
    btnView.classList.add('btnView');
    btnView.href   = `https://center.astramaps.ru/map/${targetEntityId}`;
    btnView.target = '_blank';
    btnView.rel    = 'noopener noreferrer';
    btnView.innerHTML = '👁️';
    btnView.title  = 'Просмотр в AstraMap';
    btnView.style.cssText = 'display:inline-block;padding:3px 7px;background:#2c7da0;color:white;border-radius:4px;font-size:14px;text-decoration:none;';

    // Кнопки медиа — открывают галерею, показывают наличие
    const makeMediaBtn = (emoji, mediaType) => {
      const btn = document.createElement('button');
      btn.dataset.media = mediaType;  // для _applyMediaFlags
      const on = !!_mediaFlags[targetEntityId + '_' + mediaType];
      btn.innerHTML = emoji;
      btn.title = on
        ? `Есть ${mediaType === 'photo' ? 'фото' : 'видео'} — клик для галереи`
        : `Нет ${mediaType === 'photo' ? 'фото' : 'видео'} — клик для добавления`;
      btn.style.cssText = `font-size:10px;padding:1px 4px;border:none;border-radius:3px;
        cursor:pointer;transition:0.15s;
        background:${on ? '#28a745' : '#dee2e6'};
        color:${on ? 'white' : '#aaa'};
        opacity:${on ? '1' : '0.6'};`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof showMediaGallery === 'function') {
          showMediaGallery(targetEntityId, item.characteristic || '');
        }
      });
      return btn;
    };

    const mediaWrap = document.createElement('div');
    mediaWrap.classList.add('media-btns');
    mediaWrap.style.cssText = 'display:flex;gap:3px;justify-content:center;margin-top:3px;';
    mediaWrap.appendChild(makeMediaBtn('📷', 'photo'));
    mediaWrap.appendChild(makeMediaBtn('🎥', 'video'));

    cellView.appendChild(btnView);
    cellView.appendChild(mediaWrap);

    // ── col 7: Результат ──────────────────────────────────────────────────
    const cellRes = row.insertCell(7);
    cellRes.style.cssText = CS + 'padding:3px 4px;';
    const selectRes = document.createElement('select');
    selectRes.style.cssText = 'width:100%;font-size:11px;padding:2px 4px;border-radius:4px;border:1px solid #ccc;';
    [
      { val: '',                       txt: '— Результат —', dis: true },
      { val: 'вскрыто',                txt: 'Вскрыт' },
      { val: 'передано_на_доразведку', txt: 'Передано на доразведку' },
      { val: 'подтверждено',           txt: 'Подтверждено' },
      { val: 'поражена',               txt: 'Поражена' },
      { val: 'не_поражена',            txt: 'Не поражена' },
      { val: 'подавлено',              txt: 'Подавлено' },
      { val: 'уничтожена',             txt: 'Уничтожена' },
    ].forEach(o => {
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
    cellTask.style.cssText = CS;
    renderTaskCell(cellTask, item.targetNumber || '', item.characteristic || '', true);

    // ── col 9: Дата уничтожения ───────────────────────────────────────────
    const cellDestroy = row.insertCell(9);
    cellDestroy.style.cssText = CS + 'padding:3px 4px;';

    const destroySpan = document.createElement('span');
    destroySpan.classList.add('destroy-label');

    const setDestroyDisplay = (result, dateVal) => {
      if (result === 'уничтожена') {
        const now = dateVal || getMoscowDateStr() + ' ' + getMoscowTimeStr();
        destroySpan.innerHTML = `<span style="color:#dc3545;font-size:10px;font-weight:600;">🔥 Уничтожена</span><br>
          <span style="font-size:10px;color:#555;">${now}</span>`;
      } else {
        destroySpan.innerHTML = '<span style="color:#aaa;">—</span>';
      }
    };

    // Инициализируем
    setDestroyDisplay(item.result, item.defeatDate ? (item.defeatDate + ' ' + (item.impactTime || '')) : '');
    cellDestroy.appendChild(destroySpan);

    // При изменении Результата — обновляем Дату уничтожения
    selectRes.addEventListener('change', () => {
      const now = getMoscowDateStr() + ' ' + getMoscowTimeStr();
      setDestroyDisplay(selectRes.value, now);
      // Оранжевый фон
      const DEFEATED = ['поражена', 'подтверждено', 'подавлено'];
      row.style.background = DEFEATED.includes(selectRes.value) ? 'rgba(255,140,0,0.12)' : '';
      row.style.borderLeft = DEFEATED.includes(selectRes.value) ? '3px solid #fd7e14' : '';
    });

    // ── col 10: Сформировать формуляр ────────────────────────────────────
    const cellForm = row.insertCell(10);
    cellForm.style.cssText = CS;
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
        defeatDate:     getMoscowDateStr(),
        place:          placeSpan.innerText.trim(),
        originalLon:    parseFloat(cellX.getAttribute('data-lon')) || null,
        originalLat:    parseFloat(cellY.getAttribute('data-lat')) || null,
      };
      await apiSendTarget(currentRowData);
    }, { label: '⏳ Отправка...' }));
    cellForm.appendChild(btnForm);
  });
  // Асинхронно загружаем количество медиафайлов
  setTimeout(() => loadMediaCountsAsync(), 300);
}
// Асинхронная загрузка количества медиафайлов для всех строк таблицы
async function loadMediaCountsAsync() {
  const rows = document.querySelectorAll('#statusTable tbody tr[data-target-id]');
  if (!rows.length) return;

  const entityIds = [...rows].map(r => r.getAttribute('data-target-id')).filter(Boolean);
  if (!entityIds.length) return;

  const response = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'GET_MEDIA_COUNTS', entityIds }, resolve)
  );
  if (!response?.ok || !response.counts) return;

  const counts = response.counts;
  for (const [entityId, cnt] of Object.entries(counts)) {
    _mediaFlags[entityId + '_photo']       = cnt.photo > 0;
    _mediaFlags[entityId + '_video']       = cnt.video > 0;
    _mediaFlags[entityId + '_photo_count'] = cnt.photo;
    _mediaFlags[entityId + '_video_count'] = cnt.video;

    const row = document.querySelector(`#statusTable tr[data-target-id="${entityId}"]`);
    if (row) _applyMediaFlags(row, entityId);
  }
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
      // Кнопки даты нет — обновляем дерево, потом ищем снова
      await renderDatePanel(true);
      const newBtn = document.querySelector(`#dates-list button[data-date="${planDate}"]`);
      if (newBtn) {
        // После renderDatePanel кнопка появилась — кликаем
        newBtn.click();
      } else {
        // Совсем нет папки — грузим напрямую
        const newTree = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
        const entry   = newTree?.dates?.find(d => d.date === planDate);
        if (entry) {
          activeFolderId   = entry.folderId;
          activeFolderDate = planDate;
          const rows = await loadTargetsFromFolder(entry.folderIds || entry.folderId, planDate, true);
          populateTable(rows);
          refreshAllTaskCells();
          updateUndefeatedBadge(planDate, rows);
        }
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

    // ── Новые поля из AstraMap ────────────────────────────────────────
    const source      = params['9']?.value  || '';
    const description = params['4']?.value  || '';
    const confidence  = params['10']?.value || '';
    const relevance   = params['11']?.value || '';
    const priority    = params['17']?.value || '';
    const is_mobile   = params['14']?.value === 1;
    const has_media   = Array.isArray(params['8']?.value) && params['8'].value.length > 0;

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
      // Поля для синка в SQLite
      source,
      description,
      confidence,
      relevance,
      priority,
      is_mobile,
      has_media,
    };
  });

  // Сортируем по времени обнаружения убыванию — самое позднее время сверху
  tableRows.sort((a, b) => {
    const ta = a.impactTime || '';
    const tb = b.impactTime || '';
    return tb.localeCompare(ta);
  });

  // Синкаем в SQLite через WS (фоново, не блокирует UI)
  if (tableRows.length > 0 && myRole) {
    const syncPayload = tableRows.map(row => ({
      entity_id:   String(row.targetNumber),
      title:       row.characteristic,
      target_type: row.characteristic,
      coord_lon:   row.originalLon,
      coord_lat:   row.originalLat,
      coord_x:     row.coordX,
      coord_y:     row.coordY,
      result:      row.result,
      detected_at: row.defeatDate
        ? `${row.defeatDate}T${row.impactTime ? row.impactTime + ':00' : '00:00:00'}Z`
        : '',
      source:      row.source      || '',
      description: row.description || '',
      confidence:  row.confidence  || '',
      relevance:   row.relevance   || '',
      priority:    row.priority    || '',
      is_mobile:   row.is_mobile   || false,
      has_media:   row.has_media   || false,
      author:      '',
    }));
    wsSend({ type: 'SYNC_TARGETS', date: dateKey, entities: syncPayload });
    console.log(`[sync] Отправлено ${syncPayload.length} целей за ${dateKey} на сервер`);
  }

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