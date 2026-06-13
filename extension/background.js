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

// ── Загрузка медиафайла через chrome.scripting.executeScript (MAIN world) ────
// chrome.scripting.executeScript с world:'MAIN' выполняет код в контексте страницы
// — с полными cookies и сессией. Это официальный способ обойти изоляцию.
// background.js получает presignedUrl + base64 от content script,
// инжектирует PUT-запрос в MAIN world вкладки с center.astramaps.ru.
async function handleMediaUpload({ presignedUrl, mimeType, base64Data, token }, tabId) {
  try {
    if (!tabId) throw new Error('tabId не определён');

    // Выполняем PUT в MAIN world страницы:
    // — fetch в MAIN world имеет Sec-Fetch-Site: same-origin
    // — nginx видит Authorization + same-origin → стрипает Authorization → передаёт в MinIO
    // — MinIO валидирует presigned URL подпись → 200 OK
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  'MAIN',
      func:   async (url, b64, mime, tok) => {
        try {
          const bytes = atob(b64);
          const arr   = new Uint8Array(bytes.length);
          for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);

          const res = await fetch(url, {
            method:  'PUT',
            headers: {
              'Authorization': `Bearer ${tok}`,
              'x-amz-acl':     'public-read',
            },
            body: arr.buffer,
          });

          let errText = '';
          if (!res.ok) {
            try { errText = await res.text(); } catch {}
          }
          return { ok: res.ok, status: res.status, errText };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
      args: [presignedUrl, base64Data, mimeType, token],
    });

    const result = results?.[0]?.result;
    if (!result?.ok) {
      return { ok: false, error: `S3 PUT HTTP ${result?.status || '?'}: ${result?.errText || result?.error || ''}` };
    }
    return { ok: true };

  } catch (err) {
    console.error('[bg] executeScript error:', err);
    return { ok: false, error: err.message };
  }
}

// ── Обработчик одноразовых сообщений от content script ───────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'UPLOAD_MEDIA') {
    const tabId = sender.tab?.id;
    handleMediaUpload(msg, tabId)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // сигнал Chrome что ответ будет асинхронным
  }
});

// При старте — проверяем есть ли уже открытые вкладки
connectWS();