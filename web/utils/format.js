// Числа для человека: байты, скорость, время назад.

const NUM = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

export function bytes(n) {
  if (!n) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${NUM.format(v < 10 && i > 0 ? Math.round(v * 10) / 10 : Math.round(v))} ${units[i]}`;
}

/** Скорость — в битах, как её привыкли видеть: «12,4 Мбит/с». */
export function speed(bytesPerSec) {
  const bits = (bytesPerSec ?? 0) * 8;
  if (bits < 1_000) return `${Math.round(bits)} бит/с`;
  if (bits < 1_000_000) return `${NUM.format(bits / 1_000)} кбит/с`;
  return `${NUM.format(bits / 1_000_000)} Мбит/с`;
}

export function ago(ts) {
  if (!ts) return 'ни разу';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'только что';
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86_400) return `${Math.round(s / 3600)} ч назад`;
  return `${Math.round(s / 86_400)} дн назад`;
}

export function secondsAgo(s) {
  if (s === null || s === undefined) return '—';
  return ago(Date.now() - s * 1000);
}

export function time(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function dateTime(ts) {
  return new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Число со словом в нужной форме: plural(3, ['правило', 'правила', 'правил']) → «3 правила». */
export function plural(n, [one, few, many]) {
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${word}`;
}
