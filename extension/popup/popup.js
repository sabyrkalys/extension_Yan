'use strict';

// popup.js — показывает статус расширения: подключение, пользователь, роль.
// Читает данные из chrome.storage.local (туда пишет content.js).

const manifest = chrome.runtime.getManifest();
document.getElementById('extVersion').textContent = 'v' + manifest.version;

// Читаем сохранённое состояние из storage
chrome.storage.local.get(['wsConnected', 'userName', 'userRole', 'wsUrl'], (data) => {
  // Статус WS
  const dot   = document.getElementById('wsDot');
  const label = document.getElementById('wsLabel');
  if (data.wsConnected) {
    dot.className   = 'status-dot connected';
    label.textContent = 'подключён';
  } else {
    dot.className   = 'status-dot disconnected';
    label.textContent = data.wsUrl ? 'нет связи' : 'не настроен';
  }

  // Пользователь и роль
  document.getElementById('userName').textContent = data.userName || '—';
  document.getElementById('userRole').textContent = data.userRole || '—';
});

// Кнопка очистки кэша
document.getElementById('btnClearCache').addEventListener('click', () => {
  chrome.storage.local.get(null, (items) => {
    const keysToRemove = Object.keys(items).filter(k =>
      k.startsWith('astra_targets_') || k === 'astra_dates_tree'
    );
    if (keysToRemove.length === 0) {
      showMsg('Кэш уже пуст');
      return;
    }
    chrome.storage.local.remove(keysToRemove, () => {
      showMsg(`Удалено ${keysToRemove.length} записей`);
    });
  });
});

function showMsg(text) {
  const btn = document.getElementById('btnClearCache');
  btn.textContent = '✅ ' + text;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = '🗑 Очистить кэш';
    btn.disabled = false;
  }, 2000);
}
