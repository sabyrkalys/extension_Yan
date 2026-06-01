// content/ws/wsClient.js

let bgPort = null;
let _reconnectTimer = null;

try { chrome.storage.local.set({ wsUrl: WS_URL }); } catch {}

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

function wsRegister() {
  const username = store.get('myUsername');
  if (!username) return;
  wsSend({
    type:        'REGISTER',
    userId:      store.get('myUserId'),
    username,
    displayName: store.get('myDisplayName'),
    role:        store.get('myRole'),
    officeId:    store.get('myOfficeId') || null,
  });
}


// Явная регистрация с передачей всех параметров (вызывается из content.js)
function wsRegisterWithUser(userId, username, displayName, role) {
  const officeId = store.get('myOfficeId') || resolveOfficeAndRole(username)?.officeId || 'HQ';
  wsSend({ type: 'REGISTER', userId, username, displayName, role, officeId });
}

connectWS();
