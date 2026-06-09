// content/ui/tasks.js

const STATUS_COLORS = {
  'новая':        '#fd7e14',
  'принята':      '#17a2b8',
  'в работе':     '#007bff',
  'выполнена':    '#28a745',
  'поражена':     '#28a745',
  'не поражена':  '#dc3545',
  'доразведка':   '#6f42c1',
  'подтверждено': '#28a745',
  'подавлено':    '#20c997',
  'перенесена':   '#0097a7',
  'отклонена':    '#6c757d',
  'уничтожена':   '#dc3545',
};

// Только уничтожена блокирует кнопки
const FINAL_STATUSES = ['уничтожена'];

// ── Ячейка задачи в таблице целей ────────────────────────────────────────────
function renderTaskCell(cell, targetId, targetTitle, canAssign = true) {
  const tasksByTarget = store.get('tasksByTarget') || {};
  const task = tasksByTarget[targetId] || null;
  cell.innerHTML = '';

  const CLOSED_STATUSES = [
    'уничтожена', 'поражена', 'подтверждено',
    'подавлено', 'отклонена', 'не поражена'
  ];
  const taskClosed = task && CLOSED_STATUSES.includes(task.status);

  if (task && !taskClosed) {
    const color  = STATUS_COLORS[task.status] || '#888';
    const toRole = task.to_role || task.to || '?';
    const toOff  = task.to_office
      ? ` [${OFFICES[task.to_office]?.short || task.to_office}]` : '';
    const wrap   = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;';
    wrap.innerHTML = `
      <div style="font-size:11px;color:#555;">→ <b>${toRole}${toOff}</b></div>
      <span style="background:${color};color:white;padding:1px 8px;border-radius:10px;
                   font-size:11px;white-space:nowrap;">${task.status}</span>
    `;
    cell.appendChild(wrap);
  } else if (canAssign) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;';
    if (task && taskClosed) {
      const color = STATUS_COLORS[task.status] || '#888';
      wrap.innerHTML = `
        <span style="background:${color};color:white;padding:1px 6px;border-radius:8px;
                     font-size:10px;opacity:0.7;margin-bottom:2px;">${task.status}</span>
      `;
    }
    const btn = document.createElement('button');
    btn.style.cssText = 'padding:4px 10px;background:#fd7e14;color:white;border:none;' +
                        'border-radius:5px;cursor:pointer;font-size:12px;white-space:nowrap;';
    btn.textContent = '+ Задача';
    btn.addEventListener('click', () => openNewTaskModal(targetId, targetTitle));
    wrap.appendChild(btn);
    cell.appendChild(wrap);
  } else {
    cell.innerHTML = '<span style="color:#ccc;font-size:11px;">—</span>';
  }
}

// Обновить tasksByTarget в store
function _updateTasksByTarget(task) {
  const tid = task?.target_id || task?.targetId;
  if (!tid) return;
  const tasksByTarget = store.get('tasksByTarget') || {};
  if (!tasksByTarget[tid] || task.id >= tasksByTarget[tid].id) {
    tasksByTarget[tid] = task;
  }
}

// ── Открыть модал новой задачи ────────────────────────────────────────────────
function openNewTaskModal(targetId, targetTitle) {
  if (!myRole) { showToast('Сначала войдите — расчёт не определён', 'error'); return; }
  const modal = document.querySelector('#newTaskModal');
  if (!modal) return;

  const targetSelect = modal.querySelector('#taskTargetSelect');
  if (targetSelect) {
    targetSelect.innerHTML = '<option value="">— без привязки к цели —</option>';
    document.querySelectorAll('#statusTable tbody tr').forEach(row => {
      // Новая структура: col 1 = Номер цели, col 2 = Характер (через .char-cell)
      const id    = row.cells[1]?.innerText.trim();
      const title = row.querySelector('.char-cell select')?.value || '';
      const opt   = document.createElement('option');
      opt.value   = id;
      opt.textContent = `#${id} ${title}`;
      if (id === String(targetId)) opt.selected = true;
      targetSelect.appendChild(opt);
    });
  }

  const myOfficeId = store.get('myOfficeId') || 'HQ';
  const officeSelect = modal.querySelector('#taskOfficeSelect');
  if (officeSelect) {
    officeSelect.innerHTML = '';
    Object.entries(OFFICES).forEach(([id, office]) => {
      if (!canAssignTask(myOfficeId, id)) return;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = office.name + (id === myOfficeId ? ' (свой)' : '');
      officeSelect.appendChild(opt);
    });
    officeSelect.onchange = () => _fillRolesForOffice(officeSelect.value);
    _fillRolesForOffice(myOfficeId);
  }

  const tasksPanel   = document.querySelector('#tasksPanel');
  const tableWrapper = document.querySelector('.table-wrapper');
  if (tasksPanel && tasksPanel.style.display === 'none') {
    tasksPanel.style.display       = 'flex';
    tasksPanel.style.flexDirection = 'column';
    if (tableWrapper) tableWrapper.style.display = 'none';
    const btn = document.querySelector('#showTasksBtn');
    if (btn) btn.textContent = '🗺️ Цели';
  }
  modal.style.display = 'flex';
}

