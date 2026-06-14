// content/ui/panel.js

// ── Загрузка медиафайла на VPS через background.js ────────────────────────────
// background.js делает HTTP запрос (нет Mixed Content). Файл → base64 → JSON → VPS.
async function uploadMediaFile(entityId, file, mediaType) {
  const label = mediaType === 'photo' ? 'Фото' : 'Видео';
  try {
    const base64Data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('Ошибка чтения файла'));
      reader.readAsDataURL(file);
    });

    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type:      'UPLOAD_MEDIA',
        entityId:  String(entityId),
        mediaType,
        fileName:  file.name,
        mimeType:  file.type || 'application/octet-stream',
        base64Data,
      }, (res) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(res || { ok: false, error: 'Нет ответа' });
      });
    });

    if (response.ok) {
      showToast(`✅ ${label} загружено`, 'success');
      return true;
    } else {
      throw new Error(response.error || 'Ошибка');
    }
  } catch (err) {
    console.error(`[media] Ошибка ${mediaType}:`, err);
    showToast(`❌ Ошибка загрузки ${label}: ${err.message}`, 'error');
    return false;
  }
}

// ── Галерея медиафайлов ───────────────────────────────────────────────────────
let _galleryEntityId  = null;
let _galleryTitle     = '';
let _galleryMediaList = [];

async function showMediaGallery(entityId, title) {
  _galleryEntityId  = String(entityId);
  _galleryTitle     = title || entityId;

  const modal = document.querySelector('#mediaGalleryModal');
  if (!modal) return;

  modal.querySelector('#galleryTitle').textContent = `Медиафайлы: ${_galleryTitle}`;
  modal.querySelector('#galleryContent').innerHTML =
    '<div style="text-align:center;padding:20px;color:#666;">⏳ Загружаем список...</div>';
  modal.style.display = 'flex';

  const response = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_MEDIA_LIST', entityId: _galleryEntityId }, resolve);
  });

  if (!response?.ok) {
    modal.querySelector('#galleryContent').innerHTML =
      `<div style="color:#dc3545;padding:12px;">Ошибка: ${response?.error || 'неизвестно'}</div>`;
    return;
  }

  _galleryMediaList = response.media || [];
  await renderGallery();
}

async function renderGallery() {
  const modal   = document.querySelector('#mediaGalleryModal');
  if (!modal) return;
  const content = modal.querySelector('#galleryContent');

  const photos = _galleryMediaList.filter(m => m.media_type === 'photo');
  const videos = _galleryMediaList.filter(m => m.media_type === 'video');

  content.innerHTML = `
    <!-- Фото -->
    <div style="margin-bottom:16px;">
      <div style="font-size:13px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">
        📷 Фото (${photos.length})
      </div>
      <div id="galleryPhotos" style="display:flex;flex-wrap:wrap;gap:8px;min-height:40px;">
        ${photos.length === 0
          ? '<span style="color:#aaa;font-size:12px;">нет фото</span>'
          : photos.map(m => `
            <div data-media-id="${m.id}" data-slide-idx="${photos.indexOf(m)}" style="position:relative;width:100px;height:100px;
              border:1px solid #ddd;border-radius:6px;overflow:hidden;background:#f5f5f5;
              display:flex;align-items:center;justify-content:center;cursor:zoom-in;">
              <img data-filename="${m.file_name}" data-mime="image/jpeg"
                src="" style="max-width:100%;max-height:100%;object-fit:cover;"
                title="${m.file_name} — клик для просмотра" />
              <span style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.5);
                color:white;font-size:9px;padding:2px 4px;overflow:hidden;text-overflow:ellipsis;
                white-space:nowrap;">${m.file_name}</span>
              <button class="gallery-del-btn" data-id="${m.id}"
                style="position:absolute;top:2px;right:2px;background:rgba(220,53,69,0.85);
                color:white;border:none;border-radius:3px;cursor:pointer;font-size:10px;
                padding:1px 5px;line-height:1.4;">✕</button>
            </div>`).join('')}
      </div>
    </div>
    <!-- Видео -->
    <div>
      <div style="font-size:13px;font-weight:600;color:#1e3a5f;margin-bottom:8px;">
        🎥 Видео (${videos.length})
      </div>
      <div id="galleryVideos" style="display:flex;flex-direction:column;gap:4px;min-height:20px;">
        ${videos.length === 0
          ? '<span style="color:#aaa;font-size:12px;">нет видео</span>'
          : videos.map(m => {
              const kb = m.file_size ? ' (' + (m.file_size / 1024).toFixed(0) + ' КБ)' : '';
              return `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;
                background:#f8f9fa;border:1px solid #dee2e6;border-radius:4px;">
                <span style="cursor:pointer;" title="Нажмите для просмотра">🎥</span>
                <span class="gallery-video-play" data-slide-idx="${_galleryMediaList.indexOf(m)}"
                  style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;
                  white-space:nowrap;cursor:pointer;color:#1a5276;text-decoration:underline dotted;"
                  title="${m.file_name} — клик для воспроизведения">${m.file_name}${kb}</span>
                <button class="gallery-del-btn" data-id="${m.id}"
                  style="background:#dc3545;color:white;border:none;border-radius:3px;
                  cursor:pointer;font-size:10px;padding:2px 7px;">✕</button>
              </div>`;
            }).join('')}
      </div>
    </div>`;

  // Загружаем превью фото через background.js (HTTP→base64)
  content.querySelectorAll('img[data-filename]').forEach(async (img) => {
    const fileName = img.getAttribute('data-filename');
    const ext      = fileName.split('.').pop().toLowerCase();
    const mimeMap  = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png',
                       webp:'image/webp', gif:'image/gif', bmp:'image/bmp' };
    const mimeType = mimeMap[ext] || 'image/jpeg';
    const res = await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'GET_MEDIA_FILE', fileName, mimeType }, resolve)
    );
    if (res?.ok) img.src = `data:${mimeType};base64,${res.base64}`;
    else img.style.cssText += ';opacity:0.4;';
  });

  // Клик по фото — открыть слайдер
  content.querySelectorAll('[data-slide-idx]').forEach(el => {
    el.addEventListener('click', async (e) => {
      if (e.target.classList.contains('gallery-del-btn')) return;
      const idx = parseInt(el.getAttribute('data-slide-idx'));
      await showSlideshow(_galleryMediaList, idx, _galleryEntityId);
    });
  });

  // Клик по названию видео — открыть слайдер
  content.querySelectorAll('.gallery-video-play').forEach(el => {
    el.addEventListener('click', async () => {
      const idx = parseInt(el.getAttribute('data-slide-idx'));
      await showSlideshow(_galleryMediaList, idx, _galleryEntityId);
    });
  });

  // Удаление
  content.querySelectorAll('.gallery-del-btn').forEach(btn => {
    btn.addEventListener('click', withLock(btn, async () => {
      const id = parseInt(btn.getAttribute('data-id'));
      if (!confirm('Удалить файл?')) return;
      const res = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'DELETE_MEDIA', id }, resolve)
      );
      if (res?.ok) {
        _galleryMediaList = _galleryMediaList.filter(m => m.id !== id);
        await renderGallery();
        _syncMediaFlags(_galleryEntityId, _galleryMediaList);
        showToast('Файл удалён', 'success');
      } else {
        showToast('Ошибка удаления: ' + (res?.error || ''), 'error');
      }
    }, { label: '...' }));
  });
}

