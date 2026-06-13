// background.js — фоновый service worker расширения.
// Не имеет ограничений Mixed Content — подключается к ws:// с HTTPS страниц.
// MV3: Chrome убивает SW через ~30 сек. chrome.alarms не даёт ему умереть.

const WS_URL = 'ws://186.246.2.6:5000';
const HTTP_URL = 'http://186.246.2.6:5001';

let ws = null;
let reconnectTimer = null;
const ports = new Set();

// ── Проверка активных вкладок astramaps ──────────────────────────────────────
function hasAstramapsTabs(callback) {
  chrome.tabs.query({ url: 'https://center.astramaps.ru/*' }, (tabs) => {
    callback(tabs.length > 0);
  });
}

// ── Keep-alive (MV3) ─────────────────────────────────────────────────────────
chrome.alarms.create('wsKeepAlive', { periodInMinutes: 0.33 }); // ~20 сек

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'wsKeepAlive') return;

  hasAstramapsTabs((hasTabs) => {
    if (!hasTabs) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('[bg] Нет вкладок astramaps — закрываем WS');
        ws.close();
      }
      return;
    }
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      connectWS();
    }
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  hasAstramapsTabs((hasTabs) => {
    if (!hasTabs) {
      console.log('[bg] Нет вкладок astramaps — пропускаем подключение');
      return;
    }
    _doConnect();
  });
}

function _doConnect() {
  console.log('[bg] Подключаемся к', WS_URL);

  // Сбрасываем флаг авторизации на всех портах при новом подключении
  for (const port of ports) port._authenticated = false;

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[bg] WS подключён');
    broadcast({ type: 'WS_STATUS', status: 'connected' });
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      // REGISTERED — помечаем все порты как авторизованные
      if (msg.type === 'REGISTERED') {
        for (const port of ports) port._authenticated = true;
        console.log('[bg] Авторизация подтверждена');
        broadcast(msg);
        return;
      }

      // AUTH_ERROR — рассылаем только если нет ни одного авторизованного порта
      if (msg.type === 'AUTH_ERROR') {
        const hasAuth = [...ports].some(p => p._authenticated);
        if (!hasAuth) {
          console.warn('[bg] AUTH_ERROR — нет авторизованных портов, рассылаем');
          broadcast(msg);
        } else {
          console.warn('[bg] AUTH_ERROR — есть авторизованные порты, игнорируем');
        }
        return;
      }

      broadcast(msg);
    } catch {}
  };

  ws.onclose = () => {
    console.log('[bg] WS отключён');
    for (const port of ports) port._authenticated = false;
    broadcast({ type: 'WS_STATUS', status: 'disconnected' });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      hasAstramapsTabs((hasTabs) => {
        if (hasTabs) _doConnect();
      });
    }, 2000);
  };

  ws.onerror = (err) => {
    console.error('[bg] WS ошибка:', err);
  };
}

function broadcast(msg) {
  for (const port of ports) {
    try { port.postMessage(msg); } catch {}
  }
}

// ── Порты от content.js ───────────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ws-bridge') return;
  port._authenticated = false;
  ports.add(port);
  console.log('[bg] Вкладка подключилась, всего:', ports.size);

  port.postMessage({
    type:   'WS_STATUS',
    status: ws && ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected'
  });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'REGISTER') {
      port._authenticated = false;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      console.warn('[bg] WS не подключён:', msg.type);
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(port);
    console.log('[bg] Вкладка отключилась, осталось:', ports.size);
  });
});

// ── При открытии вкладки astramaps — подключаемся ────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' &&
      tab.url?.startsWith('https://center.astramaps.ru')) {
    console.log('[bg] Открылась вкладка astramaps — подключаемся');
    connectWS();
  }
});

// ── При закрытии последней вкладки astramaps — отключаемся ───────────────────
chrome.tabs.onRemoved.addListener(() => {
  hasAstramapsTabs((hasTabs) => {
    if (!hasTabs && ws && ws.readyState === WebSocket.OPEN) {
      console.log('[bg] Все вкладки astramaps закрыты — отключаемся');
      ws.close();
    }
  });
});

// ── Загрузка медиафайла: проксируем через VPS → AstraMap S3 ────────────────
// Браузерный fetch не может делать PUT в MinIO (Host-header mismatch в presigned URL).
// VPS-сервер делает fetch от своего имени — без ограничений браузера.
async function handleMediaUpload({ token, mediaType, fileName, mimeType, base64Data }) {
  try {
    const res = await fetch(`${HTTP_URL}/media/upload-to-astra`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token, fileName, mimeType, mediaType, base64Data }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${text}` };
    }
    return await res.json(); // { ok: true, permanentURL, mediaItem }
  } catch (err) {
    console.error('[bg] Ошибка upload-to-astra:', err);
    return { ok: false, error: err.message };
  }
}

// ── Обработчик одноразовых сообщений от content script ───────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'UPLOAD_MEDIA') {
    handleMediaUpload(msg)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // сигнал Chrome что ответ будет асинхронным
  }
});

// При старте — проверяем есть ли уже открытые вкладки
connectWS();