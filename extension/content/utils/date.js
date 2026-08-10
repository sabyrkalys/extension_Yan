// content/utils/date.js
// Все операции с датой и временем. Московский часовой пояс = UTC+3.

// Текущая дата по МСК в формате YYYY-MM-DD
function getMoscowDateStr() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
}

// Текущее время по МСК в формате HH:MM
function getMoscowTimeStr() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000)
    .toISOString().slice(11, 16);
}

// Текущий момент как ISO UTC (для записи в БД)
function getMoscowNowISO() {
  return new Date().toISOString();
}

// Дата + время (МСК) → ISO UTC строка
// Пользователь вводит время в МСК — вычитаем 3 часа для UTC
function toISOWithTime(dateStr, timeStr) {
  try {
    if (!dateStr) return getMoscowNowISO();
    const time = timeStr && timeStr.trim() ? timeStr : '00:00';
    const [hours, minutes] = time.split(':').map(Number);
    const [year, month, day] = dateStr.split('-').map(Number);
    const utcMs = Date.UTC(year, month - 1, day, hours - 3, minutes, 0, 0);
    return new Date(utcMs).toISOString();
  } catch {
    return getMoscowNowISO();
  }
}

// UTC ISO строка → МСК время HH:MM
function utcIsoToMskTime(isoStr) {
  if (!isoStr) return '';
  try {
    const mskMs = new Date(isoStr).getTime() + 3 * 60 * 60 * 1000;
    return new Date(mskMs).toISOString().slice(11, 16);
  } catch { return ''; }
}

// UTC ISO строка → МСК дата YYYY-MM-DD
function utcIsoToMskDate(isoStr) {
  if (!isoStr) return '';
  try {
    const mskMs = new Date(isoStr).getTime() + 3 * 60 * 60 * 1000;
    return new Date(mskMs).toISOString().slice(0, 10);
  } catch { return ''; }
}

// Границы календарного дня (МСК) в UTC ISO — для relevantUpdatedAtFilter
// в поиске AstraMap (gte/lte), напр. {gte:"2026-08-09T21:00:00.000Z", lte:"2026-08-10T20:59:59.999Z"}
function mskDateRangeToUtcISO(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const gte = new Date(Date.UTC(year, month - 1, day, -3, 0, 0, 0)).toISOString();
  const lte = new Date(Date.UTC(year, month - 1, day, 20, 59, 59, 999)).toISOString();
  return { gte, lte };
}
