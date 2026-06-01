// content/ui/roleSelector.js
// Модал выбора расчёта вручную + звуковое уведомление.
// Показывается когда сервер не может определить роль автоматически (NEED_ROLE).
// Зависимости: wsSend (wsClient.js), ROLE_TO_USERS (config.js)

function showRoleSelector(validRoles) {
  document.querySelector('#manual-role-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'manual-role-modal';
  modal.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.7);
    display:flex;align-items:center;justify-content:center;z-index:100000;
    font-family:system-ui,sans-serif;
  `;
  modal.innerHTML = `
    <div style="background:white;border-radius:12px;padding:24px;width:320px;text-align:center;">
      <h3 style="margin:0 0 8px;color:#1e3a5f;">Выберите свой расчёт</h3>
      <p style="font-size:13px;color:#666;margin:0 0 16px;">
        Не удалось определить автоматически из профиля AstraMap
      </p>
      <div id="role-btn-list" style="display:flex;flex-direction:column;gap:8px;"></div>
    </div>
  `;

  // Кнопки через addEventListener — onclick не работает в изолированном контексте
  const list = modal.querySelector('#role-btn-list');
  validRoles.forEach(role => {
    const btn = document.createElement('button');
    btn.style.cssText = 'padding:10px;background:#1e3a5f;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px;text-align:left;';
    btn.textContent = role.charAt(0).toUpperCase() + role.slice(1);
    btn.addEventListener('click', () => selectRoleManually(role));
    list.appendChild(btn);
  });

  document.body.appendChild(modal);
}

function selectRoleManually(role) {
  document.querySelector('#manual-role-modal')?.remove();
  wsSend({
    type: 'REGISTER',
    userId:      myUserId,
    username:    myUsername,
    displayName: myDisplayName,
    role,
  });
}

// Звуковой сигнал при получении новой задачи.
// AudioContext требует жест пользователя — создаём контекст один раз
// после первого взаимодействия со страницей (click/keydown).
let _audioCtx = null;
document.addEventListener('click', () => {
  if (!_audioCtx) {
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
}, { once: false, passive: true });

function playNotificationSound() {
  try {
    const ctx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880,  ctx.currentTime);
    osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.4);
  } catch {}
}
