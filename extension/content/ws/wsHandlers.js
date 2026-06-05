// content/ws/wsHandlers.js
// Обработка входящих WS-сообщений.
// Зависимости: store.js, ui/tasks.js, ui/toast.js, ui/planning.js, ui/roleSelector.js

// Нормализует online: старый сервер шлёт массив ['рэб','арт.'],
// новый шлёт объект {HQ:['рэб'], o177:['арт.']}
// Приводим оба формата к объекту
function normalizeOnline(online) {
  if (!online) return {};
  if (Array.isArray(online)) {
    // Старый формат — всё в HQ
    return online.length > 0 ? { HQ: online } : {};
  }
  return online;
}

function handleWsMessage(msg) {
  switch (msg.type) {

    // ── Регистрация подтверждена ──────────────────────────────────────────────
    // online: { HQ: ['рэб','арт.'], o177: ['разведка'] }
    case 'REGISTERED': {
      myRole        = msg.role;
      myDisplayName = msg.displayName;
      store.set('myRole',        myRole);
      store.set('myDisplayName', myDisplayName);
      store.set('myOfficeId',    msg.officeId || store.get('myOfficeId') || 'HQ');
      console.log(`[ws] Зарегистрирован: ${myRole} ${myDisplayName}`);
      updateRoleTag();

      // Гарантируем что сам пользователь виден онлайн даже если сервер не прислал себя
      const onlineData = normalizeOnline(msg.online);
      const myOffId    = store.get('myOfficeId') || 'HQ';
      if (!onlineData[myOffId]) onlineData[myOffId] = [];
      if (myRole && !onlineData[myOffId].includes(myRole)) onlineData[myOffId].push(myRole);
      updateOnlineIndicator(onlineData);
      try { chrome.storage.local.set({ userRole: myRole, userName: myDisplayName }); } catch {}
      break;
    }

    // ── Кто-то подключился / отключился ──────────────────────────────────────
    case 'USER_ONLINE':
    case 'USER_OFFLINE':
      updateOnlineIndicator(normalizeOnline(msg.online));
      break;

    // ── Нужно выбрать роль вручную ────────────────────────────────────────────
    case 'NEED_ROLE':
      showRoleSelector(msg.validRoles || VALID_ROLES);
      break;

    // ── Новая задача (входящая) ───────────────────────────────────────────────
    case 'NEW_TASK': {
  const task = msg.task;
  addTaskToPanel(task);
  _updateTasksByTarget(task);
  refreshTaskCellByTargetId(task);

  const seenTaskIds  = store.get('seenTaskIds');
  const myOfficeId   = store.get('myOfficeId') || 'HQ';
  const toRole       = task.to_role || task.to || '';
  const toOffice     = task.to_office || '';

  // Уведомление только получателю задачи
  const isForMe = toRole === myRole
    && (toOffice === '' || toOffice === myOfficeId);

  if (isForMe && !seenTaskIds.has(task.id)) {
    seenTaskIds.add(task.id);
    unreadTaskCount++;
    updateTaskBadge();
    renderTaskNotification(task);
    playNotificationSound();
  } else if (!isForMe && !seenTaskIds.has(task.id)) {
    // Отправитель и наблюдатели — добавляем в seen без уведомления
    seenTaskIds.add(task.id);
  }
  break;
}

    // ── Задача отправлена (подтверждение) ─────────────────────────────────────
    case 'TASK_SENT':
      addTaskToPanel(msg.task);
      showToast('Задача отправлена', 'success');
      break;

    // ── Обновление статуса задачи ─────────────────────────────────────────────
    case 'TASK_UPDATED':
    case 'TASK_UPDATE':
      updateTaskInPanel(msg.task);
      _updateTasksByTarget(msg.task);
      refreshTaskCellByTargetId(msg.task);
      break;

    // ── Список задач при входе ────────────────────────────────────────────────
    case 'PENDING_TASKS': {
  const seenTaskIds = store.get('seenTaskIds');
  (msg.tasks || []).forEach(task => {
    addTaskToPanel(task);
    _updateTasksByTarget(task);
    if (!seenTaskIds.has(task.id)) { seenTaskIds.add(task.id); unreadTaskCount++; }
  });
  updateTaskBadge();
  refreshAllTaskCells();
  break;
}

case 'TASKS_HISTORY':
  (msg.tasks || []).forEach(task => {
    addTaskToPanel(task);
    _updateTasksByTarget(task);
  });
  refreshAllTaskCells();
  break;

    // ── Планирование ──────────────────────────────────────────────────────────
    case 'PLAN_CREATED':
    case 'NEW_PLAN':
      appendPlanRowToTable(msg.plan);
      showToast('План добавлен', 'success');
      break;

    case 'PLAN_DELETED':
      document.querySelector(`[data-plan-id="${msg.planId}"]`)?.remove();
      break;

    case 'PLANS_LIST':
      (msg.plans || []).forEach(appendPlanRowToTable);
      break;

    case 'ERROR':
      showToast('Сервер: ' + (msg.text || 'ошибка'), 'error');
      break;

    default:
      break;
  }
}