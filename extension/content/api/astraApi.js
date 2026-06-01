// content/api/astraApi.js
// Все HTTP-запросы к AstraMap API.
// Зависимости: config.js (ASTRA_API, ROOT_FOLDER_ID), utils/coords.js, utils/date.js
//
// Принцип: каждая функция делает ровно один запрос.
// Бизнес-логика (что делать с ответом) — в content.js.

// ── Вспомогательные ──────────────────────────────────────────────────────────

// Заголовки с токеном (всегда свежий из localStorage)
function apiHeaders() {
  const token = getToken(); // ✅ глобальная функция из config.js
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${token}`,
    'Accept':        'application/json, text/plain, */*',
  };
}

// Маппинг результата поражения в метку AstraMap — из config.js
function mapResult(result) {
  return RESULT_MAP_TO_ASTRA[result] || 'Вскрыто';
}

// Маппинг характеристики цели в templateID AstraMap — из config.js
function mapTargetType(characteristic) {
  return TARGET_TYPE_TO_ID[characteristic] || '1100000';
}

function parseCoord(coordStr) {
  if (!coordStr) return null;
  const num = parseFloat(coordStr);
  return isNaN(num) ? null : num;
}

// ── Объекты ──────────────────────────────────────────────────────────────────

// Получить объект по id
async function apiGetTargetById(id) {
  const res = await fetch(ASTRA_API.search, {
    method: 'POST',
    credentials: 'include',
    headers: apiHeaders(),
    body: JSON.stringify({ ids: [id], maxDepth: 1 }),
  });
  if (!res.ok) throw new Error(`apiGetTargetById HTTP ${res.status}`);
  const data = await res.json();
  return data.entities?.[0]?.entity || null;
}

// Получить высоту в точке (lon, lat WGS-84)
async function apiGetHeightAtPoint(lon, lat) {
  const res = await fetch(
    `https://center.astramaps.ru/viewshed/height?lon=${lon}&lat=${lat}`,
    { headers: apiHeaders() }
  );
  if (!res.ok) throw new Error(`apiGetHeightAtPoint HTTP ${res.status}`);
  return res.json();
}

