// content/cache/cache.js
// Работа с кэшем целей в localStorage.
// Зависимости: CACHE_KEY_PREFIX, CACHE_KEY_DATES, CACHE_TTL_MS из config.js

// Получить данные из кэша (null если нет или устарел)
function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (!cached || !cached.ts) return null;
    if ((Date.now() - cached.ts) > CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return cached.data;
  } catch { return null; }
}

// Сохранить данные в кэш с меткой времени
function cacheSet(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch (err) {
    console.warn('[cache] Ошибка записи:', err);
  }
}

// Удалить конкретный ключ
function cacheDelete(key) {
  try { localStorage.removeItem(key); } catch {}
}

// Удалить все кэши целей (при принудительном обновлении)
function cacheClearAll() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(CACHE_KEY_PREFIX) || k === CACHE_KEY_DATES)) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
    console.log(`[cache] Сброшено ${keys.length} записей`);
    return keys.length;
  } catch { return 0; }
}

// При загрузке — тихо чистим устаревшие записи
(function cleanOldCache() {
  try {
    const now = Date.now();
    const toDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (!key.startsWith(CACHE_KEY_PREFIX) && key !== CACHE_KEY_DATES) continue;
      try {
        const cached = JSON.parse(localStorage.getItem(key));
        if (cached && cached.ts && (now - cached.ts) > CACHE_TTL_MS) toDelete.push(key);
      } catch {}
    }
    toDelete.forEach(k => localStorage.removeItem(k));
    if (toDelete.length > 0) console.log(`[cache] Очищено устаревших: ${toDelete.length}`);
  } catch {}
})();
