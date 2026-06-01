// content/store/store.js
// Единое хранилище состояния расширения.
// Заменяет россыпь глобальных переменных в content.js.
//
// Использование:
//   store.get('myRole')          → значение
//   store.set('myRole', 'рэб')  → обновить + уведомить подписчиков
//   store.on('myRole', fn)       → подписаться на изменения

const store = (() => {
  const _state = {
    // Текущий пользователь
    myRole:        null,
    myUsername:    null,
    myDisplayName: null,
    myUserId:      null,

    // Активная папка (выбранная дата)
    activeFolderId:   null,
    activeFolderDate: null,

    // Крайняя (последняя) папка
    latestFolderId:   null,
    latestFolderDate: null,

    // Задачи
    unreadTaskCount: 0,
    seenTaskIds:     new Set(),     // ✅ инициализация
    tasksByTarget:   {},            // ✅ инициализация

    // UI-состояние
    isPopupVisible: false,
  };

  const _listeners = {};

  return {
    get(key) {
      return _state[key];
    },

    set(key, value) {
      _state[key] = value;
      if (_listeners[key]) {
        _listeners[key].forEach(fn => { try { fn(value); } catch {} });
      }
    },

    // Удобный метод для мутации объектов/множеств без полной замены
    update(key, fn) {
      fn(_state[key]);
      if (_listeners[key]) {
        _listeners[key].forEach(cb => { try { cb(_state[key]); } catch {} });
      }
    },

    on(key, fn) {
      if (!_listeners[key]) _listeners[key] = [];
      _listeners[key].push(fn);
    },
  };
})();