// Создать / обновить объект на карте (цель)
async function apiSendTarget(rowData, parentFolderId) {
  const { targetNumber, characteristic, coordX, coordY, impactTime, result, defeatDate } = rowData;

  const sk42easting  = parseFloat(coordY); // колонка «У»
  const sk42northing = parseFloat(coordX); // колонка «Х»

  if (isNaN(sk42easting) || isNaN(sk42northing)) {
    showToast('❌ Некорректные координаты (не числа)', 'error');
    return null;
  }

  const coord = convertSk42ToWgs84(sk42easting, sk42northing);
  const lon   = typeof coord.lon === 'number' ? coord.lon : parseCoord(coord.lon);
  const lat   = typeof coord.lat === 'number' ? coord.lat : parseCoord(coord.lat);

  if (lon === null || lat === null || isNaN(lon) || isNaN(lat)) {
    showToast('❌ Некорректные координаты', 'error');
    return null;
  }

  const colorMap = {
    'ПУ БПЛА':   '#f44336',
    'РЭБ':       '#2196f3',
    'Артиллерия':'#ff9800',
    'Укрытие':   '#4caf50',
    'Связь':     '#9c27b0',
    'Танк':      '#795548',
  };

  const title       = characteristic || `Цель №${targetNumber || '-'}`;
  const color       = colorMap[characteristic] || '#888888';
  const datetimeISO = toISOWithTime(defeatDate, impactTime);

  const payload = {
    id:             0,
    parentEntityID: parentFolderId || latestFolderId || ROOT_FOLDER_ID,
    templateID:     2,
    title,
    parameters: {
      '1':  { value: { type: 'Point', coordinates: [lon, lat] }, metadata: { properties: { subtype: 'point' } } },
      '3':  { value: 25 },
      '4':  { value: '' },
      '5':  { value: color },
      '6':  { value: mapTargetType(characteristic) },
      '7':  { value: mapResult(result) },
      '8':  { value: [] },
      '9':  { value: 'ВР Войсковая разведка' },
      '10': { value: 'Почти наверняка' },
      '11': { value: 'Актуально' },
      '12': { value: datetimeISO },
      '14': { value: 0 },
      '17': { value: 'Второй' },
      '18': { value: null },
    },
    mediaParamKeyID: '8',
    createdBy: {},
  };

  const res = await fetch(ASTRA_API.createUpdate, {
    method: 'POST',
    credentials: 'include',
    headers: apiHeaders(),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json();
}

// Удалить объект с карты
async function apiDeleteTarget(targetId) {
  const res = await fetch(`${ASTRA_API.entity}/${targetId}?cascade=true`, {
    method: 'DELETE',
    credentials: 'include',
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

// Переместить объект в другую папку — BulkRelink API
// Формат: { EntityIDs: [id], NewParentID: newParentId }
async function apiMoveEntity(entityId, newParentId) {
  const res = await fetch(ASTRA_API.relink, {
    method: 'POST',
    credentials: 'include',
    headers: apiHeaders(),
    body: JSON.stringify({ EntityIDs: [entityId], NewParentID: newParentId }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Relink HTTP ${res.status} — ${txt}`);
  }
  return { success: true };
}

// ── Папки ────────────────────────────────────────────────────────────────────

// Получить дочерние элементы папки (только папки, templateID=1)
async function apiFetchFolderChildren(parentId) {
  const res = await fetch(ASTRA_API.search, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      maxDepth:      1,
      withCounters:  true,
      sortingParams: { field: 'title', destination: 'asc', folderFirst: 'desc' },
      filterCriteria: [],
      templateIDs:   [1],
      parentEntityID: parentId,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.entities || data.items || [];
}

// Получить parentEntityID для папки (нужен для навигации вверх по дереву)
async function apiGetParentFolderId(folderId) {
  try {
    const res = await fetch(`${ASTRA_API.entity}/${folderId}`, {
      headers: apiHeaders(),
    });
    if (!res.ok) return null;
    return (await res.json()).parentEntityID || null;
  } catch { return null; }
}

// Создать папку внутри parentId
async function apiCreateFolder(parentId, title) {
  const res = await fetch(ASTRA_API.createUpdate, {
    method: 'POST',
    credentials: 'include',
    headers: apiHeaders(),
    body: JSON.stringify({
      id: 0, parentEntityID: parentId, templateID: 1,
      title, parameters: {}, createdBy: {},
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Создание папки HTTP ${res.status} — ${txt}`);
  }
  const data = await res.json();
  return data.id || data.entity?.id;
}

// ── Загрузка объектов из папки ────────────────────────────────────────────────

// Загрузить объекты папки за дату (один fetch)
async function apiFetchTargetsInFolder(folderId, date) {
  // Без фильтра по дате создания — другие подразделения добавляют объекты
  // в папку-день в любое время. Берём всё содержимое папки (maxDepth=1 = только корень).
  const body = {
    maxDepth:      1,
    withCounters:  false,
    sortingParams: { field: 'createdAt', destination: 'desc', folderFirst: 'asc' },
    filterCriteria: [],
    templateIDs:    [2],
    parentEntityID: folderId,
  };

  const res = await fetch(ASTRA_API.search, {
    method: 'POST',
    credentials: 'include',
    headers: apiHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.entities || data.items || [];
}
// ── Парсинг названия папки-месяца ─────────────────────────────────────────────
// Форматы: "Май 2026 г.", "май 2026г.", "05.2026 г.", "2026-05"
// Возвращает { month: 1-12, year: 2024 } или null
function parseMonthFolder(title) {
  if (!title) return null;

  const MONTHS = {
    'январ': 1, 'феврал': 2, 'март': 3,   'апрел': 4,
    'май': 5,   'мая': 5,   'июн': 6,     'июл': 7,
    'август': 8,'сентябр': 9,'октябр': 10,'ноябр': 11,'декабр': 12,
  };

  const t = title.toLowerCase().trim();

  // Формат: "Май 2026 г." / "январь 2026"
  for (const [key, num] of Object.entries(MONTHS)) {
    if (t.startsWith(key)) {
      const yearMatch = t.match(/\b(202\d|203\d)\b/);
      if (yearMatch) return { month: num, year: parseInt(yearMatch[1]) };
    }
  }

  // Формат: "05.2026" или "05.2026 г."
  const dotMatch = t.match(/^(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const m = parseInt(dotMatch[1]);
    const y = parseInt(dotMatch[2]);
    if (m >= 1 && m <= 12) return { month: m, year: y };
  }

  // Формат: "2026-05"
  const isoMatch = t.match(/^(\d{4})-(\d{2})/);
  if (isoMatch) {
    const m = parseInt(isoMatch[2]);
    const y = parseInt(isoMatch[1]);
    if (m >= 1 && m <= 12) return { month: m, year: y };
  }

  return null;
}

// ── Парсинг названия папки-дня → YYYY-MM-DD ───────────────────────────────────
// Форматы: "30.05.2026", "30.05.26", "30.05", "2026-05-30", "30 мая 2026"
// Возвращает строку "YYYY-MM-DD" или null
function parseFolderDate(title) {
  if (!title) return null;
  const t = title.trim();

  // "2026-05-30" — ISO
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    if (+m >= 1 && +m <= 12 && +d >= 1 && +d <= 31)
      return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // "30.05.2026" или "30.05.26"
  const dot = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (dot) {
    const d = dot[1].padStart(2,'0');
    const m = dot[2].padStart(2,'0');
    let y = dot[3];
    if (y.length === 2) y = '20' + y;
    if (+m >= 1 && +m <= 12 && +d >= 1 && +d <= 31)
      return `${y}-${m}-${d}`;
  }

  // "30.05" — без года, берём текущий год по МСК
  const noYear = t.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (noYear) {
    const d = noYear[1].padStart(2,'0');
    const m = noYear[2].padStart(2,'0');
    const y = new Date(Date.now() + 3*60*60*1000).getFullYear();
    if (+m >= 1 && +m <= 12 && +d >= 1 && +d <= 31)
      return `${y}-${m}-${d}`;
  }

  // "30 мая 2026" — текстовый формат
  const MONTHS = {
    'янв':1,'фев':2,'мар':3,'апр':4,'май':5,'мая':5,
    'июн':6,'июл':7,'авг':8,'сен':9,'окт':10,'ноя':11,'дек':12,
  };
  const text = t.toLowerCase().match(/^(\d{1,2})\s+([а-я]+)\s+(\d{4})/);
  if (text) {
    const d  = text[1].padStart(2,'0');
    const mStr = text[2].slice(0,3);
    const m  = MONTHS[mStr];
    const y  = text[3];
    if (m) return `${y}-${String(m).padStart(2,'0')}-${d}`;
  }

  return null;
}