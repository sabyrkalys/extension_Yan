// content/ui/panel.js
// Сборка главной панели расширения, кнопка на карте, инициализация UI.
// Зависимости: store.js, wsClient.js, ui/tasks.js, ui/planning.js, ui/toast.js, utils/date.js

// ── Загрузка медиафайла на сервер ─────────────────────────────────────────────
async function uploadMediaFile(entityId, file, mediaType) {
  const SERVER_HTTP = 'http://186.246.2.6:5001';
  const formData = new FormData();
  formData.append('entity_id', String(entityId));
  formData.append('type', mediaType);      // 'photo' или 'video'
  formData.append('file', file, file.name);

  const label = mediaType === 'photo' ? 'Фото' : 'Видео';
  try {
    const res = await fetch(`${SERVER_HTTP}/media/upload`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Ошибка сервера');
    showToast(`✅ ${label} загружено`, 'success');
    return true;
  } catch (err) {
    console.error(`[media] Ошибка загрузки ${mediaType}:`, err);
    showToast(`❌ Ошибка загрузки ${label}: ${err.message}`, 'error');
    return false;
  }
}

function createPopup() {
  if (popupElement) return popupElement;

  popupElement = document.createElement('div');
  popupElement.id = 'extension-popup';
  popupElement.innerHTML = `
  <div style="
    position: fixed;
    top: 25px;
    right: 20px;
    width: 70%;
    max-height: calc(100vh - 40px);
    background: white;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.25);
    z-index: 10;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: system-ui, sans-serif;
  ">
    <style>
      #statusTable { width: 100%; min-width:1000px; border-collapse: collapse; font-size: 12px; }
      #statusTable th, #statusTable td { padding: 10px 8px; border: 1px solid #d0d7de; text-align: center; vertical-align: middle; }
      #statusTable th:nth-child(2), #statusTable td:nth-child(2) { width: 110px; min-width: 85px; max-width: 180px; }
      .editable { background: #fff9e6; min-height: 44px; }
      select, button { font-size: 12px; min-height: 44px; padding: 8px 12px; touch-action: manipulation; border-radius: 8px; }
      .table-wrapper { overflow-y: auto; -webkit-overflow-scrolling: touch; }
      .table-wrapper::-webkit-scrollbar,
      #tasksPanel::-webkit-scrollbar,
      #planningPanel::-webkit-scrollbar { width: 8px; height: 8px; }
      .table-wrapper::-webkit-scrollbar-track,
      #tasksPanel::-webkit-scrollbar-track,
      #planningPanel::-webkit-scrollbar-track { background: #e9ecef; border-radius: 4px; }
      .table-wrapper::-webkit-scrollbar-thumb,
      #tasksPanel::-webkit-scrollbar-thumb,
      #planningPanel::-webkit-scrollbar-thumb { background: #2c7da0; border-radius: 4px; }
      .table-wrapper::-webkit-scrollbar-thumb:hover,
      #tasksPanel::-webkit-scrollbar-thumb:hover,
      #planningPanel::-webkit-scrollbar-thumb:hover { background: #1e3a5f; }
      #statusTable thead th { background: #fff; }
      .eye-icon { font-size: 15px; padding: 5px 10px; background: #2c7da0; color: white; border: none; border-radius: 4px; cursor: pointer; }
      @media (max-width: 800px) { #statusTable { font-size: 12px; } #statusTable th, #statusTable td { padding: 8px 6px; } button { padding: 10px 14px; } }
      @media (max-width: 600px) { #statusTable { min-width: 600px; font-size: 12px; } }
      .button-panel { display: flex; justify-content: flex-end; gap: 12px; flex-wrap: wrap; padding: 12px 16px; background: #e9ecef; border-top: 1px solid #ced4da; flex-shrink: 0; }
      #addTargetModal input[type="text"],
      #addTargetModal input[type="number"],
      #addTargetModal input[type="time"],
      #addTargetModal input[type="date"],
      #addTargetModal select {
        width: 100%; padding: 8px 10px; border: 1px solid #ccc;
        border-radius: 6px; font-size: 13px; box-sizing: border-box; min-height: unset;
      }
      #addTargetModal label { font-size: 12px; color: #555; display: block; margin-bottom: 4px; }
      .file-input-wrap {
        border: 1px dashed #ccc; border-radius: 6px; padding: 8px 10px;
        background: #fafafa; cursor: pointer;
      }
      .file-input-wrap input[type="file"] { width: 100%; font-size: 12px; cursor: pointer; }
      .file-preview { margin-top: 6px; font-size: 11px; color: #28a745; display: none; }
    </style>

    <div style="padding: 5px 14px; background: #1e3a5f; color: white; display: flex; flex-direction: column; flex-shrink: 0;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <h3 style="margin: 0; font-size: 16px;">📋 Таблица учёта целей</h3>
          <button id="addTargetBtn" style="background:#28a745; color:white; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:14px;">+ Добавить цель</button>
          <div style="position:relative; display:inline-block;">
            <button id="showTasksBtn" style="background:#fd7e14; color:white; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:14px;">📋 Задачи</button>
            <span id="task-badge" style="display:none; position:absolute; top:-6px; right:-6px; background:#dc3545; color:white; border-radius:50%; width:18px; height:18px; font-size:11px; align-items:center; justify-content:center; font-weight:600;"></span>
          </div>
          <button id="showPlanningBtn" style="background:#6f42c1; color:white; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:14px;">📅 Спланировано</button>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span id="myRoleTag" style="font-size:12px;background:#2c5282;padding:4px 10px;border-radius:6px;white-space:nowrap;">
            🔄 Определяю расчёт...
          </span>
          <button id="closePopupBtn" style="background: none; border: none; color: white; font-size: 28px; padding: 2px 12px; cursor: pointer;">&times;</button>
        </div>
      </div>
      <div id="online-indicator" style="padding: 4px 6px; font-size: 11px; opacity: 0.9; min-height: 18px; display:flex; flex-wrap:wrap; align-items:center; gap:4px;"></div>
    </div>

    <div id="dates-panel" style="
      background: #162d4a; padding: 6px 14px; display: flex; align-items: center;
      gap: 6px; flex-wrap: wrap; flex-shrink: 0; border-bottom: 1px solid #0d1f33; min-height: 36px;
    ">
      <span style="font-size:11px;color:#7aa3c8;margin-right:4px;">📅 Даты:</span>
      <div id="dates-list" style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;">
        <span style="font-size:11px;color:#5a7fa0;">загрузка...</span>
      </div>
      <div style="margin-left:auto;display:flex;gap:6px;align-items:center;">
        <button id="publishPlanBtn" title="Опубликовать план в AstraMap" style="
          display:none; background:#28a745; border:none; color:white;
          border-radius:4px; padding:3px 10px; cursor:pointer; font-size:11px;">📤 Опубликовать план</button>
        <button id="refreshDatesBtn" title="Обновить список дат" style="
          background:none; border:1px solid #4a7a9b; color:#7aa3c8;
          border-radius:4px; padding:2px 8px; cursor:pointer; font-size:11px;">🔄</button>
      </div>
    </div>

    <div class="table-wrapper" style="flex: 1; overflow-y: auto; padding: 12px; background: #f5f7fa; color: black;">
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

    <div id="tasksPanel" style="display:none; flex:1; overflow-y:auto; padding:12px; background:#f5f7fa; color:black;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
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

    <div id="planningPanel" style="
      display:none; flex-direction:column; flex:1;
      overflow:hidden; background:#f5f7fa; color:black;
    "></div>

    <div id="newTaskModal" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);display:none;justify-content:center;align-items:center;z-index:10001;">
      <div style="background:white;width:90%;max-width:420px;border-radius:10px;padding:20px;display:flex;flex-direction:column;gap:10px;">
        <h3 style="margin:0;font-size:16px;">Новая задача</h3>
        <label style="font-size:12px;color:#555;">Подразделение получателя:</label>
        <select id="taskOfficeSelect" style="padding:6px;border-radius:5px;border:1px solid #ccc;">
          <option value="">— выберите подразделение —</option>
        </select>
        <label style="font-size:12px;color:#555;">Кому:</label>
        <select id="taskTo" style="padding:6px;border-radius:5px;border:1px solid #ccc;">
          <option value="">— сначала выберите подразделение —</option>
        </select>
        <label style="font-size:12px;color:#555;">Объект (необязательно):</label>
        <select id="taskTargetSelect" style="padding:6px;border-radius:5px;border:1px solid #ccc;">
          <option value="">— без привязки к цели —</option>
        </select>
        <label style="font-size:12px;color:#555;">Текст задачи:</label>
        <textarea id="taskText" rows="3" placeholder="Например: Доразведать объект, уточнить координаты"
          style="padding:6px;border-radius:5px;border:1px solid #ccc;resize:vertical;font-size:13px;"></textarea>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="cancelNewTask" style="padding:6px 14px;border-radius:5px;border:1px solid #ccc;cursor:pointer;">Отмена</button>
          <button id="submitNewTask" style="padding:6px 14px;background:#fd7e14;color:white;border:none;border-radius:5px;cursor:pointer;font-weight:600;">Поставить задачу</button>
        </div>
      </div>
    </div>

    <div class="button-panel">
      <button id="exportTableData" style="background:#007bff;color:white;">📎 Экспорт Excel</button>
      <button id="loadTodayMap" style="background:#17a2b8;color:white;">📥 Сегодня</button>
    </div>

    <!-- ════════════════════════════════════════════════════════════════
         Модал добавления цели — с адресом, фото, видео
         ════════════════════════════════════════════════════════════════ -->
    <div id="addTargetModal" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);display:none;justify-content:center;align-items:center;z-index:10000;">
      <div style="background:white;width:90%;max-width:520px;border-radius:10px;padding:20px;
                  display:flex;flex-direction:column;gap:10px;max-height:90vh;overflow-y:auto;">
        <h3 style="margin:0;font-size:16px;">Добавление цели</h3>

        <label>Название цели (необязательно):</label>
        <input id="targetTitle" type="text" placeholder="Краткое название" />

        <label>Категория цели:</label>
        <select id="targetType">
          <option value="" selected disabled>— Выберите категорию —</option>
          <option value="ПУ">ПУ</option>
          <option value="ПУ БПЛА">ПУ БПЛА</option>
          <option value="Точка влета">Точка взлёта</option>
          <option value="РЛС">РЛС</option>
          <option value="РЭБ">РЭБ</option>
          <option value="Связь">Связь</option>
          <option value="ЗРК">ЗРК</option>
          <option value="ПЗРК">ПЗРК</option>
          <option value="Танк">Танк</option>
          <option value="БМП">БМП</option>
          <option value="ББМ">ББМ</option>
          <option value="БТР">БТР</option>
          <option value="Гаубица">Гаубица</option>
          <option value="САУ">САУ</option>
          <option value="РСЗО">РСЗО</option>
          <option value="Миномёт">Миномёт</option>
          <option value="Склад">Склад</option>
          <option value="КНП">КНП</option>
          <option value="Укрытие">Укрытие</option>
          <option value="Блиндаж">Блиндаж</option>
          <option value="Личный состав">Личный состав</option>
        </select>

        <!-- ── Адрес ────────────────────────────────────────────────── -->
        <label>Адрес / местность объекта:</label>
        <input id="targetAddress" type="text"
          placeholder="н-р: лесной массив, 500м с. н.п. Петровка" />

        <!-- ── Координаты ───────────────────────────────────────────── -->
        <div style="display:flex;gap:10px;">
          <div style="flex:1;">
            <label>Координата X (СК-42):</label>
            <input id="coordX" type="number" placeholder="Координата X" />
          </div>
          <div style="flex:1;">
            <label>Координата Y (СК-42):</label>
            <input id="coordY" type="number" placeholder="Координата Y" />
          </div>
        </div>

        <!-- ── Дата / время ────────────────────────────────────────── -->
        <div style="display:flex;gap:10px;">
          <div style="flex:1;">
            <label>Дата обнаружения:</label>
            <input id="impactDate" type="date" />
          </div>
          <div style="flex:1;">
            <label>Время обнаружения:</label>
            <input id="impactTime" type="time" />
          </div>
        </div>

        <!-- ── Результат ───────────────────────────────────────────── -->
        <label>Результат:</label>
        <select id="impactResult">
          <option value="вскрыто" selected>Вскрыто</option>
          <option value="поражена">Поражена</option>
          <option value="не_поражена">Не поражена</option>
          <option value="передано_на_доразведку">Передано на доразведку</option>
          <option value="подтверждено">Подтверждено</option>
          <option value="подавлено">Подавлено</option>
        </select>

        <!-- ── Фото ────────────────────────────────────────────────── -->
        <label>📷 Фото объекта (необязательно):</label>
        <div class="file-input-wrap">
          <input id="targetPhoto" type="file"
            accept="image/jpeg,image/png,image/webp,image/*" />
          <div id="targetPhotoPreview" class="file-preview">
            ✅ Выбран: <span id="targetPhotoName"></span>
          </div>
        </div>

        <!-- ── Видео ───────────────────────────────────────────────── -->
        <label>🎥 Видео объекта (необязательно):</label>
        <div class="file-input-wrap">
          <input id="targetVideo" type="file"
            accept="video/mp4,video/quicktime,video/x-msvideo,video/webm,video/*" />
          <div id="targetVideoPreview" class="file-preview">
            ✅ Выбран: <span id="targetVideoName"></span>
          </div>
        </div>

        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px;">
          <button id="cancelAddTarget"
            style="padding:7px 16px;border:1px solid #ccc;border-radius:6px;cursor:pointer;background:white;">
            Отмена
          </button>
          <button id="submitAddTarget"
            style="padding:7px 16px;background:#28a745;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;">
            💾 Добавить
          </button>
        </div>
      </div>
    </div>
  </div>
  `;

  popupElement.style.display = 'none';
  document.body.appendChild(popupElement);

  if (typeof _renderOnlineIndicator === 'function') _renderOnlineIndicator();
  if (typeof updateRoleTag === 'function') updateRoleTag();

  const modal = popupElement.querySelector('#addTargetModal');

  // ── Превью выбранных файлов ──────────────────────────────────────────────
  popupElement.querySelector('#targetPhoto').addEventListener('change', function() {
    const preview = popupElement.querySelector('#targetPhotoPreview');
    const nameEl  = popupElement.querySelector('#targetPhotoName');
    if (this.files[0]) {
      nameEl.textContent     = this.files[0].name;
      preview.style.display  = 'block';
    } else {
      preview.style.display  = 'none';
    }
  });

  popupElement.querySelector('#targetVideo').addEventListener('change', function() {
    const preview = popupElement.querySelector('#targetVideoPreview');
    const nameEl  = popupElement.querySelector('#targetVideoName');
    if (this.files[0]) {
      nameEl.textContent     = this.files[0].name;
      preview.style.display  = 'block';
    } else {
      preview.style.display  = 'none';
    }
  });

  // ── Открыть модал ────────────────────────────────────────────────────────
  popupElement.querySelector('#addTargetBtn').addEventListener('click', function () {
    popupElement.querySelector('#impactDate').value = getMoscowDateStr();
    popupElement.querySelector('#impactTime').value = getMoscowTimeStr();
    modal.style.display = 'flex';
  });

  // ── Отмена ───────────────────────────────────────────────────────────────
  popupElement.querySelector('#cancelAddTarget').onclick = () => {
    _resetAddTargetModal();
    modal.style.display = 'none';
  };

  // ── Отправка ─────────────────────────────────────────────────────────────
  const submitBtn = popupElement.querySelector('#submitAddTarget');
  submitBtn.addEventListener('click', withLock(submitBtn, async () => {
    try {
      const characteristic = popupElement.querySelector('#targetType').value;
      const coordX         = popupElement.querySelector('#coordX').value.trim();
      const coordY         = popupElement.querySelector('#coordY').value.trim();
      const address        = popupElement.querySelector('#targetAddress').value.trim();
      const photoFile      = popupElement.querySelector('#targetPhoto').files[0] || null;
      const videoFile      = popupElement.querySelector('#targetVideo').files[0] || null;
      const impactTime     = popupElement.querySelector('#impactTime').value;
      const impactDate     = popupElement.querySelector('#impactDate').value;
      const result         = popupElement.querySelector('#impactResult').value;

      // ── Валидация ─────────────────────────────────────────────────────
      if (!characteristic) {
        showToast('❌ Выберите категорию цели', 'error'); return;
      }
      if (!coordX || !coordY) {
        showToast('❌ Введите координаты X и Y', 'error'); return;
      }

      const rowData = {
        targetNumber:   '0',
        characteristic,
        coordX,
        coordY,
        impactTime,
        result,
        defeatDate: impactDate,
      };

      // ── Целевая папка ──────────────────────────────────────────────────
      const _today         = getMoscowDateStr();
      const _tree          = JSON.parse(localStorage.getItem(CACHE_KEY_DATES) || 'null');
      const _dates         = _tree?.dates || [];
      const _targetDate    = activeFolderDate || _today;
      const _targetEntry   = _dates.find(d => d.date === _targetDate);
      const _targetFolderId = _targetEntry?.folderId || latestFolderId;

      // ── Шаг 1: создать объект в AstraMap ──────────────────────────────
      let astraResult = null;
      try {
        astraResult = await apiSendTarget(rowData, _targetFolderId);
      } catch (err) {
        showToast('❌ Ошибка создания в AstraMap: ' + err.message, 'error');
        return;
      }

      // Извлекаем entity_id из ответа AstraMap
      // Возможные форматы: { id }, { entity: { id } }, { entityID }
      const newEntityId = astraResult?.id
                       || astraResult?.entity?.id
                       || astraResult?.entityID
                       || null;

      if (!newEntityId) {
        console.warn('[addTarget] Не удалось получить entity_id из ответа:', astraResult);
      }

      // ── Шаг 2: перезагрузить таблицу ──────────────────────────────────
      // loadByDateFromPanel → loadTargetsFromFolder → SYNC_TARGETS (вставляет строку в SQLite)
      await loadByDateFromPanel(_targetDate);

      // ── Шаг 3: сохранить локальные поля через WS ──────────────────────
      // Ждём 700 мс чтобы SYNC_TARGETS обработался и строка появилась в SQLite
      if (newEntityId && (address || photoFile || videoFile)) {
        await new Promise(r => setTimeout(r, 700));

        // Адрес → UPDATE_TARGET_LOCAL → server broadcasts TARGET_UPDATED
        if (address) {
          wsSend({
            type:      'UPDATE_TARGET_LOCAL',
            entity_id: String(newEntityId),
            address,
          });
        }

        // Фото → POST /media/upload (сервер сам ставит has_photo=1 в SQLite)
        if (photoFile) {
          await uploadMediaFile(newEntityId, photoFile, 'photo');
        }

        // Видео → POST /media/upload (сервер сам ставит has_video=1 в SQLite)
        if (videoFile) {
          await uploadMediaFile(newEntityId, videoFile, 'video');
        }
      }

      _resetAddTargetModal();
      modal.style.display = 'none';
      showToast('✅ Цель добавлена', 'success');

    } catch (e) {
      console.error('[addTarget]', e);
      showToast('❌ Ошибка: ' + e.message, 'error');
    }
  }, { label: '⏳ Добавляем...' }));

  popupElement.querySelector('#closePopupBtn').addEventListener('click', () => {
    popupElement.style.display = 'none';
  });

  const pubBtn = popupElement.querySelector('#publishPlanBtn');
  pubBtn.addEventListener('click', withLock(pubBtn, async () => {
    const planDate = pubBtn.getAttribute('data-plan-date');
    if (!planDate) { showToast('Дата плана не определена', 'error'); return; }
    if (!confirm(`Опубликовать план на ${planDate.slice(8)}.${planDate.slice(5,7)} в AstraMap?`)) return;
    await publishPlan(planDate);
  }, { label: '⏳ Публикуем...' }));

  const tableWrapper  = popupElement.querySelector('.table-wrapper');
  const tasksPanel    = popupElement.querySelector('#tasksPanel');
  const planningPanel = popupElement.querySelector('#planningPanel');

  popupElement.querySelector('#showPlanningBtn').addEventListener('click', () => {
    const isOpen = planningPanel && planningPanel.style.display !== 'none';
    if (tableWrapper)  tableWrapper.style.display  = 'none';
    if (tasksPanel)    tasksPanel.style.display     = 'none';
    if (planningPanel) planningPanel.style.display  = 'none';
    popupElement.querySelector('#showTasksBtn').textContent    = '📋 Задачи';
    popupElement.querySelector('#showPlanningBtn').textContent = '📅 Спланировано';
    if (!isOpen) {
      if (planningPanel) {
        planningPanel.style.display       = 'flex';
        planningPanel.style.flexDirection = 'column';
      }
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

  // ── Модал новой задачи ───────────────────────────────────────────────────
  const newTaskModal = popupElement.querySelector('#newTaskModal');

  popupElement.querySelector('#newTaskBtn').addEventListener('click', () => {
    if (!myRole) { showToast('Сначала выберите свой расчёт', 'error'); return; }
    const targetSelect = newTaskModal.querySelector('#taskTargetSelect');
    targetSelect.innerHTML = '<option value="">— без привязки к цели —</option>';
    const rows = document.querySelectorAll('#statusTable tbody tr');
    rows.forEach(row => {
      const id    = row.cells[0]?.innerText.trim();
      const title = row.cells[1]?.querySelector('select')?.value || '';
      const opt   = document.createElement('option');
      opt.value   = id;
      opt.textContent = `#${id} ${title}`;
      targetSelect.appendChild(opt);
    });
    const officeSelect = newTaskModal.querySelector('#taskOfficeSelect');
    if (officeSelect) {
      officeSelect.innerHTML = '';
      const myOfficeId = store.get('myOfficeId') || 'HQ';
      Object.entries(OFFICES).forEach(([id, office]) => {
        if (!canAssignTask(myOfficeId, id)) return;
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = office.name + (id === myOfficeId ? ' (своё)' : '');
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
    const to          = newTaskModal.querySelector('#taskTo').value;
    const text        = newTaskModal.querySelector('#taskText').value.trim();
    const targetSel   = newTaskModal.querySelector('#taskTargetSelect');
    const targetId    = targetSel.value;
    const targetTitle = targetId ? targetSel.options[targetSel.selectedIndex].text : '';
    const toOfficeId  = newTaskModal.querySelector('#taskOfficeSelect')?.value || store.get('myOfficeId') || 'HQ';
    const myOfficeId  = store.get('myOfficeId') || 'HQ';
    if (!to)     { showToast('Укажите адресата', 'error'); return; }
    if (!text)   { showToast('Введите текст задачи', 'error'); return; }
    if (!myRole) { showToast('Сначала выберите свой расчёт', 'error'); return; }
    if (!canAssignTask(myOfficeId, toOfficeId)) {
      showToast('Нет прав назначать задачи этому подразделению', 'error'); return;
    }
    wsSend({ type: 'NEW_TASK', to, text, targetId, targetTitle, toOfficeId, fromOfficeId: myOfficeId });
    newTaskModal.style.display = 'none';
    newTaskModal.querySelector('#taskTo').value            = '';
    newTaskModal.querySelector('#taskText').value          = '';
    newTaskModal.querySelector('#taskTargetSelect').value  = '';
    const offSel = newTaskModal.querySelector('#taskOfficeSelect');
    if (offSel) offSel.value = '';
  });

  popupElement.querySelector('#exportTableData').addEventListener('click', () => {
    showToast('Экспорт в Excel – функция в разработке', 'info');
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

  return popupElement;
}

// ── Сброс всех полей модала добавления цели ──────────────────────────────────
function _resetAddTargetModal() {
  const p = popupElement;
  if (!p) return;
  p.querySelector('#targetTitle').value           = '';
  p.querySelector('#targetType').value            = '';
  p.querySelector('#targetAddress').value         = '';
  p.querySelector('#coordX').value                = '';
  p.querySelector('#coordY').value                = '';
  p.querySelector('#impactTime').value            = '';
  p.querySelector('#impactDate').value            = '';
  p.querySelector('#impactResult').selectedIndex  = 0;
  p.querySelector('#targetPhoto').value           = '';
  p.querySelector('#targetVideo').value           = '';
  p.querySelector('#targetPhotoPreview').style.display = 'none';
  p.querySelector('#targetVideoPreview').style.display = 'none';
}

function closeBtn() {
  const closeBtnElem = document.querySelector('#closePopupBtn');
  if (closeBtnElem && !closeBtnElem.hasListener) {
    closeBtnElem.addEventListener('click', function () {
      const popup = document.querySelector('#extension-popup');
      if (popup) popup.style.display = 'none';
    });
    closeBtnElem.hasListener = true;
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
  btn.style.cssText = 'padding: 6px 12px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; margin: 4px;';

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
  const today      = getMoscowDateStr();
  const tomorrow   = new Date(Date.now() + 3*3600000 + 86400000).toISOString().slice(0,10);
  const noDate     = !activeFolderDate;
  const isToday    = activeFolderDate === today;
  const isTomorrow = activeFolderDate === tomorrow;
  if (noDate || isToday || isTomorrow) {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor  = 'pointer';
    btn.title = isTomorrow ? '📅 Добавление в папку завтрашнего дня' : '';
  } else {
    btn.disabled = true;
    btn.style.opacity = '0.4';
    btn.style.cursor  = 'not-allowed';
    btn.title = `Только просмотр. Добавление доступно для сегодня (${today}) и завтра (${tomorrow})`;
  }
}