function _fillRolesForOffice(officeId) {
  const roleSelect = document.querySelector('#taskTo');
  if (!roleSelect) return;
  const office = OFFICES[officeId];
  if (!office) return;
  roleSelect.innerHTML = '<option value="">— выбрать расчёт —</option>';
  Object.keys(office.roles).forEach(role => {
    const opt = document.createElement('option');
    opt.value = role;
    opt.textContent = role.charAt(0).toUpperCase() + role.slice(1);
    roleSelect.appendChild(opt);
  });
}

// ── Принять / Отклонить ───────────────────────────────────────────────────────
function acceptTask(taskId) {
  wsSend({ type: 'UPDATE_TASK', taskId, status: 'принята' });
  unreadTaskCount = Math.max(0, unreadTaskCount - 1);
  updateTaskBadge();
  showToast('Задача принята', 'success');
}

function rejectTask(taskId) {
  wsSend({ type: 'UPDATE_TASK', taskId, status: 'отклонена' });
  unreadTaskCount = Math.max(0, unreadTaskCount - 1);
  updateTaskBadge();
  showToast('Задача отклонена', 'info');
}

function changeTaskStatus(taskId, status) {
  if (!status) return;
  wsSend({ type: 'UPDATE_TASK', taskId, status });
}

// ── Модал переноса ────────────────────────────────────────────────────────────
function showRescheduleModal(taskId) {
  document.querySelector('#rescheduleModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'rescheduleModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10002;font-family:system-ui,sans-serif;';
  const tomorrow = new Date(Date.now() + 3*60*60*1000 + 24*60*60*1000).toISOString().slice(0,10);
  modal.innerHTML = `
    <div style="background:white;border-radius:10px;padding:24px;width:90%;max-width:360px;">
      <h3 style="margin:0 0 16px;font-size:16px;">Перенести задачу</h3>
      <label style="font-size:13px;color:#555;display:block;margin-bottom:6px;">Новая дата выполнения:</label>
      <input id="rescheduleDate" type="date" min="${tomorrow}"
        style="width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:14px;box-sizing:border-box;" />
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
        <button id="cancelReschedule" style="padding:7px 16px;border:1px solid #ccc;border-radius:6px;cursor:pointer;background:white;">Отмена</button>
        <button id="confirmReschedule" style="padding:7px 16px;background:#2563eb;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:600;">Перенести</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('#cancelReschedule').addEventListener('click', () => modal.remove());
  modal.querySelector('#confirmReschedule').addEventListener('click', () => {
    const date = modal.querySelector('#rescheduleDate').value;
    if (!date) { showToast('Выберите дату', 'error'); return; }
    wsSend({ type: 'UPDATE_TASK', taskId, status: 'перенесена', rescheduleDate: date });
    showToast(`Задача перенесена на ${date.slice(8)}.${date.slice(5,7)}`, 'info');
    modal.remove();
  });
}

// ── Бейдж непрочитанных ───────────────────────────────────────────────────────
function updateTaskBadge() {
  const badge = document.querySelector('#task-badge');
  if (!badge) return;
  badge.textContent = unreadTaskCount || '';
  badge.style.display = unreadTaskCount > 0 ? 'flex' : 'none';
}

// ── Плашка роли в шапке ───────────────────────────────────────────────────────
function updateRoleTag() {
  const tag = document.querySelector('#myRoleTag');
  if (!tag) return;
  if (myRole && myDisplayName) {
    const officeId    = store.get('myOfficeId') || 'HQ';
    const officeShort = OFFICES[officeId]?.short || officeId;
    tag.textContent   = `${myDisplayName} [${myRole} · ${officeShort}]`;
    tag.style.background = OFFICES[officeId]?.isHQ ? '#1a5276' : '#4a235a';
  } else {
    tag.textContent = '🔄 Определяю расчёт...';
  }
}

// ── Индикатор онлайн по подразделениям ───────────────────────────────────────
let _lastOnlineRoles = {};

function updateOnlineIndicator(online) {
  _lastOnlineRoles = online;
  _renderOnlineIndicator();
}

function _renderOnlineIndicator() {
  const el = document.querySelector('#online-indicator');
  if (!el) return;
  if (typeof OFFICES === 'undefined') return;

  const myOfficeId = store.get('myOfficeId') || 'HQ';
  const parts = [];

  Object.entries(OFFICES).forEach(([officeId, office]) => {
    const onlineInOffice = _lastOnlineRoles[officeId] || [];
    const allRoles = Object.keys(office.roles);
    if (allRoles.length === 0) return;

    const isMine = officeId === myOfficeId;
    const chips  = allRoles.map(r => {
      const on  = onlineInOffice.includes(r);
      const col = on ? '#28a745' : '#4a5568';
      return `<span title="${r}" style="display:inline-flex;align-items:center;gap:3px;font-size:11px;margin-right:4px;color:${col};">
        <span style="width:7px;height:7px;border-radius:50%;background:${on ? '#28a745' : '#4a5568'};display:inline-block;"></span>${r}
      </span>`;
    }).join('');

    parts.push(`
      <span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;flex-wrap:wrap;">
        <span style="font-size:10px;color:${isMine ? '#90cdf4' : '#718096'};font-weight:${isMine ? '600' : '400'};white-space:nowrap;">${office.short}</span>
        ${chips}
      </span>`);
  });

  el.innerHTML = parts.join('<span style="color:#2d4a6a;margin-right:12px;">|</span>');
}

// ── Панель задач ──────────────────────────────────────────────────────────────
function addTaskToPanel(task) {
  const tbody = document.querySelector('#tasksTable tbody');
  if (!tbody) return;
  const existing = tbody.querySelector(`[data-task-id="${task.id}"]`);
  if (existing) { updateTaskRowEl(existing, task); return; }
  if (!task.from && task.from_role) task.from = task.from_role;
  if (!task.to   && task.to_role)   task.to   = task.to_role;
  const row = renderTaskRow(task);

  const rows = tbody.querySelectorAll('tr');
  const taskTime = new Date(task.created_at || 0).getTime();
  let inserted = false;
  for (const existingRow of rows) {
    const rowTaskId = existingRow.getAttribute('data-task-id');
    const rowTask   = _getTaskById(rowTaskId);
    const rowTime   = new Date(rowTask?.created_at || 0).getTime();
    if (taskTime >= rowTime) {
      tbody.insertBefore(row, existingRow);
      inserted = true;
      break;
    }
  }
  if (!inserted) tbody.appendChild(row);

  const tasksByTarget = store.get('tasksByTarget') || {};
  const tid = task.target_id || task.targetId;
  if (tid && (!tasksByTarget[tid] || task.id >= tasksByTarget[tid].id)) {
    tasksByTarget[tid] = task;
  }
}

function updateTaskInPanel(task) {
  const tbody = document.querySelector('#tasksTable tbody');
  if (!tbody) return;
  const existing = tbody.querySelector(`[data-task-id="${task.id}"]`);
  if (existing) updateTaskRowEl(existing, task);
  else addTaskToPanel(task);
}

const _tasksCache = {};

function _getTaskById(taskId) {
  return _tasksCache[taskId] || null;
}

function _cacheTask(task) {
  if (task?.id) _tasksCache[task.id] = task;
}

function renderTaskRow(task) {
  _cacheTask(task);
  const tr = document.createElement('tr');
  tr.setAttribute('data-task-id', task.id);
  updateTaskRowEl(tr, task);
  return tr;
}

function updateTaskRowEl(tr, task) {
  _cacheTask(task);
  const color = STATUS_COLORS[task.status] || '#888';

  const fromOffice = task.from_office
    ? ` [${OFFICES[task.from_office]?.short || task.from_office}]` : '';
  const toOffice   = task.to_office
    ? ` [${OFFICES[task.to_office]?.short   || task.to_office}]`   : '';

  const fromRole = (task.from_role || task.from || '?') + fromOffice;
  const toRole   = (task.to_role   || task.to   || '?') + toOffice;

  const myOfficeId     = store.get('myOfficeId') || 'HQ';
  const toRole_check   = task.to_role || task.to || '';
  const toOffice_check = task.to_office || '';

  const isMyTask = toRole_check === myRole && (
    toOffice_check === '' ? true :
    toOffice_check === myOfficeId
  );

  const isMyOutgoing = (task.from_role === myRole || task.from === myRole)
                     && (task.from_office || 'HQ') === myOfficeId;

  const canAct = isMyTask && !isMyOutgoing && !FINAL_STATUSES.includes(task.status);

  const dateStr = task.created_at || task.createdAt || '';
  const time    = dateStr
    ? new Date(dateStr).toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'})
    : '';

  const ACTION_STATUSES = [
    {value:'принята',      label:'✅ Принята'},
    {value:'в работе',     label:'🔄 В работе'},
    {value:'поражена',     label:'💥 Поражена'},
    {value:'не поражена',  label:'❌ Не поражена'},
    {value:'доразведка',   label:'🔍 Доразведка'},
    {value:'подтверждено', label:'✔️ Подтверждено'},
    {value:'подавлено',    label:'📡 Подавлено'},
    {value:'перенесена',   label:'📅 Перенести'},
    {value:'уничтожена',   label:'🔥 Уничтожена'},
    {value:'отклонена',    label:'🚫 Отклонить'},
  ];

  tr.innerHTML = `
    <td style="font-size:12px;color:#666;padding:6px 8px;white-space:nowrap;">${time}</td>
    <td style="font-size:12px;padding:6px 8px;">${fromRole}</td>
    <td style="font-size:12px;padding:6px 8px;">${toRole}</td>
    <td style="font-size:12px;padding:6px 8px;">
      ${task.text}
      ${task.targetTitle
        ? `<br><span style="color:#888;font-size:11px;">📍 ${task.targetTitle}</span>` : ''}
      ${task.target_title && !task.targetTitle
        ? `<br><span style="color:#888;font-size:11px;">📍 ${task.target_title}</span>` : ''}
    </td>
    <td style="padding:6px 8px;">
      <span style="background:${color};color:white;padding:2px 8px;border-radius:10px;font-size:11px;white-space:nowrap;">${task.status}</span>
    </td>
    <td style="padding:6px 8px;" class="task-action-cell"></td>
  `;

  const actionTd = tr.querySelector('.task-action-cell');
  if (canAct) {
    const sel = document.createElement('select');
    sel.style.cssText = 'font-size:11px;padding:3px 6px;border-radius:4px;border:1px solid #ccc;cursor:pointer;';
    const defOpt = document.createElement('option');
    defOpt.value = ''; defOpt.textContent = '— ответ —';
    sel.appendChild(defOpt);
    ACTION_STATUSES.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.value; opt.textContent = s.label;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function() {
      if (!this.value) return;
      if (this.value === 'перенесена') {
        showRescheduleModal(task.id);
        this.value = '';
        return;
      }
      changeTaskStatus(task.id, this.value);
    });
    actionTd.appendChild(sel);
  } else {
    const label = FINAL_STATUSES.includes(task.status)
      ? `<span style="font-size:11px;color:#dc3545;font-weight:600;">🔥 ${task.status}</span>`
      : `<span style="font-size:11px;color:#888;">—</span>`;
    actionTd.innerHTML = label;
  }
}

// ── Обновление ячеек задач — НОВАЯ СТРУКТУРА ТАБЛИЦЫ ─────────────────────────
// data-target-id стоит на TR, характеристика — в .char-cell
function refreshAllTaskCells() {
  document.querySelectorAll('#statusTable tbody tr').forEach(row => {
    const targetId    = row.getAttribute('data-target-id') || row.dataset.targetId;
    const targetTitle = row.querySelector('.char-cell select')?.value || '';
    const taskCell    = row.querySelector('.task-cell');
    if (taskCell && targetId) renderTaskCell(taskCell, targetId, targetTitle, true);
  });
}

function refreshTaskCellByTargetId(task) {
  const tid = task?.target_id || task?.targetId;
  if (!tid) return;
  const tasksByTarget = store.get('tasksByTarget') || {};
  if (!tasksByTarget[tid] || task.id >= tasksByTarget[tid].id) tasksByTarget[tid] = task;
  const row = document.querySelector(`#statusTable tr[data-target-id="${tid}"]`);
  if (!row) return;
  const cell  = row.querySelector('.task-cell');
  const title = row.querySelector('.char-cell select')?.value || '';
  if (cell) renderTaskCell(cell, tid, title, true);
}

function refreshAllBadges() { updateTaskBadge(); }