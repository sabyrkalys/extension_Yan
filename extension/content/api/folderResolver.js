// content/api/folderResolver.js
// Динамическое разрешение id папок подразделений на AstraMap по названию,
// вместо хардкода folderId в UNIT_FOLDERS (который устаревает — AstraMap
// периодически пересоздаёт/переносит папки).
// Зависимости: config.js (ASTRA_API, ROOT_FOLDER_ID, UNIT_FOLDERS), apiHeaders() (astraApi.js)

const FOLDER_CACHE_KEY = 'astra_folder_id_cache_v1';
const FOLDER_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов
const FOLDER_TEMPLATE_ID = 1; // templateID: 1 = папка

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

function getCachedFolderId(unitKey) {
  const cache = readFolderCache();
  const entry = cache[unitKey];
  if (!entry) return null;
  if (Date.now() - entry.ts > FOLDER_CACHE_TTL_MS) return null;
  return entry.id;
}

function setCachedFolderId(unitKey, id) {
  const cache = readFolderCache();
  cache[unitKey] = { id, ts: Date.now() };
  writeFolderCache(cache);
}

function clearCachedFolderId(unitKey) {
  const cache = readFolderCache();
  delete cache[unitKey];
  writeFolderCache(cache);
}

// ── Обход дерева папок AstraMap ─────────────────────────────────────────────
// Ищет папку с названием unitName среди потомков parentEntityID (maxDepth уровней).
async function searchFolderByName(unitName, parentEntityID, maxDepth = 10) {
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

  const target = normalizeFolderName(unitName);
  const match = entities.find(e => {
    const entity = e.entity || e;
    return normalizeFolderName(entity.title) === target;
  });

  if (!match) return null;
  const entity = match.entity || match;
  return entity.id ?? entity.entityID ?? null;
}

// Если сам ROOT_FOLDER_ID невалиден — ищем корень по названию среди папок верхнего уровня.
async function rediscoverRootId(rootName) {
  try {
    return await searchFolderByName(rootName, 0, 1);
  } catch (err) {
    console.warn('[folderResolver] rediscoverRootId не удался:', err);
    return null;
  }
}

// ── Публичное API ────────────────────────────────────────────────────────────
// Резолвит актуальный id папки подразделения по её названию (unit.name из
// UNIT_FOLDERS), не по хардкоженному folderId.
async function resolveFolderId(unitKey, { forceRefresh = false } = {}) {
  const unit = UNIT_FOLDERS[unitKey];
  if (!unit) throw new Error(`resolveFolderId: неизвестный ключ подразделения "${unitKey}"`);

  if (!forceRefresh) {
    const cached = getCachedFolderId(unitKey);
    if (cached) return cached;
  }

  let rootId = ROOT_FOLDER_ID;
  let id = null;

  try {
    id = await searchFolderByName(unit.name, rootId);
  } catch (err) {
    console.warn(`[folderResolver] Поиск "${unit.name}" под root=${rootId} не удался:`, err);
  }

  // Сама папка ГрМП/HQ обычно и есть ROOT_FOLDER_ID — искать её как потомка себя не нужно.
  if (id === null && unitKey === 'грмп') {
    id = ROOT_FOLDER_ID;
  }

  // Root мог тоже устареть — попробовать его переоткрыть по названию и повторить поиск.
  if (id === null) {
    const rootUnit = UNIT_FOLDERS['грмп'];
    const rediscoveredRoot = rootUnit ? await rediscoverRootId(rootUnit.name) : null;
    if (rediscoveredRoot && rediscoveredRoot !== rootId) {
      rootId = rediscoveredRoot;
      try {
        id = await searchFolderByName(unit.name, rootId);
      } catch (err) {
        console.warn(`[folderResolver] Повторный поиск "${unit.name}" под новым root=${rootId} не удался:`, err);
      }
      if (id === null && unitKey === 'грмп') id = rootId;
    }
  }

  // Ничего не нашли — аварийный fallback на хардкоженный folderId из config.js.
  if (id === null) {
    console.warn(`[folderResolver] Не удалось разрешить "${unit.name}" — fallback на захардкоженный folderId=${unit.folderId}`);
    return unit.folderId;
  }

  setCachedFolderId(unitKey, id);
  return id;
}

function invalidateFolderCache(unitKey) {
  clearCachedFolderId(unitKey);
}
