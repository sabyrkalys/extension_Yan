// content/ui/toast.js
// Уведомления: лёгкий toast и большой попап новой задачи.
// Зависимости: нет (вызывает acceptTask/rejectTask из content/ui/tasks.js)

function showToast(text, type = 'info') {
  const colors = { info: '#17a2b8', success: '#28a745', error: '#dc3545', task: '#fd7e14' };
  const toast = document.createElement('div');
  toast.style.cssText = `
    position:fixed;bottom:20px;right:20px;z-index:99999;
    background:${colors[type] || colors.info};color:white;
    padding:12px 18px;border-radius:8px;font-size:14px;
    box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:320px;
    animation:slideInToast 0.3s ease;font-family:system-ui,sans-serif;
  `;
  toast.textContent = text;
  if (!document.querySelector('#toast-style')) {
    const s = document.createElement('style');
    s.id = 'toast-style';
    s.textContent = '@keyframes slideInToast{from{transform:translateX(120%)}to{transform:translateX(0)}}';
    document.head.appendChild(s);
  }
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// Большой попап при получении новой задачи — с кнопками «Принять/Отклонить»
function renderTaskNotification(task) {
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed;top:80px;right:20px;z-index:99998;
    background:white;border-left:4px solid #fd7e14;
    border-radius:8px;padding:16px 20px;width:300px;
    box-shadow:0 6px 24px rgba(0,0,0,0.2);font-family:system-ui,sans-serif;
    animation:slideInToast 0.3s ease;
  `;
  const fromName  = task.from_role || task.from || '?';
  const targetHint = task.targetTitle || task.target_title || '';

  el.innerHTML = `
    <div style="font-weight:600;color:#fd7e14;margin-bottom:6px;">📋 Новая задача от: ${fromName}</div>
    <div style="font-size:13px;color:#333;margin-bottom:4px;">${task.text}</div>
    ${targetHint ? `<div style="font-size:12px;color:#666;">Объект: ${targetHint}</div>` : ''}
    <div style="display:flex;gap:8px;margin-top:12px;">
      <button class="notif-accept" style="flex:1;padding:6px;background:#28a745;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">✅ Принять</button>
      <button class="notif-reject" style="flex:1;padding:6px;background:#dc3545;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">❌ Отклонить</button>
    </div>
  `;

  el.querySelector('.notif-accept').addEventListener('click', () => { acceptTask(task.id); el.remove(); });
  el.querySelector('.notif-reject').addEventListener('click', () => { rejectTask(task.id); el.remove(); });

  document.body.appendChild(el);
  setTimeout(() => el.remove(), 15000);
}
