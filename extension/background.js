// background.js — фоновый service worker расширения.
// Не имеет ограничений Mixed Content — подключается к ws:// и http:// с HTTPS страниц.

const WS_URL   = 'ws://186.246.2.6:5000';
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
chrome.alarms.create('wsKeepAlive', { periodInMinutes: 0.33 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'wsKeepAlive') return;
  hasAstramapsTabs((hasTabs) => {
    if (!hasTabs) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
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
    if (!hasTabs) return;
    _doConnect();
  });
}

function _doConnect() {
  console.log('[bg] Подключаемся к', WS_URL);
  for (const port of ports) port._authenticated = false;

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('[bg] WS подключён');
    broadcast({ type: 'WS_STATUS', status: 'connected' });
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'REGISTERED') {
        for (const port of ports) port._authenticated = true;
        broadcast(msg);
        return;
      }
      if (msg.type === 'AUTH_ERROR') {
        const hasAuth = [...ports].some(p => p._authenticated);
        if (!hasAuth) broadcast(msg);
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
      hasAstramapsTabs((hasTabs) => { if (hasTabs) _doConnect(); });
    }, 2000);
  };

  ws.onerror = (err) => console.error('[bg] WS ошибка:', err);
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

  port.postMessage({
    type:   'WS_STATUS',
    status: ws && ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected'
  });

  port.onMessage.addListener((msg) => {
    if (msg.type === 'REGISTER') port._authenticated = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  });

  port.onDisconnect.addListener(() => ports.delete(port));
});

// ── При открытии вкладки astramaps ────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.startsWith('https://center.astramaps.ru')) {
    connectWS();
  }
});

chrome.tabs.onRemoved.addListener(() => {
  hasAstramapsTabs((hasTabs) => {
    if (!hasTabs && ws && ws.readyState === WebSocket.OPEN) ws.close();
  });
});

// ── Медиа: загрузка файла на VPS (JSON + base64) ──────────────────────────────
// HTTP запрос из background.js не имеет Mixed Content ограничений.
async function handleMediaUpload({ entityId, mediaType, fileName, mimeType, base64Data }) {
  try {
    const res = await fetch(`${HTTP_URL}/media/upload`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ entityId, mediaType, fileName, mimeType, base64Data }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${text}` };
    }
    return await res.json(); // { ok: true, fileName, id }
  } catch (err) {
    console.error('[bg] Ошибка загрузки медиа:', err);
    return { ok: false, error: err.message };
  }
}

// ── Медиа: получить список файлов цели ────────────────────────────────────────
async function handleGetMediaList({ entityId }) {
  try {
    const res = await fetch(`${HTTP_URL}/media/list?entityId=${encodeURIComponent(entityId)}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return await res.json(); // { ok: true, media: [...] }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Медиа: удалить файл ───────────────────────────────────────────────────────
async function handleDeleteMedia({ id }) {
  try {
    const res = await fetch(`${HTTP_URL}/media/delete`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Медиа: получить файл как base64 (для показа на HTTPS странице) ────────────
async function handleGetMediaFile({ fileName, mimeType }) {
  try {
    const res = await fetch(`${HTTP_URL}/media/${encodeURIComponent(fileName)}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const buf   = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary  = '';
    // Конвертируем по кускам чтобы не переполнить стек
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return { ok: true, base64: btoa(binary), mimeType: mimeType || 'application/octet-stream' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}


// ── Потоковая передача видео (port-based) ─────────────────────────────────────
// Используем долгосрочное соединение (port) для передачи прогресса и данных.
// Это позволяет показывать прогресс загрузки большого видео.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'video-stream') return;

  port.onMessage.addListener(async ({ fileName, mimeType }) => {
    try {
      const res = await fetch(`${HTTP_URL}/media/${encodeURIComponent(fileName)}`);
      if (!res.ok) { port.postMessage({ type: 'ERROR', error: `HTTP ${res.status}` }); return; }

      const total  = parseInt(res.headers.get('content-length') || '0');
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        const progress = total ? Math.round(received / total * 100) : -1;
        try { port.postMessage({ type: 'PROGRESS', progress, received, total }); } catch {}
      }

      // Собираем все чанки в один буфер
      const combined = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }

      // base64 по частям (избегаем переполнение стека при больших файлах)
      let binary = '';
      const CHUNK = 8192;
      for (let i = 0; i < combined.length; i += CHUNK) {
        binary += String.fromCharCode(...combined.subarray(i, i + CHUNK));
      }

      try { port.postMessage({ type: 'DONE', base64: btoa(binary), mimeType }); } catch {}
    } catch (err) {
      try { port.postMessage({ type: 'ERROR', error: err.message }); } catch {}
    }
  });
});

// ── Количество медиафайлов для группы целей ───────────────────────────────────
async function handleGetMediaCounts({ entityIds }) {
  try {
    const ids = (entityIds || []).filter(Boolean).join(',');
    if (!ids) return { ok: true, counts: {} };
    const res = await fetch(`${HTTP_URL}/media/counts?entityIds=${encodeURIComponent(ids)}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Обработчик одноразовых сообщений от content script ───────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'UPLOAD_MEDIA') {
    handleMediaUpload(msg).then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_MEDIA_LIST') {
    handleGetMediaList(msg).then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'DELETE_MEDIA') {
    handleDeleteMedia(msg).then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_MEDIA_COUNTS') {
    handleGetMediaCounts(msg).then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_TARGET_INFO') {
    handleGetTargetInfo(msg).then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_MEDIA_FILE') {
    handleGetMediaFile(msg).then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

connectWS();

// ── Получить описание и заметки цели из SQLite ────────────────────────────────
async function handleGetTargetInfo({ entityId }) {
  try {
    const res = await fetch(`${HTTP_URL}/targets/info?entityId=${encodeURIComponent(entityId)}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}