// Синхронизировать _mediaFlags + SQLite + кнопки в строке таблицы
function _syncMediaFlags(entityId, mediaList) {
  const hasPhoto = mediaList.some(m => m.media_type === 'photo');
  const hasVideo = mediaList.some(m => m.media_type === 'video');
  _mediaFlags[entityId + '_photo'] = hasPhoto;
  _mediaFlags[entityId + '_video'] = hasVideo;
  const row = document.querySelector(`#statusTable tr[data-target-id="${entityId}"]`);
  if (row) _applyMediaFlags(row, entityId);
  wsSend({
    type:      'UPDATE_TARGET_LOCAL',
    entity_id: String(entityId),
    has_photo: hasPhoto ? 1 : 0,
    has_video: hasVideo ? 1 : 0,
  });
}

// ── Загрузка нескольких файлов из галереи ─────────────────────────────────────
async function _galleryUploadFiles(files, mediaType) {
  let uploaded = 0;
  for (const file of Array.from(files)) {
    showToast(`⏳ Загружаем ${file.name}...`, 'info');
    const ok = await uploadMediaFile(_galleryEntityId, file, mediaType);
    if (ok) uploaded++;
  }
  if (uploaded > 0) {
    // Обновляем список
    const res = await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'GET_MEDIA_LIST', entityId: _galleryEntityId }, resolve)
    );
    if (res?.ok) {
      _galleryMediaList = res.media || [];
      await renderGallery();
      _syncMediaFlags(_galleryEntityId, _galleryMediaList);
    }
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// СЛАЙДЕР МЕДИАФАЙЛОВ
// ══════════════════════════════════════════════════════════════════════════════
let _slideMedia    = [];   // все медиа текущей цели
let _slideIndex    = 0;    // текущий индекс
let _slideEntityId = null;
let _slideDesc     = '';   // описание из AstraMap (targets.description)
let _slideNotes    = '';   // локальное описание (targets.notes)
let _slideBlobUrl  = null; // текущий blob URL видео (чистим при смене слайда)

// Открыть слайдер начиная с указанного индекса
async function showSlideshow(mediaList, startIndex, entityId) {
  _slideMedia    = mediaList;
  _slideIndex    = Math.max(0, Math.min(startIndex, mediaList.length - 1));
  _slideEntityId = String(entityId);

  const modal = document.querySelector('#mediaSlideshowModal');
  if (!modal) return;
  modal.style.display = 'flex';

  // Загружаем описание из SQLite
  const infoRes = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'GET_TARGET_INFO', entityId: _slideEntityId }, resolve)
  );
  _slideDesc  = infoRes?.description || '';
  _slideNotes = infoRes?.notes       || '';

  await _renderSlide();
}

