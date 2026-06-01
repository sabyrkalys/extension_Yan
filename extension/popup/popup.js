'use strict';

// popup.js — статус расширения + управление токеном

const manifest = chrome.runtime.getManifest();
document.getElementById('extVersion').textContent = 'v' + manifest.version;

// Читаем состояние
chrome.storage.local.get(['wsConnected', 'userName', 'userRole', 'wsUrl', 'extensionToken'], (data) => {
  const dot   = document.getElementById('wsDot');
  const label = document.getElementById('wsLabel');
  if (data.wsConnected) {
    dot.className     = 'status-dot connected';
    label.textContent = 'подключён';
  } else {
    dot.className     = 'status-dot disconnected';
    label.textContent = data.wsUrl ? 'нет связи' : 'не настроен';
  }

  document.getElementById('userName').textContent = data.userName || '—';
  document.getElementById('userRole').textContent = data.userRole || '—';

  // Показываем статус токена
  const tokenStatus = document.getElementById('tokenStatus');
  if (tokenStatus) {
    if (data.extensionToken) {
      const hint = data.extensionToken.slice(0, 8) + '...';
      tokenStatus.textContent = `🔑 ${hint}`;
      tokenStatus.style.color = '#28a745';
    } else {
      tokenStatus.textContent = '⚠️ Не задан';
      tokenStatus.style.color = '#dc3545';
    }
  }
});

// Очистка кэша
document.getElementById('btnClearCache').addEventListener('click', () => {
  chrome.storage.local.get(null, (items) => {
    const keysToRemove = Object.keys(items).filter(k =>
      k.startsWith('astra_targets_') || k === 'astra_dates_tree'
    );
    if (keysToRemove.length === 0) { showMsg('Кэш уже пуст'); return; }
    chrome.storage.local.remove(keysToRemove, () => showMsg(`Удалено ${keysToRemove.length} записей`));
  });
});

// Сброс токена
const btnResetToken = document.getElementById('btnResetToken');
if (btnResetToken) {
  btnResetToken.addEventListener('click', () => {
    if (!confirm('Сбросить токен? Потребуется ввести новый для подключения.')) return;
    chrome.storage.local.remove('extensionToken', () => showMsg('Токен сброшен'));
    const tokenStatus = document.getElementById('tokenStatus');
    if (tokenStatus) { tokenStatus.textContent = '⚠️ Не задан'; tokenStatus.style.color = '#dc3545'; }
  });
}

function showMsg(text) {
  const btn = document.getElementById('btnClearCache');
  const orig = btn.textContent;
  btn.textContent = '✅ ' + text;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
}