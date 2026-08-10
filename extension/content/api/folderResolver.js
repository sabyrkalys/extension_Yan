// content/api/folderResolver.js
// Динамическое разрешение id папок подразделений на AstraMap по названию,
// вместо хардкода folderId в UNIT_FOLDERS (который устаревает — AstraMap
// периодически пересоздаёт/переносит папки).
//
// Структура дерева на AstraMap двухуровневая относительно подразделений:
// верхнеуровневая группа (parentEntityID: 0), например "Группировка МП" или
// "51 ОА" (см. GROUP_ROOT_ALIASES в config.js), внутри которой лежит папка
// конкретного подразделения (см. UNIT_FOLDERS[key].name/group в config.js).
//
// Зависимости: config.js (ASTRA_API, UNIT_FOLDERS, GROUP_ROOT_ALIASES),
// apiHeaders() (astraApi.js)

const FOLDER_CACHE_KEY = 'astra_folder_id_cache_v5'; // v5: обновлён folderId ГООПП в config.js
const FOLDER_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов
const FOLDER_TEMPLATE_ID = 1; // templateID: 1 = папка
const GROUP_CACHE_PREFIX = 'group:';

// ── Нормализация названий ──────────────────────────────────────────────────
// Регистр, пробелы/подчёркивания/дефисы не должны влиять на сопоставление:
// "9 омсбр" === "9_ОМСБР" === "9-омсбр" === "9омсбр".
function normalizeFolderName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .trim();
}