// Отрисовка текущего слайда
async function _renderSlide() {
  const modal = document.querySelector('#mediaSlideshowModal');
  if (!modal || !_slideMedia.length) return;

  // Очищаем предыдущий blob URL (видео)
  if (_slideBlobUrl) { URL.revokeObjectURL(_slideBlobUrl); _slideBlobUrl = null; }

  const item    = _slideMedia[_slideIndex];
  const total   = _slideMedia.length;
  const isFirst = _slideIndex === 0;
  const isLast  = _slideIndex === total - 1;

  // Счётчик
  modal.querySelector('#slideCounter').textContent = `${_slideIndex + 1} / ${total}`;

  // Стрелки
  const prevBtn = modal.querySelector('#slidePrev');
  const nextBtn = modal.querySelector('#slideNext');
  prevBtn.style.opacity = isFirst ? '0.25' : '1';
  prevBtn.style.cursor  = isFirst ? 'default' : 'pointer';
  nextBtn.style.opacity = isLast  ? '0.25' : '1';
  nextBtn.style.cursor  = isLast  ? 'default' : 'pointer';

  // Точки-индикаторы
  const dotsEl = modal.querySelector('#slideDots');
  dotsEl.innerHTML = _slideMedia.map((m, i) => `
    <span data-dot="${i}" style="
      display:inline-block;width:${i===_slideIndex?'12px':'9px'};height:${i===_slideIndex?'12px':'9px'};
      border-radius:50%;cursor:pointer;margin:0 4px;transition:0.2s;
      background:${i===_slideIndex?'#2c7da0':'#ccc'};
      border:${i===_slideIndex?'2px solid #1a5276':'2px solid transparent'};
    "></span>`).join('');
  dotsEl.querySelectorAll('[data-dot]').forEach(dot => {
    dot.addEventListener('click', async () => {
      _slideIndex = parseInt(dot.getAttribute('data-dot'));
      await _renderSlide();
    });
  });

  // Контент
  const contentEl = modal.querySelector('#slideContent');
  contentEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:14px;">⏳ Загружаем...</div>';

  const ext     = item.file_name.split('.').pop().toLowerCase();
  const mimeMap = {
    jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',
    gif:'image/gif',bmp:'image/bmp',
    mp4:'video/mp4',mov:'video/quicktime',avi:'video/x-msvideo',
    webm:'video/webm',mkv:'video/x-matroska',
  };
  const mimeType = mimeMap[ext] || (item.media_type==='video' ? 'video/mp4' : 'image/jpeg');

  const res = await new Promise(resolve =>
    chrome.runtime.sendMessage({ type: 'GET_MEDIA_FILE', fileName: item.file_name, mimeType }, resolve)
  );

  if (!res?.ok) {
    contentEl.innerHTML = `<div style="color:#dc3545;text-align:center;padding:20px;">❌ Ошибка загрузки: ${res?.error||''}</div>`;
    return;
  }

  if (item.media_type === 'photo') {
    const img = document.createElement('img');
    img.src = `data:${mimeType};base64,${res.base64}`;
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;border-radius:4px;';
    contentEl.innerHTML = '';
    contentEl.appendChild(img);
  } else {
    // Видео: base64 → Blob URL
    const bytes = atob(res.base64);
    const arr   = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    _slideBlobUrl = URL.createObjectURL(new Blob([arr], { type: mimeType }));
    const video   = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.style.cssText = 'max-width:100%;max-height:100%;border-radius:4px;background:#000;';
    const source = document.createElement('source');
    source.src  = _slideBlobUrl;
    source.type = mimeType;
    video.appendChild(source);
    contentEl.innerHTML = '';
    contentEl.appendChild(video);
  }

  // Описание
  const displayDesc = _slideNotes || _slideDesc || '';
  const descInput = modal.querySelector('#slideDescInput');
  if (descInput) descInput.value = displayDesc;
  const descPlaceholder = modal.querySelector('#slideDescPlaceholder');
  if (descPlaceholder) descPlaceholder.style.display = displayDesc ? 'none' : 'block';
}

// Навигация клавиатурой
document.addEventListener('keydown', async (e) => {
  const modal = document.querySelector('#mediaSlideshowModal');
  if (!modal || modal.style.display === 'none') return;
  if (e.key === 'ArrowLeft'  && _slideIndex > 0) { _slideIndex--; await _renderSlide(); }
  if (e.key === 'ArrowRight' && _slideIndex < _slideMedia.length - 1) { _slideIndex++; await _renderSlide(); }
  if (e.key === 'Escape') {
    modal.style.display = 'none';
    if (_slideBlobUrl) { URL.revokeObjectURL(_slideBlobUrl); _slideBlobUrl = null; }
  }
});

