// content/ui/planning.js
// UI планирования: строки плана в таблице, обновление дат, публикация.
// Зависимости: store.js, wsClient.js, ui/toast.js, utils/date.js

function updatePlanDateInPlanning(plan) {
  const parts     = (plan.plan_date || '').split('-');
  const dateShort = parts.length === 3 ? `${parts[2]}.${parts[1]}` : plan.plan_date;
  const timeStr   = plan.created_at ? new Date(plan.created_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}) : '';
  const dateLabel = timeStr ? `${dateShort} ${timeStr}` : dateShort;
  const row = document.querySelector(`tr[data-target-id="${plan.target_id}"]`);
  // col 7 = Результат в новой структуре
  if (row && row.cells[7]) {
    row.cells[7].innerHTML = `<span style="color:#2563eb;font-weight:600;font-size:12px;">${dateLabel}</span>`;
  }
}

function loadPlansForDate(date) {
  if (!myRole) return;
  wsSend({ type: 'GET_PLANS', planDate: date });
}

// Добавить строку плана в таблицу (черновик — синяя рамка)
// Новая структура колонок:
// 0: Дата обнаруж.  1: Номер цели  2: Характер  3: Место
// 4: X  5: Y  6: Просмотр  7: Результат  8: Задача  9: Дата уничт.  10: Формуляр
function appendPlanRowToTable(plan) {
  const tbody = document.querySelector('#statusTable tbody');
  if (!tbody) return;

  if (tbody.querySelector(`[data-plan-id="${plan.id}"]`)) return;
  for (const row of tbody.querySelectorAll('tr:not([data-plan-id])')) {
    if (row.cells[1]?.textContent?.trim() === String(plan.target_id)) return;
  }

  let data = {};
  try { data = JSON.parse(plan.target_data); } catch {}

  const parts     = (plan.plan_date || '').split('-');
  const dateShort = parts.length === 3 ? `${parts[2]}.${parts[1]}` : plan.plan_date;
  const timeStr   = plan.created_at ? new Date(plan.created_at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}) : '';
  const dateLabel = timeStr ? `${dateShort} ${timeStr}` : dateShort;

  const row = tbody.insertRow(0);
  row.setAttribute('data-plan-id', plan.id);
  row.setAttribute('data-target-id', String(plan.target_id));
  row.style.background = 'rgba(37,99,235,0.08)';
  row.style.borderLeft = '3px solid #2563eb';

  const cols = [
    // 0: Дата обнаруж.
    `<span style="font-size:11px;">${dateShort}</span>`,
    // 1: Номер цели
    String(data.targetNumber || plan.target_id),
    // 2: Характер
    data.characteristic || '',
    // 3: Место
    '',
    // 4: X
    data.coordX || '',
    // 5: Y
    data.coordY || '',
    // 6: Просмотр
    `<a href="https://center.astramaps.ru/map/${plan.target_id}" target="_blank" rel="noopener noreferrer"
       style="display:inline-block;padding:4px 8px;background:#2c7da0;color:white;border-radius:4px;font-size:12px;text-decoration:none;">👁️</a>`,
    // 7: Результат — пометка "план"
    `<span style="background:#e0e7ff;color:#2563eb;padding:2px 8px;border-radius:8px;font-size:11px;">📅 план на ${dateLabel}</span>`,
    // 8: Задача (создал кто)
    plan.created_by || '',
    // 9: Дата уничтожения
    data.defeatDate || '',
    // 10: Формуляр — кнопка удалить
    '',
  ];

  cols.forEach((val, i) => {
    const td = row.insertCell(i);
    td.style.cssText = 'padding:5px 8px;font-size:12px;text-align:center;vertical-align:middle;';
    td.innerHTML = String(val);
  });

  const delBtn = document.createElement('button');
  delBtn.textContent = '✕';
  delBtn.style.cssText = 'padding:3px 8px;background:#dc3545;color:white;border:none;border-radius:4px;cursor:pointer;font-size:11px;';
  delBtn.addEventListener('click', () => wsSend({ type: 'DELETE_PLAN', planId: plan.id }));
  row.cells[10].appendChild(delBtn);
}

// Заблокировать кнопки задач для прошедших дат
function disableTaskButtonsIfPast() {
  const today = getMoscowDateStr();
  if (!activeFolderDate || activeFolderDate >= today) return;
  document.querySelectorAll('#statusTable .task-cell button').forEach(btn => {
    btn.disabled = true;
    btn.style.opacity = '0.35';
    btn.style.cursor  = 'not-allowed';
    btn.title = 'Недоступно для прошедших дат';
  });
}

// ❌ Функция updatePublishBtn удалена – она определена в content.js (полная версия с проверкой прав)