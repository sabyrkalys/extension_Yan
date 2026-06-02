// content/ui/panel.js
// Сборка главной панели расширения, кнопка на карте, инициализация UI.
// Зависимости: store.js, wsClient.js, ui/tasks.js, ui/planning.js, ui/toast.js, utils/date.js

function createPopup() {
  if (popupElement) return popupElement;

  popupElement = document.createElement('div');
  popupElement.id = 'extension-popup';
  popupElement.innerHTML = `
  <div style="
    position: fixed;
    top: 25px;
    right: 20px;
    width: 60%;
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
      #statusTable { width: 100%; min-width:600px; border-collapse: collapse; font-size: 12px; }
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
    </style>

    <div style="padding: 5px 14px; background: #1e3a5f; color: white; display: flex; flex-direction: column; flex-shrink: 0;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <h3 style="margin: 0; font-size: 16px;">📋 Таблица учёта целей</h3>
          <button id="addTargetBtn" style="background:#28a745; color:white; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:14px;">+ Добавить цель</button>
          <!-- Кнопка задач с бейджем -->
          <div style="position:relative; display:inline-block;">
            <button id="showTasksBtn" style="background:#fd7e14; color:white; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:14px;">📋 Задачи</button>
            <span id="task-badge" style="display:none; position:absolute; top:-6px; right:-6px; background:#dc3545; color:white; border-radius:50%; width:18px; height:18px; font-size:11px; align-items:center; justify-content:center; font-weight:600;"></span>
          </div>
          <button id="showPlanningBtn" style="background:#6f42c1; color:white; border:none; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:14px;">📅 Спланировано</button>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <!-- Плашка с именем и расчётом (заполняется автоматически после REGISTER) -->
          <span id="myRoleTag" style="font-size:12px;background:#2c5282;padding:4px 10px;border-radius:6px;white-space:nowrap;">
            🔄 Определяю расчёт...
          </span>
          <button id="closePopupBtn" style="background: none; border: none; color: white; font-size: 28px; padding: 2px 12px; cursor: pointer;">&times;</button>
        </div>
      </div>
      <!-- Индикатор онлайн-расчётов -->
      <div id="online-indicator" style="padding: 4px 6px; font-size: 11px; opacity: 0.9; min-height: 18px; display:flex; flex-wrap:wrap; align-items:center; gap:4px;"></div>
    </div>

    <!-- Панель дат — между расчётами и таблицей -->
    <div id="dates-panel" style="
      background: #162d4a;
      padding: 6px 14px;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      flex-shrink: 0;
      border-bottom: 1px solid #0d1f33;
      min-height: 36px;
    ">
      <span style="font-size:11px;color:#7aa3c8;margin-right:4px;">📅 Даты:</span>
      <div id="dates-list" style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;">
        <span style="font-size:11px;color:#5a7fa0;">загрузка...</span>
      </div>
      <div style="margin-left:auto;display:flex;gap:6px;align-items:center;">
        <button id="publishPlanBtn" title="Опубликовать план в AstraMap" style="
          display:none; background:#28a745; border:none; color:white;
          border-radius:4px; padding:3px 10px; cursor:pointer; font-size:11px;
        ">📤 Опубликовать план</button>
        <button id="refreshDatesBtn" title="Обновить список дат" style="
          background:none; border:1px solid #4a7a9b;
          color:#7aa3c8; border-radius:4px; padding:2px 8px;
          cursor:pointer; font-size:11px;
        ">🔄</button>
      </div>
    </div>

    <div class="table-wrapper" style="flex: 1; overflow-y: auto; padding: 12px; background: #f5f7fa; color: black;">
      <table id="statusTable">
        <thead>
          <tr>
            <th rowspan="2">Номер цели</th>
            <th rowspan="2">Характеристика цели</th>
            <th colspan="2">Координаты</th>
            <th rowspan="2">Время обнаружения</th>
            <th rowspan="2">Результат</th>
            <th rowspan="2">Дата обнаружения</th>
            <th rowspan="2">Просмотр в AstraM</th>
            <th rowspan="2">Назначить задачу</th>
            <th rowspan="2">Сформировать формуляр</th>
          </tr>
          <tr><th>Х</th><th>У</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <!-- Панель задач (скрыта по умолчанию) -->
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

    <!-- Панель Спланировано — непоражённые цели по всем датам -->
    <div id="planningPanel" style="
      display:none; flex-direction:column; flex:1;
      overflow:hidden; background:#f5f7fa; color:black;
    "></div>

    <!-- Модал: создать новую задачу -->
    <div id="newTaskModal" style="position:fixed;inset:0;background:rgba(0,0,0,0.6);display:none;justify-content:center;align-items:center;z-index:10001;">
      <div style="background:white;width:90%;max-width:420px;border-radius:10px;padding:20px;display:flex;flex-direction:column;gap:10px;">
        <h3 style="margin:0;font-size:16px;">Новая задача</h3>
        <label style="font-size:12px;color:#555;">подразделение получателя:</label>
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
        <textarea id="taskText" rows="3" placeholder="Например: Доразведать объект, уточнить координаты" style="padding:6px;border-radius:5px;border:1px solid #ccc;resize:vertical;font-size:13px;"></textarea>
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

    <div id="addTargetModal" style="position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; justify-content: center; align-items: center; z-index: 10000;">
      <div style="background: white; width: 90%; max-width: 500px; border-radius: 10px; padding: 20px; display: flex; flex-direction: column; gap: 10px;">
        <h3 style="margin:0;">Добавление цели</h3>
        <input id="targetTitle" placeholder="Название цели" />
        <select id="targetType">
          <option selected>Категория</option>
          <option value="ПУ">ПУ</option>
          <option value="ПУ БПЛА">ПУ БПЛА</option>
          <option value="Точка влета">Точка взлета</option>
          <option value="РЛС">РЛС</option>
          <option value="РЭБ">РЭБ</option>
          <option value="Связь">Связь</option>
          <option value="ЗРК">ЗРК</option>
          <option value="Танк">Танк</option>
          <option value="БМП">БМП</option>
          <option value="ББМ">ББМ</option>
          <option value="Склад">Склад</option>
          <option value="КНП">КНП</option>
          <option value="Укрытие">Укрытие</option>
        </select>
        <input id="coordX" type="number" placeholder="Координата X" />
        <input id="coordY" type="number" placeholder="Координата Y" />
        <!-- ✅ FIX: опечатка исправлена -->
        <input id="impactTime" type="time" placeholder="Время обнаружения" />
        <input id="impactDate" type="date" placeholder="Дата обнаружения" />
        <select id="impactResult">
          <option selected>Вскрыто</option>
          <option>Поражена</option>
          <option>Не поражена</option>
          <option>Подана на доразведку</option>
          <option>Принято на доразведку</option>
          <option>Подтверждено</option>
        </select>
        <div style="display:flex; gap:10px; justify-content:flex-end;">
          <button id="cancelAddTarget">Отмена</button>
          <button id="submitAddTarget" style="background:#28a745;color:white;">💾 Добавить</button>
        </div>
      </div>
    </div>
  </div>
  `;

  popupElement.style.display = 'none';
  document.body.appendChild(popupElement);

  // Применяем закешированные данные индикатора (могли прийти до создания попапа)
  if (typeof _renderOnlineIndicator === 'function') _renderOnlineIndicator();
  if (typeof updateRoleTag === 'function') updateRoleTag();

  // Заполняем список расчётов из config.js — добавить роль = только в ROLE_TO_USERS
  const taskToSelect = popupElement.querySelector('#taskTo');
  Object.keys(ROLE_TO_USERS).forEach(role => {
    const opt = document.createElement('option');
    opt.value = role;
    opt.textContent = role.charAt(0).toUpperCase() + role.slice(1);
    taskToSelect.appendChild(opt);
  });

  const modal = popupElement.querySelector('#addTargetModal');

  popupElement.querySelector('#addTargetBtn').addEventListener("click", function () {
    // Подставляем московское время (UTC+3) в поля при каждом открытии
    popupElement.querySelector('#impactDate').value = getMoscowDateStr();
    popupElement.querySelector('#impactTime').value = getMoscowTimeStr();
    modal.style.display = 'flex';
  });

  popupElement.querySelector('#cancelAddTarget').onclick = () => {
    modal.style.display = 'none';
  };

  popupElement.querySelector('#submitAddTarget').onclick = async () => {
    try {
      const data = {
        targetNumber: '1',
        characteristic: popupElement.querySelector('#targetType').value,
        coordX: popupElement.querySelector('#coordX').value,
        coordY: popupElement.querySelector('#coordY').value,
        impactTime: popupElement.querySelector('#impactTime').value,
        result: popupElement.querySelector('#impactResult').value,
        defeatDate: popupElement.querySelector('#impactDate').value,
      };

      const existing = getTableData();
      existing.push(data);
      populateTable(existing);

      await apiSendTarget(data);

      // Перезагружаем данные через основной путь (с кэшем и папками)
      await loadByDateFromPanel(getMoscowDateStr());

      // ✅ FIX: сброс полей после закрытия модала
      modal.style.display = 'none';
      popupElement.querySelector('#targetTitle').value = '';
      popupElement.querySelector('#targetType').selectedIndex = 0;
      popupElement.querySelector('#coordX').value = '';
      popupElement.querySelector('#coordY').value = '';
      popupElement.querySelector('#impactTime').value = '';
      popupElement.querySelector('#impactDate').value = '';
      popupElement.querySelector('#impactResult').selectedIndex = 0;

      showToast('✅ Цель добавлена', 'success');
    } catch (e) {
      modal.style.display = 'none';
      showToast('❌ Ошибка отправки', 'error');
      console.error(e);
    }
  };

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

  // ── Кнопка Планирование ─────────────────────────────────────────────────
  const tableWrapper  = popupElement.querySelector('.table-wrapper');
  const tasksPanel    = popupElement.querySelector('#tasksPanel');
  const planningPanel = popupElement.querySelector('#planningPanel');

  popupElement.querySelector('#showPlanningBtn').addEventListener('click', () => {
    const isOpen = planningPanel && planningPanel.style.display !== 'none';
    // Скрываем все панели
    if (tableWrapper)  tableWrapper.style.display  = 'none';
    if (tasksPanel)    tasksPanel.style.display     = 'none';
    if (planningPanel) planningPanel.style.display  = 'none';
    popupElement.querySelector('#showTasksBtn').textContent    = '📋 Задачи';
    popupElement.querySelector('#showPlanningBtn').textContent = '📅 Спланировано';

    if (!isOpen) {
      if (planningPanel) {
        planningPanel.style.display     = 'flex';
        planningPanel.style.flexDirection = 'column';
      }
      popupElement.querySelector('#showPlanningBtn').textContent = '🗺️ Цели';
      loadPlanningTargets();
    } else {
      if (tableWrapper) tableWrapper.style.display = '';
    }
  });

  // ── Переключение между таблицей целей и панелью задач ───────────────────
  

  popupElement.querySelector('#showTasksBtn').addEventListener('click', () => {
    const isTasksVisible = tasksPanel.style.display !== 'none';
    if (isTasksVisible) {
      tasksPanel.style.display = 'none';
      tableWrapper.style.display = '';
      popupElement.querySelector('#showTasksBtn').textContent = '📋 Задачи';
    } else {
      tasksPanel.style.display = 'flex';
      tasksPanel.style.flexDirection = 'column';
      tableWrapper.style.display = 'none';
      popupElement.querySelector('#showTasksBtn').textContent = '🗺️ Цели';
      // Сбрасываем счётчик когда открыли панель задач
      unreadTaskCount = 0;
      updateTaskBadge();
    }
  });

  // ── Модал новой задачи ───────────────────────────────────────────────────
  const newTaskModal = popupElement.querySelector('#newTaskModal');

  popupElement.querySelector('#newTaskBtn').addEventListener('click', () => {
    if (!myRole) { showToast('Сначала выберите свой расчёт', 'error'); return; }
    // Заполняем список целей из текущей таблицы
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

    const toOfficeId = newTaskModal.querySelector('#taskOfficeSelect')?.value || store.get('myOfficeId') || 'HQ';
    const myOfficeId = store.get('myOfficeId') || 'HQ';

    if (!to)   { showToast('Укажите адресата', 'error'); return; }
    if (!text) { showToast('Введите текст задачи', 'error'); return; }
    if (!myRole) { showToast('Сначала выберите свой расчёт', 'error'); return; }
    if (!canAssignTask(myOfficeId, toOfficeId)) {
      showToast('Нет прав назначать задачи этому подразделениеу', 'error'); return;
    }

    wsSend({ type: 'NEW_TASK', to, text, targetId, targetTitle, toOfficeId, fromOfficeId: myOfficeId });

    newTaskModal.style.display = 'none';
    newTaskModal.querySelector('#taskTo').value = '';
    newTaskModal.querySelector('#taskText').value = '';
    newTaskModal.querySelector('#taskTargetSelect').value = '';
    const offSel = newTaskModal.querySelector('#taskOfficeSelect');
    if (offSel) offSel.value = '';
  });

  popupElement.querySelector('#exportTableData').addEventListener('click', () => {
    showToast('Экспорт в Excel – функция в разработке', 'info');
  });

  // Кнопка обновления дат — защита от двойного клика
  const refreshBtn = popupElement.querySelector('#refreshDatesBtn');
  refreshBtn.addEventListener('click', withLock(refreshBtn, async () => {
    cacheClearAll();
    await renderDatePanel(true);
  }, { label: '⏳' }));

  // Кнопка «Загрузить сегодня» — защита от двойного клика
  const todayBtn = popupElement.querySelector('#loadTodayMap');
  todayBtn.addEventListener('click', withLock(todayBtn, async () => {
    await loadByDateFromPanel(getMoscowDateStr());
  }, { label: '⏳' }));



  return popupElement;
}

function closeBtn() {
  const closeBtnElem = document.querySelector("#closePopupBtn");
  if (closeBtnElem && !closeBtnElem.hasListener) {
    closeBtnElem.addEventListener("click", function () {
      const popup = document.querySelector("#extension-popup");
      if (popup) popup.style.display = "none";
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
  const isLatest = activeFolderId && latestFolderId && activeFolderId === latestFolderId;
  const noDate   = !activeFolderId;
  if (isLatest || noDate) {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor  = 'pointer';
    btn.title = '';
  } else {
    btn.disabled = true;
    btn.style.opacity = '0.4';
    btn.style.cursor  = 'not-allowed';
    btn.title = `Только просмотр. Добавление в крайнюю папку (${latestFolderDate})`;
  }
}