function createPopup() {
  if (popupElement) return popupElement;

  popupElement = document.createElement('div');
  popupElement.id = 'extension-popup';
  popupElement.innerHTML = `
  <div style="
    position: fixed; top: 25px; right: 20px; width: 70%;
    max-height: calc(100vh - 40px); background: white; border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.25); z-index: 10;
    display: flex; flex-direction: column; overflow: hidden;
    font-family: system-ui, sans-serif;">
    <style>
      #statusTable { width: 100%; min-width:1000px; border-collapse: collapse; font-size: 12px; }
      #statusTable th, #statusTable td { padding: 10px 8px; border: 1px solid #d0d7de; text-align: center; vertical-align: middle; }
      #statusTable th:nth-child(2), #statusTable td:nth-child(2) { width: 110px; min-width: 85px; max-width: 180px; }
      .editable { background: #fff9e6; min-height: 44px; }
      select, button { font-size: 12px; min-height: 44px; padding: 8px 12px; touch-action: manipulation; border-radius: 8px; }
      .table-wrapper { overflow-y: auto; -webkit-overflow-scrolling: touch; }
      .table-wrapper::-webkit-scrollbar, #tasksPanel::-webkit-scrollbar, #planningPanel::-webkit-scrollbar { width: 8px; height: 8px; }
      .table-wrapper::-webkit-scrollbar-track, #tasksPanel::-webkit-scrollbar-track, #planningPanel::-webkit-scrollbar-track { background: #e9ecef; border-radius: 4px; }
      .table-wrapper::-webkit-scrollbar-thumb, #tasksPanel::-webkit-scrollbar-thumb, #planningPanel::-webkit-scrollbar-thumb { background: #2c7da0; border-radius: 4px; }
      #statusTable thead th { background: #fff; }
      .button-panel { display: flex; justify-content: flex-end; gap: 12px; flex-wrap: wrap; padding: 12px 16px; background: #e9ecef; border-top: 1px solid #ced4da; flex-shrink: 0; }
      #addTargetModal input[type="text"], #addTargetModal input[type="number"],
      #addTargetModal input[type="time"], #addTargetModal input[type="date"],
      #addTargetModal select { width:100%;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:13px;box-sizing:border-box;min-height:unset; }
      #addTargetModal label { font-size:12px;color:#555;display:block;margin-bottom:4px; }
      .file-input-wrap { border:1px dashed #ccc;border-radius:6px;padding:8px 10px;background:#fafafa; }
      .file-input-wrap input[type="file"] { width:100%;font-size:12px;cursor:pointer; }
      .file-preview { margin-top:6px;font-size:11px;color:#28a745;display:none; }
    </style>

    <!-- Шапка -->
    <div style="padding:5px 14px;background:#1e3a5f;color:white;display:flex;flex-direction:column;flex-shrink:0;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="display:flex;align-items:center;gap:8px;">
          <h3 style="margin:0;font-size:16px;">📋 Таблица учёта целей</h3>
          <button id="addTargetBtn" style="background:#28a745;color:white;border:none;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:14px;">+ Добавить цель</button>
          <div style="position:relative;display:inline-block;">
            <button id="showTasksBtn" style="background:#fd7e14;color:white;border:none;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:14px;">📋 Задачи</button>
            <span id="task-badge" style="display:none;position:absolute;top:-6px;right:-6px;background:#dc3545;color:white;border-radius:50%;width:18px;height:18px;font-size:11px;align-items:center;justify-content:center;font-weight:600;"></span>
          </div>
          <button id="showPlanningBtn" style="background:#6f42c1;color:white;border:none;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:14px;">📅 Спланировано</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span id="myRoleTag" style="font-size:12px;background:#2c5282;padding:4px 10px;border-radius:6px;white-space:nowrap;">🔄 Определяю расчёт...</span>
          <button id="closePopupBtn" style="background:none;border:none;color:white;font-size:28px;padding:2px 12px;cursor:pointer;">&times;</button>
        </div>
      </div>
      <div id="online-indicator" style="padding:4px 6px;font-size:11px;opacity:0.9;min-height:18px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;"></div>
    </div>

    <!-- Панель дат -->
    <div id="dates-panel" style="background:#162d4a;padding:6px 14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid #0d1f33;min-height:36px;">
      <span style="font-size:11px;color:#7aa3c8;margin-right:4px;">📅 Даты:</span>
      <div id="dates-list" style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;">
        <span style="font-size:11px;color:#5a7fa0;">загрузка...</span>
      </div>
      <div style="margin-left:auto;display:flex;gap:6px;align-items:center;">
        <button id="publishPlanBtn" title="Опубликовать план" style="display:none;background:#28a745;border:none;color:white;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:11px;">📤 Опубликовать план</button>
        <button id="refreshDatesBtn" title="Обновить даты" style="background:none;border:1px solid #4a7a9b;color:#7aa3c8;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;">🔄</button>
      </div>
    </div>

    <!-- Таблица целей -->
    <div class="table-wrapper" style="flex:1;overflow-y:auto;padding:12px;background:#f5f7fa;color:black;">
      <table id="statusTable">
        <thead>
          <tr>
            <th rowspan="2" style="min-width:70px;">Дата обнаруж.</th>
            <th rowspan="2">Номер цели</th>
            <th rowspan="2" style="min-width:130px;">Характер цели</th>
            <th rowspan="2" style="min-width:80px;">Адрес цели</th>
            <th colspan="2">Координаты</th>
            <th rowspan="2">Просмотр на карте</th>
            <th rowspan="2" style="min-width:120px;">Результат</th>
            <th rowspan="2" style="min-width:120px;">Назначить задачу</th>
            <th rowspan="2" style="min-width:80px;">Дата уничтожения</th>
            <th rowspan="2">Сформировать формуляр</th>
          </tr>
          <tr><th>X</th><th>Y</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <!-- Панель задач -->
    <div id="tasksPanel" style="display:none;flex:1;overflow-y:auto;padding:12px;background:#f5f7fa;color:black;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong style="font-size:14px;">Задачи между расчётами</strong>
        <button id="newTaskBtn" style="background:#fd7e14;color:white;border:none;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:12px;">+ Новая задача</button>
      </div>
      <table id="tasksTable" style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="background:#e9ecef;">
            <th style="padding:6px;border:1px solid #d0d7de;text-align:left;">Время</th>
            <th style="padding:6px;border:1px solid #d0d7de;">От</th>
            <th style="padding:6px;border:1px solid #d0d7de;">Кому</th>
            <th style="padding:6px;border:1px solid #d0d7de;text-align:left;">Задача</th>
            <th style="padding:6px;border:1px solid #d0d7de;">Статус</th>
            <th style="padding:6px;border:1px solid #d0d7de;">Действие</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <!-- Панель планирования -->
    <div id="planningPanel" style="display:none;flex-direction:column;flex:1;overflow:hidden;background:#f5f7fa;color:black;"></div>

    <!-- Модал новой задачи -->
    <div id="newTaskModal" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);display:none;justify-content:center;align-items:center;z-index:10001;">
      <div style="background:white;width:90%;max-width:420px;border-radius:10px;padding:20px;display:flex;flex-direction:column;gap:10px;">
        <h3 style="margin:0;font-size:16px;">Новая задача</h3>
        <label style="font-size:12px;color:#555;">Подразделение получателя:</label>
        <select id="taskOfficeSelect" style="padding:6px;border-radius:5px;border:1px solid #ccc;"><option value="">— выберите —</option></select>
        <label style="font-size:12px;color:#555;">Кому:</label>
        <select id="taskTo" style="padding:6px;border-radius:5px;border:1px solid #ccc;"><option value="">— выберите —</option></select>
        <label style="font-size:12px;color:#555;">Объект (необязательно):</label>
        <select id="taskTargetSelect" style="padding:6px;border-radius:5px;border:1px solid #ccc;"><option value="">— без привязки —</option></select>
        <label style="font-size:12px;color:#555;">Текст задачи:</label>
        <textarea id="taskText" rows="3" placeholder="Текст задачи..." style="padding:6px;border-radius:5px;border:1px solid #ccc;resize:vertical;font-size:13px;"></textarea>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="cancelNewTask" style="padding:6px 14px;border-radius:5px;border:1px solid #ccc;cursor:pointer;">Отмена</button>
          <button id="submitNewTask" style="padding:6px 14px;background:#fd7e14;color:white;border:none;border-radius:5px;cursor:pointer;font-weight:600;">Поставить задачу</button>
        </div>
      </div>
    </div>

    <!-- Кнопки внизу -->
    <div class="button-panel">
      <button id="exportTableData" style="background:#007bff;color:white;">📎 Экспорт Excel</button>
      <button id="loadTodayMap" style="background:#17a2b8;color:white;">📥 Сегодня</button>
    </div>

    <!-- ═══ Модал добавления цели ═══ -->
    <div id="addTargetModal" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);display:none;justify-content:center;align-items:center;z-index:10000;">
      <div style="background:white;width:90%;max-width:520px;border-radius:10px;padding:20px;display:flex;flex-direction:column;gap:10px;max-height:90vh;overflow-y:auto;">
        <h3 style="margin:0;font-size:16px;">Добавление цели</h3>
        <label>Название цели (необязательно):</label>
        <input id="targetTitle" type="text" placeholder="Краткое название" />
        <label>Категория цели:</label>
        <select id="targetType">
          <option value="" disabled selected>— Выберите категорию —</option>
          <option value="ПУ">ПУ</option><option value="ПУ БПЛА">ПУ БПЛА</option>
          <option value="Точка влета">Точка взлёта</option><option value="РЛС">РЛС</option>
          <option value="РЭБ">РЭБ</option><option value="Связь">Связь</option>
          <option value="ЗРК">ЗРК</option><option value="ПЗРК">ПЗРК</option>
          <option value="Танк">Танк</option><option value="БМП">БМП</option>
          <option value="ББМ">ББМ</option><option value="БТР">БТР</option>
          <option value="Гаубица">Гаубица</option><option value="САУ">САУ</option>
          <option value="РСЗО">РСЗО</option><option value="Миномёт">Миномёт</option>
          <option value="Склад">Склад</option><option value="КНП">КНП</option>
          <option value="Укрытие">Укрытие</option><option value="Блиндаж">Блиндаж</option>
          <option value="Личный состав">Личный состав</option>
        </select>
        <label>Адрес / местность объекта:</label>
        <input id="targetAddress" type="text" placeholder="н-р: лесной массив, 500м с. н.п. Петровка" />
        <div style="display:flex;gap:10px;">
          <div style="flex:1;"><label>Координата X (СК-42):</label><input id="coordX" type="number" placeholder="X" /></div>
          <div style="flex:1;"><label>Координата Y (СК-42):</label><input id="coordY" type="number" placeholder="Y" /></div>
        </div>
        <div style="display:flex;gap:10px;">
          <div style="flex:1;"><label>Дата обнаружения:</label><input id="impactDate" type="date" /></div>
          <div style="flex:1;"><label>Время обнаружения:</label><input id="impactTime" type="time" /></div>
        </div>
        <label>Результат:</label>
        <select id="impactResult">
          <option value="вскрыто" selected>Вскрыто</option>
          <option value="поражена">Поражена</option>
          <option value="не_поражена">Не поражена</option>
          <option value="передано_на_доразведку">Передано на доразведку</option>
          <option value="подтверждено">Подтверждено</option>
          <option value="подавлено">Подавлено</option>
        </select>
        <label>📷 Фото (можно несколько):</label>
        <div class="file-input-wrap">
          <input id="targetPhoto" type="file" accept="image/*" multiple />
          <div id="targetPhotoPreview" class="file-preview">✅ Выбрано: <span id="targetPhotoName"></span></div>
        </div>
        <label>🎥 Видео (можно несколько):</label>
        <div class="file-input-wrap">
          <input id="targetVideo" type="file" accept="video/*" multiple />
          <div id="targetVideoPreview" class="file-preview">✅ Выбрано: <span id="targetVideoName"></span></div>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px;">
          <button id="cancelAddTarget" style="padding:7px 16px;border:1px solid #ccc;border-radius:6px;cursor:pointer;background:white;">Отмена</button>
          <button id="submitAddTarget" style="padding:7px 16px;background:#28a745;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;">💾 Добавить</button>
        </div>
      </div>
    </div>

    <!-- ═══ Модал галереи медиафайлов ═══ -->
    <div id="mediaGalleryModal" style="position:fixed;inset:0;background:rgba(0,0,0,0.65);display:none;justify-content:center;align-items:center;z-index:10003;">
      <div style="background:white;width:90%;max-width:640px;border-radius:12px;padding:20px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.3);">
        <!-- Шапка галереи -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-shrink:0;">
          <h3 id="galleryTitle" style="margin:0;font-size:15px;color:#1e3a5f;"></h3>
          <button id="galleryCloseBtn" style="background:none;border:none;font-size:26px;cursor:pointer;color:#666;line-height:1;">&times;</button>
        </div>
        <!-- Контент галереи -->
        <div id="galleryContent" style="flex:1;overflow-y:auto;min-height:80px;"></div>
        <!-- Кнопки добавления -->
        <div style="display:flex;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid #eee;flex-shrink:0;">
          <label style="padding:7px 14px;background:#28a745;color:white;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">
            + Фото
            <input id="galleryPhotoInput" type="file" accept="image/*" multiple style="display:none;" />
          </label>
          <label style="padding:7px 14px;background:#17a2b8;color:white;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">
            + Видео
            <input id="galleryVideoInput" type="file" accept="video/*" multiple style="display:none;" />
          </label>
          <span style="font-size:11px;color:#888;align-self:center;">Можно выбрать несколько файлов</span>
        </div>
      </div>
    </div>

    <!-- ═══ Слайдер медиафайлов ═══ -->
    <div id="mediaSlideshowModal" style="position:fixed;inset:0;background:rgba(0,0,0,0.92);display:none;
      flex-direction:column;align-items:center;justify-content:center;z-index:10004;">

      <!-- Шапка слайдера -->
      <div style="width:100%;max-width:900px;display:flex;justify-content:space-between;
        align-items:center;padding:8px 16px;flex-shrink:0;">
        <span id="slideCounter" style="color:#aaa;font-size:13px;"></span>
        <button id="slideshowCloseBtn" style="background:none;border:none;color:white;
          font-size:32px;cursor:pointer;line-height:1;padding:0 8px;">&times;</button>
      </div>

      <!-- Основная область: стрелки + контент -->
      <div style="display:flex;align-items:center;justify-content:center;flex:1;width:100%;
        max-width:900px;gap:8px;min-height:0;padding:0 8px;">

        <!-- Стрелка влево -->
        <button id="slidePrev" style="flex-shrink:0;background:rgba(255,255,255,0.1);border:none;
          color:white;font-size:32px;width:48px;height:80px;border-radius:8px;cursor:pointer;
          transition:0.2s;display:flex;align-items:center;justify-content:center;">&#8249;</button>

        <!-- Контент (фото / видео) -->
        <div id="slideContent" style="flex:1;min-width:0;max-height:60vh;display:flex;
          align-items:center;justify-content:center;overflow:hidden;"></div>

        <!-- Стрелка вправо -->
        <button id="slideNext" style="flex-shrink:0;background:rgba(255,255,255,0.1);border:none;
          color:white;font-size:32px;width:48px;height:80px;border-radius:8px;cursor:pointer;
          transition:0.2s;display:flex;align-items:center;justify-content:center;">&#8250;</button>
      </div>

      <!-- Точки-индикаторы -->
      <div id="slideDots" style="padding:10px 0;flex-shrink:0;"></div>

      <!-- Описание -->
      <div style="width:100%;max-width:900px;padding:8px 16px 16px;flex-shrink:0;">
        <div style="background:rgba(255,255,255,0.07);border-radius:8px;padding:10px 12px;">
          <div style="font-size:11px;color:#888;margin-bottom:6px;">Описание объекта:</div>
          <div style="display:flex;gap:8px;align-items:flex-start;">
            <textarea id="slideDescInput" rows="2" placeholder="Введите описание объекта..."
              style="flex:1;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);
              border-radius:6px;color:white;padding:6px 8px;font-size:13px;resize:none;
              font-family:system-ui,sans-serif;"></textarea>
            <button id="slideDescSaveBtn" style="padding:6px 14px;background:#2c7da0;color:white;
              border:none;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;
              align-self:flex-end;">💾 Сохранить</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  `;

  popupElement.style.display = 'none';
  document.body.appendChild(popupElement);

  if (typeof _renderOnlineIndicator === 'function') _renderOnlineIndicator();
  if (typeof updateRoleTag === 'function') updateRoleTag();

  // ── Превью файлов в модале добавления ──────────────────────────────────────
  popupElement.querySelector('#targetPhoto').addEventListener('change', function() {
    const preview = popupElement.querySelector('#targetPhotoPreview');
    const nameEl  = popupElement.querySelector('#targetPhotoName');
    if (this.files?.length) {
      nameEl.textContent = Array.from(this.files).map(f => f.name).join(', ');
      preview.style.display = 'block';
    } else preview.style.display = 'none';
  });

  popupElement.querySelector('#targetVideo').addEventListener('change', function() {
    const preview = popupElement.querySelector('#targetVideoPreview');
    const nameEl  = popupElement.querySelector('#targetVideoName');
    if (this.files?.length) {
      nameEl.textContent = Array.from(this.files).map(f => f.name).join(', ');
      preview.style.display = 'block';
    } else preview.style.display = 'none';
  });

  // ── Открыть модал добавления ────────────────────────────────────────────────
  popupElement.querySelector('#addTargetBtn').addEventListener('click', () => {
    popupElement.querySelector('#impactDate').value = getMoscowDateStr();
    popupElement.querySelector('#impactTime').value = getMoscowTimeStr();
    document.querySelector('#addTargetModal').style.display = 'flex';
  });

  popupElement.querySelector('#cancelAddTarget').onclick = () => {
    _resetAddTargetModal();
    document.querySelector('#addTargetModal').style.display = 'none';
  };

  // ── Submit: добавление цели ─────────────────────────────────────────────────
  const submitBtn = popupElement.querySelector('#submitAddTarget');
  submitBtn.addEventListener('click', withLock(submitBtn, async () => {
    try {
      const characteristic = popupElement.querySelector('#targetType').value;
      const coordX         = popupElement.querySelector('#coordX').value.trim();
      const coordY         = popupElement.querySelector('#coordY').value.trim();
      const address        = popupElement.querySelector('#targetAddress').value.trim();
      const photoFiles     = popupElement.querySelector('#targetPhoto').files;
      const videoFiles     = popupElement.querySelector('#targetVideo').files;
      const impactTime     = popupElement.querySelector('#impactTime').value;
      const impactDate     = popupElement.querySelector('#impactDate').value;
      const result         = popupElement.querySelector('#impactResult').value;

      if (!characteristic) { showToast('❌ Выберите категорию цели', 'error'); return; }
      if (!coordX || !coordY) { showToast('❌ Введите координаты X и Y', 'error'); return; }

      const rowData = { targetNumber: '0', characteristic, coordX, coordY, impactTime, result, defeatDate: impactDate };

      const _today      = getMoscowDateStr();
      const _tree       = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
      const _targetDate = activeFolderDate || _today;
      const _entry      = (_tree?.dates || []).find(d => d.date === _targetDate);
      const _folderId   = _entry?.folderId || latestFolderId;

      // Шаг 1: создать объект в AstraMap (без медиа)
      let astraResult = null;
      try {
        astraResult = await apiSendTarget(rowData, _folderId, []);
      } catch (err) {
        showToast('❌ Ошибка создания в AstraMap: ' + err.message, 'error');
        return;
      }

      const newEntityId = astraResult?.id || astraResult?.entity?.id || astraResult?.entityID || null;
      if (!newEntityId) console.warn('[addTarget] entity_id не найден:', astraResult);

      // Шаг 2: перезагрузить таблицу
      await loadByDateFromPanel(_targetDate);

      // Шаг 3: локальные поля (после SYNC_TARGETS)
      if (newEntityId) {
        await new Promise(r => setTimeout(r, 700));

        if (address) wsSend({ type: 'UPDATE_TARGET_LOCAL', entity_id: String(newEntityId), address });

        // Загружаем фото (несколько)
        let hasPhoto = 0, hasVideo = 0;
        for (const file of Array.from(photoFiles)) {
          const ok = await uploadMediaFile(newEntityId, file, 'photo');
          if (ok) hasPhoto = 1;
        }
        // Загружаем видео (несколько)
        for (const file of Array.from(videoFiles)) {
          const ok = await uploadMediaFile(newEntityId, file, 'video');
          if (ok) hasVideo = 1;
        }
        if (hasPhoto || hasVideo) {
          wsSend({ type: 'UPDATE_TARGET_LOCAL', entity_id: String(newEntityId), has_photo: hasPhoto, has_video: hasVideo });
        }
      }

      _resetAddTargetModal();
      document.querySelector('#addTargetModal').style.display = 'none';
      showToast('✅ Цель добавлена', 'success');

    } catch (e) {
      console.error('[addTarget]', e);
      showToast('❌ Ошибка: ' + e.message, 'error');
    }
  }, { label: '⏳ Добавляем...' }));

  // ── Галерея: закрыть ────────────────────────────────────────────────────────
  popupElement.querySelector('#galleryCloseBtn').addEventListener('click', () => {
    document.querySelector('#mediaGalleryModal').style.display = 'none';
  });

  // ── Галерея: загрузка фото ──────────────────────────────────────────────────
  popupElement.querySelector('#galleryPhotoInput').addEventListener('change', async function() {
    if (this.files?.length) await _galleryUploadFiles(this.files, 'photo');
    this.value = '';
  });

  // ── Галерея: загрузка видео ─────────────────────────────────────────────────
  popupElement.querySelector('#galleryVideoInput').addEventListener('change', async function() {
    if (this.files?.length) await _galleryUploadFiles(this.files, 'video');
    this.value = '';
  });

  popupElement.querySelector('#closePopupBtn').addEventListener('click', () => {
    popupElement.style.display = 'none';
  });

  const pubBtn = popupElement.querySelector('#publishPlanBtn');
  pubBtn.addEventListener('click', withLock(pubBtn, async () => {
    const planDate = pubBtn.getAttribute('data-plan-date');
    if (!planDate) { showToast('Дата плана не определена', 'error'); return; }
    if (!confirm(`Опубликовать план на ${planDate.slice(8)}.${planDate.slice(5,7)}?`)) return;
    await publishPlan(planDate);
  }, { label: '⏳ Публикуем...' }));

  const tableWrapper  = popupElement.querySelector('.table-wrapper');
  const tasksPanel    = popupElement.querySelector('#tasksPanel');
  const planningPanel = popupElement.querySelector('#planningPanel');

  popupElement.querySelector('#showPlanningBtn').addEventListener('click', () => {
    const isOpen = planningPanel?.style.display !== 'none';
    if (tableWrapper)  tableWrapper.style.display  = 'none';
    if (tasksPanel)    tasksPanel.style.display     = 'none';
    if (planningPanel) planningPanel.style.display  = 'none';
    popupElement.querySelector('#showTasksBtn').textContent    = '📋 Задачи';
    popupElement.querySelector('#showPlanningBtn').textContent = '📅 Спланировано';
    if (!isOpen) {
      if (planningPanel) { planningPanel.style.display = 'flex'; planningPanel.style.flexDirection = 'column'; }
      popupElement.querySelector('#showPlanningBtn').textContent = '🗺️ Цели';
      loadPlanningTargets();
    } else {
      if (tableWrapper) tableWrapper.style.display = '';
    }
  });

  popupElement.querySelector('#showTasksBtn').addEventListener('click', () => {
    const isTasksVisible = tasksPanel.style.display !== 'none';
    if (isTasksVisible) {
      tasksPanel.style.display   = 'none';
      tableWrapper.style.display = '';
      popupElement.querySelector('#showTasksBtn').textContent = '📋 Задачи';
    } else {
      tasksPanel.style.display       = 'flex';
      tasksPanel.style.flexDirection = 'column';
      tableWrapper.style.display     = 'none';
      popupElement.querySelector('#showTasksBtn').textContent = '🗺️ Цели';
      unreadTaskCount = 0;
      updateTaskBadge();
    }
  });

  // ── Модал новой задачи ───────────────────────────────────────────────────────
  const newTaskModal = popupElement.querySelector('#newTaskModal');

  popupElement.querySelector('#newTaskBtn').addEventListener('click', () => {
    if (!myRole) { showToast('Сначала выберите расчёт', 'error'); return; }
    const targetSelect = newTaskModal.querySelector('#taskTargetSelect');
    targetSelect.innerHTML = '<option value="">— без привязки к цели —</option>';
    document.querySelectorAll('#statusTable tbody tr').forEach(row => {
      const id = row.cells[1]?.innerText.trim();
      const title = row.querySelector('.char-cell select')?.value || '';
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = `#${id} ${title}`;
      targetSelect.appendChild(opt);
    });
    const officeSelect = newTaskModal.querySelector('#taskOfficeSelect');
    if (officeSelect) {
      officeSelect.innerHTML = '';
      const myOfficeId = store.get('myOfficeId') || 'HQ';
      Object.entries(OFFICES).forEach(([id, office]) => {
        if (!canAssignTask(myOfficeId, id)) return;
        const opt = document.createElement('option');
        opt.value = id; opt.textContent = office.name + (id === myOfficeId ? ' (своё)' : '');
        officeSelect.appendChild(opt);
      });
      officeSelect.onchange = () => _fillRolesForOffice(officeSelect.value);
      if (officeSelect.options.length > 0) _fillRolesForOffice(officeSelect.value);
    }
    newTaskModal.style.display = 'flex';
  });

  popupElement.querySelector('#cancelNewTask').addEventListener('click', () => {
    newTaskModal.style.display = 'none';
  });

  popupElement.querySelector('#submitNewTask').addEventListener('click', () => {
    const to        = newTaskModal.querySelector('#taskTo').value;
    const text      = newTaskModal.querySelector('#taskText').value.trim();
    const targetSel = newTaskModal.querySelector('#taskTargetSelect');
    const targetId  = targetSel.value;
    const targetTitle  = targetId ? targetSel.options[targetSel.selectedIndex].text : '';
    const toOfficeId   = newTaskModal.querySelector('#taskOfficeSelect')?.value || store.get('myOfficeId') || 'HQ';
    const myOfficeId   = store.get('myOfficeId') || 'HQ';
    if (!to)   { showToast('Укажите адресата', 'error'); return; }
    if (!text) { showToast('Введите текст задачи', 'error'); return; }
    if (!myRole) { showToast('Сначала выберите расчёт', 'error'); return; }
    if (!canAssignTask(myOfficeId, toOfficeId)) { showToast('Нет прав', 'error'); return; }
    wsSend({ type: 'NEW_TASK', to, text, targetId, targetTitle, toOfficeId, fromOfficeId: myOfficeId });
    newTaskModal.style.display = 'none';
    newTaskModal.querySelector('#taskTo').value = '';
    newTaskModal.querySelector('#taskText').value = '';
    newTaskModal.querySelector('#taskTargetSelect').value = '';
  });

  popupElement.querySelector('#exportTableData').addEventListener('click', () => {
    showToast('Экспорт в Excel – в разработке', 'info');
  });

  const refreshBtn = popupElement.querySelector('#refreshDatesBtn');
  refreshBtn.addEventListener('click', withLock(refreshBtn, async () => {
    cacheClearAll();
    await renderDatePanel(true);
  }, { label: '⏳' }));

  const todayBtn = popupElement.querySelector('#loadTodayMap');
  todayBtn.addEventListener('click', withLock(todayBtn, async () => {
    await loadByDateFromPanel(getMoscowDateStr());
  }, { label: '⏳' }));


  // ── Слайдер: навигация ────────────────────────────────────────────────────
  const ssModal = popupElement.querySelector('#mediaSlideshowModal');

  popupElement.querySelector('#slideshowCloseBtn').addEventListener('click', () => {
    ssModal.style.display = 'none';
    if (_slideBlobUrl) { URL.revokeObjectURL(_slideBlobUrl); _slideBlobUrl = null; }
  });

  popupElement.querySelector('#slidePrev').addEventListener('click', async () => {
    if (_slideIndex > 0) { _slideIndex--; await _renderSlide(); }
  });

  popupElement.querySelector('#slideNext').addEventListener('click', async () => {
    if (_slideIndex < _slideMedia.length - 1) { _slideIndex++; await _renderSlide(); }
  });

  // Сохранить описание
  popupElement.querySelector('#slideDescSaveBtn').addEventListener('click', async () => {
    const notes = popupElement.querySelector('#slideDescInput').value.trim();
    _slideNotes = notes;
    wsSend({ type: 'UPDATE_TARGET_LOCAL', entity_id: _slideEntityId, notes });
    showToast('✅ Описание сохранено', 'success');
  });

  // Закрыть по клику на фон
  ssModal.addEventListener('click', (e) => {
    if (e.target === ssModal) {
      ssModal.style.display = 'none';
      if (_slideBlobUrl) { URL.revokeObjectURL(_slideBlobUrl); _slideBlobUrl = null; }
    }
  });

  return popupElement;
}

