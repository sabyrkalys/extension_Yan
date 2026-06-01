(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════
  // inject.js — выполняется в контексте СТРАНИЦЫ (не расширения).
  // Имеет доступ к window приложения, fetch, XHR.
  // Общается с content.js через CustomEvent на window.
  //
  // Задачи:
  // 1. Перехватить ответ /go/permission-group — взять myMembership
  // 2. Передать данные пользователя в content.js через CustomEvent
  // 3. Слушать ASTRA_FLY_TO и перемещать карту
  // ═══════════════════════════════════════════════════════════════════════

  // ── 1. ПЕРЕХВАТ FETCH ───────────────────────────────────────────────────
  // Приложение уже делает GET /go/permission-group при загрузке.
  // Подменяем window.fetch и смотрим на этот URL.

  const _originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await _originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

      if (url.includes('/go/permission-group')) {
        // Клонируем — тело можно читать только один раз
        const clone = response.clone();
        clone.json().then(data => {
          // data — массив групп, берём первую (или ту в которой есть myMembership)
          // Выбираем правильную группу из массива.
          // Пользователь может состоять в нескольких группах (служебные + боевые).
          // Приоритет: группа с наибольшим числом членов — это основная боевая группа.
          // Служебные группы типа "ASTRAV-ЧтениеЗапись" обычно маленькие.
          const groups = Array.isArray(data) ? data : [data];

          // Фильтруем только те группы где есть myMembership
          const myGroups = groups.filter(g => g.myMembership);

          if (!myGroups.length) return;

          // Среди них берём с наибольшим числом members (боевая группа)
          const group = myGroups.reduce((best, g) => {
            const bestCount = (best.members || []).length;
            const gCount    = (g.members    || []).length;
            return gCount > bestCount ? g : best;
          }, myGroups[0]);

          console.log('[inject] 👤 Пользователь:', group.myMembership.username,
                      '| Группа:', group.title,
                      '| Членов:', (group.members || []).length);

          window.dispatchEvent(new CustomEvent('ASTRA_USER_IDENTIFIED', {
            detail: {
              userId:      group.myMembership.id,
              username:    group.myMembership.username,
              displayName: group.myMembership.verboseName,
              position:    group.myMembership.position || '',
              groupId:     group.id,
              groupTitle:  group.title || '',
              members:     group.members || [],
            }
          }));
        }).catch(() => {});
      }
    } catch (_) {}

    return response;
  };

  // ── 2. ПЕРЕХВАТ XHR (на случай если приложение использует XMLHttpRequest) ──
  const _XHROpen = XMLHttpRequest.prototype.open;
  const _XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._interceptUrl = url;
    return _XHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._interceptUrl && this._interceptUrl.includes('/go/permission-group')) {
      this.addEventListener('load', () => {
        try {
          const data = JSON.parse(this.responseText);
          const groups = Array.isArray(data) ? data : [data];
          const myGroups = groups.filter(g => g.myMembership);
          if (!myGroups.length) return;

          const group = myGroups.reduce((best, g) => {
            return (g.members || []).length > (best.members || []).length ? g : best;
          }, myGroups[0]);

          console.log('[inject] 👤 (XHR) Пользователь:', group.myMembership.username,
                      '| Группа:', group.title);

          window.dispatchEvent(new CustomEvent('ASTRA_USER_IDENTIFIED', {
            detail: {
              userId:      group.myMembership.id,
              username:    group.myMembership.username,
              displayName: group.myMembership.verboseName,
              position:    group.myMembership.position || '',
              groupId:     group.id,
              groupTitle:  group.title || '',
              members:     group.members || [],
            }
          }));
        } catch (_) {}
      });
    }
    return _XHRSend.apply(this, args);
  };

  // ── 3. КАРТА — поиск инстанса mapboxgl ─────────────────────────────────
  function getMapInstance() {
    const canvas = document.querySelector('canvas.mapboxgl-canvas');
    if (!canvas) return null;
    if (canvas._map) return canvas._map;
    const container = canvas.closest('.mapboxgl-map');
    if (container && container._map) return container._map;
    return null;
  }

  function waitForMap(callback) {
    let attempts = 0;
    const timer = setInterval(() => {
      const map = getMapInstance();
      attempts++;
      if (map) { clearInterval(timer); callback(map); return; }
      if (attempts > 100) clearInterval(timer);
    }, 100);
  }

  function flyTo(map, lon, lat) {
    map.flyTo({
      center:   [lon, lat],
      zoom:     Math.max(map.getZoom(), 15),
      duration: 1200,
      essential: true
    });
  }

  function simulateClickOnMap(map, lon, lat) {
    const canvas = document.querySelector('canvas.mapboxgl-canvas');
    if (!canvas) return;
    const point   = map.project([lon, lat]);
    const rect    = canvas.getBoundingClientRect();
    const clientX = rect.left + point.x;
    const clientY = rect.top  + point.y;

    ['pointerdown','pointerup'].forEach(type =>
      canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX, clientY, pointerId: 1, isPrimary: true
      }))
    );
    ['mousemove','mousedown','mouseup','click'].forEach(type =>
      canvas.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window, clientX, clientY
      }))
    );
  }

  function handleFlyTo(lon, lat, id) {
    const map = getMapInstance();
    if (!map) { waitForMap(m => handleFlyTo(lon, lat, id)); return; }
    flyTo(map, lon, lat);
    map.once('moveend', () => simulateClickOnMap(map, lon, lat));
  }

  // ── 4. СЛУШАЕМ СОБЫТИЯ ОТ content.js ────────────────────────────────────
  window.addEventListener('ASTRA_FLY_TO', function (event) {
    const { lon, lat, id } = event.detail || {};
    if (isNaN(parseFloat(lon)) || isNaN(parseFloat(lat))) return;
    handleFlyTo(parseFloat(lon), parseFloat(lat), id);
  });

  // ── Диагностика при загрузке ─────────────────────────────────────────────
  const earlyMap = getMapInstance();
  console.log('[inject] Карта при загрузке:', earlyMap ? 'найдена' : 'ожидаем...');
  if (!earlyMap) waitForMap(() => console.log('[inject] Карта готова'));

})();