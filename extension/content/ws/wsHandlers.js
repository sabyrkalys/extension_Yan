// content/ws/wsHandlers.js

function normalizeOnline(online) {
  if (!online) return {};
  if (Array.isArray(online)) return online.length > 0 ? { HQ: online } : {};
  return online;
}

function handleWsMessage(msg) {
  switch (msg.type) {

    case 'REGISTERED': {
      myRole        = msg.role;
      myDisplayName = msg.displayName;
      store.set('myRole',        myRole);
      store.set('myDisplayName', myDisplayName);
      store.set('myOfficeId',    msg.officeId || store.get('myOfficeId') || 'HQ');
      console.log(`[ws] Зарегистрирован: ${myRole} ${myDisplayName}`);
      updateRoleTag();
      const onlineData = normalizeOnline(msg.online);
      const myOffId    = store.get('myOfficeId') || 'HQ';
      if (!onlineData[myOffId]) onlineData[myOffId] = [];
      if (myRole && !onlineData[myOffId].includes(myRole)) onlineData[myOffId].push(myRole);
      updateOnlineIndicator(onlineData);
      try { chrome.storage.local.set({ userRole: myRole, userName: myDisplayName }); } catch {}
      break;
    }

    case 'USER_ONLINE':
    case 'USER_OFFLINE':
      updateOnlineIndicator(normalizeOnline(msg.online));
      break;

    case 'NEED_ROLE':
      showRoleSelector(msg.validRoles || VALID_ROLES);
      break;

    case 'NEW_TASK': {
      const task = msg.task;
      addTaskToPanel(task);
      _updateTasksByTarget(task);
      refreshTaskCellByTargetId(task);

      const seenTaskIds = store.get('seenTaskIds');
      const myOfficeId  = store.get('myOfficeId') || 'HQ';
      const toRole      = task.to_role || task.to || '';
      const toOffice    = task.to_office || '';

      const isForMe = toRole === myRole
        && (toOffice === '' || toOffice === myOfficeId);

      if (isForMe && !seenTaskIds.has(task.id)) {
        seenTaskIds.add(task.id);
        unreadTaskCount++;
        updateTaskBadge();
        renderTaskNotification(task);
        playNotificationSound();
      } else if (!isForMe && !seenTaskIds.has(task.id)) {
        seenTaskIds.add(task.id);
      }
      break;
    }

    case 'TASK_SENT':
      addTaskToPanel(msg.task);
      showToast('Задача отправлена', 'success');
      break;

    case 'TASK_UPDATED':
    case 'TASK_UPDATE':
      updateTaskInPanel(msg.task);
      _updateTasksByTarget(msg.task);
      refreshTaskCellByTargetId(msg.task);
      break;

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

    // ── Синк целей подтверждён — обновляем локальные поля в UI ──────────
    case 'TARGETS_SYNCED':
    case 'TARGETS_LIST': {
      const rows = msg.rows || [];
      if (!rows.length) break;
      rows.forEach(target => {
        const eid = String(target.entity_id);
        // Обновляем _mediaFlags из SQLite
        if (target.has_photo !== undefined) _mediaFlags[eid + '_photo'] = !!target.has_photo;
        if (target.has_video !== undefined) _mediaFlags[eid + '_video'] = !!target.has_video;
        // Обновляем DOM если строка видна
        const row = document.querySelector(`#statusTable tr[data-target-id="${eid}"]`);
        if (!row) return;
        // Адрес — col 3
        if (target.address) {
          const placeSpan = row.cells[3]?.querySelector('span');
          if (placeSpan && !placeSpan.innerText) {
            placeSpan.innerText = target.address;
            placeSpan.title     = target.address;
          }
        }
        // Медиа-кнопки
        _applyMediaFlags(row, eid);
      });
      console.log(`[ws] ${msg.type}: обновлено ${rows.length} целей`);

      // После TARGETS_SYNCED — SQLite уже содержит актуальные данные.
      // Запрашиваем адреса для видимых строк (решает проблему новых целей).
      setTimeout(async () => {
        const visibleRows = document.querySelectorAll('#statusTable tbody tr[data-target-id]');
        if (!visibleRows.length) return;
        const entityIds = [...visibleRows].map(r => r.getAttribute('data-target-id')).filter(Boolean);
        try {
          const localRes = await new Promise(resolve =>
            chrome.runtime.sendMessage({ type: 'GET_LOCAL_TARGETS', entityIds }, (res) => {
              if (chrome.runtime.lastError) resolve({ ok: false });
              else resolve(res || { ok: false });
            })
          );
          if (!localRes?.ok || !localRes.targets) return;
          for (const [eid, local] of Object.entries(localRes.targets)) {
            const row = document.querySelector(`#statusTable tr[data-target-id="${eid}"]`);
            if (!row) continue;
            // Адрес — обновляем если пришёл и ячейка пустая
            if (local.address) {
              const span = row.cells[3]?.querySelector('span');
              if (span && !span.innerText) {
                span.innerText = local.address;
                span.title     = local.address;
              }
            }
            // Медиа-флаги
            if (local.has_photo !== undefined) _mediaFlags[eid + '_photo'] = !!local.has_photo;
            if (local.has_video !== undefined) _mediaFlags[eid + '_video'] = !!local.has_video;
            _applyMediaFlags(row, eid);
          }
        } catch {}
      }, 300);

      break;
    }

    // ── Один объект обновлён (адрес, медиа, заметки) ─────────────────────
    case 'TARGET_UPDATED': {
      // Поддержка обоих форматов: { entity_id, address } и { target: { entity_id, address } }
      const eid = String(msg.entity_id || msg.target?.entity_id || '');
      if (!eid) break;

      const hasPhoto = msg.has_photo ?? msg.target?.has_photo;
      const hasVideo = msg.has_video ?? msg.target?.has_video;
      const address  = msg.address  ?? msg.target?.address;

      if (hasPhoto !== undefined) _mediaFlags[eid + '_photo'] = !!hasPhoto;
      if (hasVideo !== undefined) _mediaFlags[eid + '_video'] = !!hasVideo;

      const row = document.querySelector(`#statusTable tr[data-target-id="${eid}"]`);
      if (!row) break;

      // Адрес — обновляем всегда когда пришёл
      if (address !== undefined) {
        const placeSpan = row.cells[3]?.querySelector('span');
        if (placeSpan) {
          placeSpan.innerText = address || '';
          placeSpan.title     = address || 'Адрес не указан';
        }
      }

      // Медиа-кнопки
      _applyMediaFlags(row, eid);
      break;
    }

    case 'AUTH_ERROR':
      console.warn('[ws] AUTH_ERROR:', msg.text);
      break;

    case 'DRAFT_CHECK_RESULT': {
      if (msg.hasDraft) addDraftDateBtn(msg.planDate);
      break;
    }

    case 'DRAFT_PLANS_RESULT': {
      const pending = window._pendingPublish;
      if (!pending) break;
      window._pendingPublish = null;
      executePlanPublish(pending.planDate, msg.plans || [], pending.folderId);
      break;
    }

    case 'PLAN_PUBLISHED':
      showToast('✅ План опубликован', 'success');
      break;

    case 'ERROR':
      showToast('Сервер: ' + (msg.text || 'ошибка'), 'error');
      break;

    default:
      break;
  }
}

// ── Вспомогательная — обновляет медиа-кнопки в строке по _mediaFlags ─────────
function _applyMediaFlags(row, entityId) {
  const mediaWrap = row.querySelector('.media-btns');
  if (!mediaWrap) return;
  mediaWrap.querySelectorAll('button[data-media]').forEach(btn => {
    const mediaType = btn.dataset.media;
    const on    = !!_mediaFlags[entityId + '_' + mediaType];
    const count = _mediaFlags[entityId + '_' + mediaType + '_count'] || 0;
    const emoji = mediaType === 'photo' ? '📷' : '🎥';

    btn.innerHTML = count > 0
      ? `${emoji} <span style="font-size:9px;">${count}</span>`
      : emoji;
    btn.title = on
      ? `${mediaType === 'photo' ? 'Фото' : 'Видео'}: ${count} шт. — клик для галереи`
      : `Нет ${mediaType === 'photo' ? 'фото' : 'видео'} — клик для добавления`;
    btn.style.background = on ? '#28a745' : '#dee2e6';
    btn.style.color      = on ? 'white'   : '#aaa';
    btn.style.opacity    = on ? '1'       : '0.6';
  });
}