// content/utils/debounce.js
// Защита от дребезга кнопок и дублирования операций.
//
// Использование:
//   btnForm.addEventListener('click', withLock(btnForm, async () => {
//     await apiSendTarget(rowData);
//   }));
//
//   // Или через глобальный ключ (если кнопки разные, но операция одна):
//   withLockKey('loadTargets', btn, async () => { ... });

// ── withLock — блокирует конкретный элемент на время выполнения ──────────────
// btn        — DOM-элемент (кнопка) который будет заблокирован
// fn         — async функция
// opts.label — текст кнопки во время ожидания (по умолчанию «⏳ ...»)
function withLock(btn, fn, opts = {}) {
  return async function handler(...args) {
    if (btn.disabled || btn._locked) return;  // дребезг — игнорируем
    btn._locked    = true;
    btn.disabled   = true;
    const origText = btn.textContent;
    const origBg   = btn.style.background;
    btn.textContent  = opts.label || '⏳ ...';
    btn.style.opacity = '0.6';
    try {
      await fn(...args);
    } catch (err) {
      console.error('[withLock]', err);
      showToast('Ошибка: ' + (err.message || err), 'error');
    } finally {
      btn._locked    = false;
      btn.disabled   = false;
      btn.textContent  = origText;
      btn.style.opacity = '1';
      btn.style.background = origBg;
    }
  };
}

// ── withLockKey — глобальный замок по строковому ключу ────────────────────────
// Нужен когда одна операция может быть вызвана из разных мест (разные кнопки,
// но одно и то же действие — например «загрузить дату»).
const _locks = {};
function withLockKey(key, btn, fn, opts = {}) {
  return async function handler(...args) {
    if (_locks[key]) return;               // операция уже идёт — игнорируем
    _locks[key] = true;
    if (btn) {
      btn.disabled   = true;
      btn._origText  = btn.textContent;
      btn.textContent  = opts.label || '⏳ ...';
      btn.style.opacity = '0.6';
    }
    try {
      await fn(...args);
    } catch (err) {
      console.error(`[withLockKey:${key}]`, err);
      showToast('Ошибка: ' + (err.message || err), 'error');
    } finally {
      _locks[key] = false;
      if (btn) {
        btn.disabled   = false;
        btn.textContent  = btn._origText || btn.textContent;
        btn.style.opacity = '1';
      }
    }
  };
}

// ── deduplicateById — убрать дубли из массива по полю id ─────────────────────
// Оставляет первое вхождение.
// deduplicateById([...targets], 'targetNumber')
function deduplicateById(arr, field) {
  const seen = new Set();
  return arr.filter(item => {
    const key = String(item[field] ?? '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