// ── Кэш в localStorage ──────────────────────────────────────────────────────
// Один и тот же кэш используется и для id подразделений (ключ — unitKey),
// и для id верхнеуровневых групп (ключ — "group:<имя группы>").
function readFolderCache() {
  try {
    const raw = localStorage.getItem(FOLDER_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeFolderCache(cache) {
  try {
    localStorage.setItem(FOLDER_CACHE_KEY, JSON.stringify(cache));
  } catch (err) {
    console.warn('[folderResolver] Не удалось записать кэш:', err);
  }
}

function getCachedFolderId(cacheKey) {
  const cache = readFolderCache();
  const entry = cache[cacheKey];
  if (!entry) return null;
  if (Date.now() - entry.ts > FOLDER_CACHE_TTL_MS) return null;
  return entry.id;
}

function setCachedFolderId(cacheKey, id) {
  const cache = readFolderCache();
  cache[cacheKey] = { id, ts: Date.now() };
  writeFolderCache(cache);
}

function clearCachedFolderId(cacheKey) {
  const cache = readFolderCache();
  delete cache[cacheKey];
  writeFolderCache(cache);
}

// ── Обход дерева папок AstraMap ─────────────────────────────────────────────
// Ищет папку среди потомков parentEntityID (maxDepth уровней), название
// которой совпадает (после нормализации) с ЛЮБЫМ из names — так одна папка
// может называться на AstraMap по-разному (например "ГрМП" и
// "Группировка МП" — один и тот же орган).
async function searchFolderByName(names, parentEntityID, maxDepth = 1, preferredId = null) {
  const nameList = Array.isArray(names) ? names : [names];
  const res = await fetch(ASTRA_API.search, {
    method: 'POST',
    credentials: 'include',
    headers: apiHeaders(),
    body: JSON.stringify({
      templateIDs: [FOLDER_TEMPLATE_ID],
      parentEntityID,
      maxDepth,
      withCounters: false,
      sortingParams: { field: 'title', destination: 'asc', folderFirst: 'desc' },
      filterCriteria: [],
    }),
  });

  if (!res.ok) throw new Error(`folderResolver search HTTP ${res.status}`);
  const data = await res.json();
  const entities = data.entities || data.items || [];

  const targets = nameList.map(normalizeFolderName);
  const matches = entities.filter(e => {
    const entity = e.entity || e;
    return targets.includes(normalizeFolderName(entity.title));
  });

  if (!matches.length) return null;

  // AstraMap иногда плодит несколько папок с одним названием (старые
  // заброшенные + новые тестовые/дублирующие). Если среди совпадений есть
  // id, который уже подтверждён вручную (preferredId — хардкод из config.js
  // или GROUP_ROOT_FALLBACK_ID) — доверяем ему. Иначе берём самую свежую
  // (по createdAt) как наиболее вероятно активную.
  if (preferredId != null) {
    const preferred = matches.find(e => (e.entity || e)?.id === preferredId);
    if (preferred) {
      const entity = preferred.entity || preferred;
      return entity.id ?? entity.entityID ?? null;
    }
  }

  const newest = matches.reduce((best, e) => {
    const entity = e.entity || e;
    const bestEntity = best.entity || best;
    return new Date(entity.createdAt || 0) > new Date(bestEntity.createdAt || 0) ? e : best;
  });

  const entity = newest.entity || newest;
  return entity.id ?? entity.entityID ?? null;
}

// ── Резолвинг верхнеуровневой группы ────────────────────────────────────────
// Группы (напр. "Группировка МП", "51 ОА") — папки верхнего уровня
// (parentEntityID: 0). Кэшируются отдельно от подразделений, т.к. на одну
// группу может ссылаться несколько подразделений.
async function resolveGroupRootId(groupName, { forceRefresh = false } = {}) {
  const cacheKey = GROUP_CACHE_PREFIX + groupName;

  if (!forceRefresh) {
    const cached = getCachedFolderId(cacheKey);
    if (cached) return cached;
  }

  const aliases = GROUP_ROOT_ALIASES[groupName] || [groupName];
  const preferredId = GROUP_ROOT_FALLBACK_ID[groupName] ?? null;
  let id = null;
  try {
    id = await searchFolderByName(aliases, 0, 1, preferredId);
  } catch (err) {
    console.warn(`[folderResolver] Поиск группы "${aliases.join('" / "')}" не удался:`, err);
  }

  if (id !== null) setCachedFolderId(cacheKey, id);
  return id;
}

// ── Публичное API ────────────────────────────────────────────────────────────
// Резолвит актуальный id папки подразделения: сначала находит id его
// верхнеуровневой группы (unit.group), затем ищет папку подразделения
// (unit.name/aliases) среди её прямых потомков. Не полагается на
// захардкоженные folderId из UNIT_FOLDERS — только как аварийный fallback.
async function resolveFolderId(unitKey, { forceRefresh = false } = {}) {
  const unit = UNIT_FOLDERS[unitKey];
  if (!unit) throw new Error(`resolveFolderId: неизвестный ключ подразделения "${unitKey}"`);

  if (!forceRefresh) {
    const cached = getCachedFolderId(unitKey);
    if (cached) return cached;
  }

  const names = unit.aliases && unit.aliases.length ? unit.aliases : [unit.name];
  let id = null;

  try {
    const groupId = await resolveGroupRootId(unit.group, { forceRefresh });
    if (groupId !== null) {
      id = await searchFolderByName(names, groupId, 1, unit.folderId ?? null);
    } else {
      console.warn(`[folderResolver] Не удалось разрешить группу "${unit.group}" для "${names.join('" / "')}"`);
    }
  } catch (err) {
    console.warn(`[folderResolver] Поиск "${names.join('" / "')}" в группе "${unit.group}" не удался:`, err);
  }

  // Ничего не нашли — аварийный fallback на хардкоженный folderId из config.js.
  if (id === null) {
    console.warn(`[folderResolver] Не удалось разрешить "${names.join('" / "')}" — fallback на захардкоженный folderId=${unit.folderId}`);
    return unit.folderId;
  }

  setCachedFolderId(unitKey, id);
  return id;
}

// Сбрасывает кэш подразделения И его группы — используется при
// самовосстановлении после "sql: no rows in result set" (см. astraApi.js),
// т.к. протухнуть мог как id самого подразделения, так и id группы.
function invalidateFolderCache(unitKey) {
  clearCachedFolderId(unitKey);
  const unit = UNIT_FOLDERS[unitKey];
  if (unit?.group) clearCachedFolderId(GROUP_CACHE_PREFIX + unit.group);
}