function _resetAddTargetModal() {
  const p = popupElement;
  if (!p) return;
  p.querySelector('#targetTitle').value = '';
  p.querySelector('#targetType').value = '';
  p.querySelector('#targetAddress').value = '';
  p.querySelector('#coordX').value = '';
  p.querySelector('#coordY').value = '';
  p.querySelector('#impactTime').value = '';
  p.querySelector('#impactDate').value = '';
  p.querySelector('#impactResult').selectedIndex = 0;
  p.querySelector('#targetPhoto').value = '';
  p.querySelector('#targetVideo').value = '';
  p.querySelector('#targetPhotoPreview').style.display = 'none';
  p.querySelector('#targetVideoPreview').style.display = 'none';
}

function closeBtn() {
  const btn = document.querySelector('#closePopupBtn');
  if (btn && !btn.hasListener) {
    btn.addEventListener('click', () => {
      const popup = document.querySelector('#extension-popup');
      if (popup) popup.style.display = 'none';
    });
    btn.hasListener = true;
    return true;
  }
  return false;
}

function findAndAddButton() {
  const target = document.querySelector('.mapToolsControl__X3RqH');
  if (!target) return false;
  if (target.querySelector('#extension-trigger-btn')) return true;

  const btn = document.createElement('button');
  btn.id = 'extension-trigger-btn';
  btn.textContent = '📋 Формуляр цели';
  btn.style.cssText = 'padding:6px 12px;background:#28a745;color:white;border:none;border-radius:4px;cursor:pointer;margin:4px;';

  const popup = createPopup();
  btn.onclick = (e) => {
    e.stopPropagation();
    const isOpening = popup.style.display === 'none';
    popup.style.display = isOpening ? 'flex' : 'none';
    if (isOpening) {
      renderDatePanel().then(() => {
        initBadgesFromCache();
        loadAllDatesBadgesInBackground();
        restoreDraftDateBtns();
      });
      updateRoleTag();
      if (typeof _renderOnlineIndicator === 'function') _renderOnlineIndicator();
    }
  };
  target.appendChild(btn);
  return true;
}

function updateAddTargetBtn() {
  const btn = document.querySelector('#addTargetBtn');
  if (!btn) return;
  const today    = getMoscowDateStr();
  const tomorrow = new Date(Date.now() + 3*3600000 + 86400000).toISOString().slice(0,10);
  const noDate   = !activeFolderDate;
  const isToday  = activeFolderDate === today;
  const isTomorrow = activeFolderDate === tomorrow;
  if (noDate || isToday || isTomorrow) {
    btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer';
    btn.title = isTomorrow ? '📅 Добавление в папку завтра' : '';
  } else {
    btn.disabled = true; btn.style.opacity = '0.4'; btn.style.cursor = 'not-allowed';
    btn.title = `Только просмотр (доступно: сегодня ${today}, завтра ${tomorrow})`;
  }
}