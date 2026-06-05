// background.js — фоновый service worker расширения.
// Не имеет ограничений Mixed Content — подключается к ws:// с HTTPS страниц.
// MV3: Chrome убивает SW через ~30 сек. chrome.alarms не даёт ему умереть.

const WS_URL = 'ws://186.246.2.6:5000';

let ws = null;
let reconnectTimer = null;
const ports = new Set();

// ── Проверка активных вкладок astramaps ───────────────────────────────────────
function hasAstramapsTabs(callback) {
  chrome.tabs.query({ url: 'https://center.astramaps.ru/*' }, (tabs) => {
    callback(tabs.length > 0);
  });
}

// ── Keep-alive (MV3) ──────────────────────────────────────────────────────────
chrome.alarms.create('wsKeepAlive', { periodInMinutes: 0.33 }); // ~20 сек

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'wsKeepAlive') return;

  hasAstramapsTabs((hasTabs) => {
    if (!hasTabs) {
      // Нет вкладок — закрываем соединение если открыто
      if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('[bg] Нет вкладок astramaps — закрываем WS');
        ws.close();
      }
      return;
    }
    // Есть вкладки — переподключаемся если нужно
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      connectWS();
    }
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  // Подключаемся только если есть активные вкладки astramaps
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
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[bg] WS подключён');
    broadcast({ type: 'WS_STATUS', status: 'connected' });
  };

  ws.onmessage = (event) => {
    try { broadcast(JSON.parse(event.data)); } catch {}
  };

  ws.onclose = () => {
    console.log('[bg] WS отключён');
    broadcast({ type: 'WS_STATUS', status: 'disconnected' });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    // Реконнект только если есть вкладки
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
  ports.add(port);
  console.log('[bg] Вкладка подключилась, всего:', ports.size);

  port.postMessage({
    type: 'WS_STATUS',
    status: ws && ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected'
  });

  port.onMessage.addListener((msg) => {
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

// При старте — проверяем есть ли уже открытые вкладки
connectWS();