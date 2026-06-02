'use strict';

const manifest = chrome.runtime.getManifest();
document.getElementById('extVersion').textContent = 'v' + manifest.version;

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

  const tokenStatus = document.getElementById('tokenStatus');
  if (tokenStatus) {
    if (data.extensionToken) {
      tokenStatus.textContent = `🔑 ${data.extensionToken.slice(0, 8)}...`;
      tokenStatus.style.color = '#28a745';
    } else {
      // Проверяем резервное хранилище
      try {
        const fallback = localStorage.getItem('astra_extension_token');
        if (fallback) {
          tokenStatus.textContent = `🔑 ${fallback.slice(0, 8)}... (резерв)`;
          tokenStatus.style.color = '#fd7e14';
          return;
        }
      } catch {}
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

// Сброс токена — удаляем из ОБОИХ хранилищ
const btnResetToken = document.getElementById('btnResetToken');
if (btnResetToken) {
  btnResetToken.addEventListener('click', () => {
    if (!confirm('Сбросить токен? Потребуется ввести новый для подключения.')) return;
    // Удаляем из chrome.storage
    chrome.storage.local.remove('extensionToken', () => showMsg('Токен сброшен'));
    // Удаляем из localStorage (резервное хранилище)
    try { localStorage.removeItem('astra_extension_token'); } catch {}
    const tokenStatus = document.getElementById('tokenStatus');
    if (tokenStatus) {
      tokenStatus.textContent = '⚠️ Не задан';
      tokenStatus.style.color = '#dc3545';
    }
  });
}

function showMsg(text) {
  const btn = document.getElementById('btnClearCache');
  const orig = btn.textContent;
  btn.textContent = '✅ ' + text;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
}