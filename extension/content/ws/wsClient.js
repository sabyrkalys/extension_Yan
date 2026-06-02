// content/ws/wsClient.js
// Изменения:
// - передача токена при REGISTER
// - дублирование токена в localStorage (резерв для Android)
// - не удаляем токен автоматически при AUTH_ERROR
// - clearExtensionToken() чистит оба хранилища

let bgPort = null;
let _reconnectTimer = null;

try { chrome.storage.local.set({ wsUrl: WS_URL }); } catch {}

// ── Сохранить токен — пишем в оба хранилища ──────────────────────────────────
function saveExtensionToken(token, callback) {
  try { localStorage.setItem('astra_extension_token', token); } catch {}
  try {
    chrome.storage.local.set({ extensionToken: token }, () => {
      if (callback) callback();
    });
  } catch { if (callback) callback(); }
}

// ── Получить токен — проверяем оба хранилища ─────────────────────────────────
function getExtensionToken(callback) {
  try {
    chrome.storage.local.get(['extensionToken'], (result) => {
      if (result.extensionToken) {
        callback(result.extensionToken);
        return;
      }
      // Резерв — берём из localStorage
      try {
        const fallback = localStorage.getItem('astra_extension_token');
        if (fallback) {
          chrome.storage.local.set({ extensionToken: fallback });
          callback(fallback);
          return;
        }
      } catch {}
      callback(null);
    });
  } catch {
    try {
      const fallback = localStorage.getItem('astra_extension_token');
      callback(fallback || null);
    } catch { callback(null); }
  }
}

// ── Удалить токен из обоих хранилищ ──────────────────────────────────────────
function clearExtensionToken(callback) {
  try { localStorage.removeItem('astra_extension_token'); } catch {}
  try {
    chrome.storage.local.remove('extensionToken', () => {
      if (callback) callback();
    });
  } catch { if (callback) callback(); }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  if (!chrome.runtime?.id) return;
  if (bgPort) return;

  try {
    bgPort = chrome.runtime.connect({ name: 'ws-bridge' });

    bgPort.onMessage.addListener((msg) => {
      if (msg.type === 'WS_STATUS') {
        if (msg.status === 'connected') {
          console.log('[ws] 🟢 подключён');
          try { chrome.storage.local.set({ wsConnected: true }); } catch {}
          if (!store.get('myUsername')) fetchProfileDirect();
          else wsRegister();
        } else {
          console.log('[ws] 🔴 отключён');
          try { chrome.storage.local.set({ wsConnected: false }); } catch {}
          updateOnlineIndicator({});
        }
        return;
      }

      // AUTH_ERROR — НЕ удаляем токен автоматически
      if (msg.type === 'AUTH_ERROR') {
        console.error('[ws] ❌ Ошибка авторизации:', msg.text);
        showToast('❌ ' + msg.text + ' — обратитесь к администратору', 'error');
        return;
      }

      handleWsMessage(msg);
    });

    bgPort.onDisconnect.addListener(() => {
      bgPort = null;
      const err = chrome.runtime.lastError;
      if (err?.message?.includes('invalidated') || err?.message?.includes('invalid')) {
        console.warn('[ws] Контекст расширения невалиден — обновите страницу');
        return;
      }
      _reconnectTimer = setTimeout(connectWS, 2000);
    });

    console.log('[ws] Порт к background.js открыт');
  } catch (err) {
    bgPort = null;
    if (err.message?.includes('invalidated') || err.message?.includes('invalid')) return;
    console.error('[ws] Ошибка подключения:', err);
    _reconnectTimer = setTimeout(connectWS, 3000);
  }
}

function wsSend(data) {
  if (!chrome.runtime?.id) return;
  if (bgPort) { try { bgPort.postMessage(data); return; } catch {} }
  console.warn('[ws] Не подключён, сообщение потеряно:', data.type);
}

// ── Регистрация — всегда с токеном ───────────────────────────────────────────
function wsRegister() {
  const username = store.get('myUsername');
  if (!username) return;

  getExtensionToken((token) => {
    if (!token) {
      showTokenInputModal();
      return;
    }
    wsSend({
      type:        'REGISTER',
      token,
      userId:      store.get('myUserId'),
      username,
      displayName: store.get('myDisplayName'),
      role:        store.get('myRole'),
      officeId:    store.get('myOfficeId') || null,
    });
  });
}

// ── Явная регистрация с передачей всех параметров ────────────────────────────
function wsRegisterWithUser(userId, username, displayName, role) {
  const officeId = store.get('myOfficeId') || resolveOfficeAndRole(username)?.officeId || 'HQ';

  getExtensionToken((token) => {
    if (!token) {
      showTokenInputModal();
      return;
    }
    wsSend({ type: 'REGISTER', token, userId, username, displayName, role, officeId });
  });
}

// ── Модал ввода токена ────────────────────────────────────────────────────────
function showTokenInputModal() {
  document.querySelector('#token-input-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'token-input-modal';
  modal.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.75);
    display:flex;align-items:center;justify-content:center;
    z-index:100001;font-family:system-ui,sans-serif;
  `;
  modal.innerHTML = `
    <div style="background:white;border-radius:12px;padding:28px;width:340px;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
      <h3 style="margin:0 0 8px;color:#1e3a5f;font-size:17px;">🔑 Токен доступа</h3>
      <p style="font-size:13px;color:#666;margin:0 0 16px;line-height:1.5;">
        Введите токен, выданный администратором.
      </p>
      <input
        id="token-input-field"
        type="text"
        placeholder="Вставьте токен сюда..."
        style="width:100%;padding:10px;border:1px solid #ccc;border-radius:6px;
               font-size:13px;box-sizing:border-box;font-family:monospace;"
        autocomplete="off" spellcheck="false"
      />
      <div id="token-input-error" style="color:#dc3545;font-size:12px;margin-top:6px;display:none;"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
        <button id="token-input-confirm"
          style="padding:8px 20px;background:#1e3a5f;color:white;border:none;
                 border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;">
          Подключиться
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const input = modal.querySelector('#token-input-field');
  const errEl = modal.querySelector('#token-input-error');
  const btn   = modal.querySelector('#token-input-confirm');

  input.focus();

  const confirm = () => {
    // Чистим пробелы и переносы (частая проблема при копировании из Telegram)
    const token = input.value.trim().replace(/\s+/g, '');
    if (token.length < 16) {
      errEl.textContent = 'Токен слишком короткий — проверьте что скопировали полностью';
      errEl.style.display = 'block';
      return;
    }
    if (token.length !== 64) {
      errEl.textContent = `Неверная длина: ${token.length} символов (нужно 64)`;
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';

    // Сохраняем в оба хранилища
    saveExtensionToken(token, () => {
      modal.remove();
      const username = store.get('myUsername');
      if (username) {
        wsRegisterWithUser(
          store.get('myUserId'),
          username,
          store.get('myDisplayName'),
          store.get('myRole')
        );
      }
    });
  };

  btn.addEventListener('click', confirm);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); });
}

connectWS();