// Время звука и видео для глаз: 0:07, 1:40, 1:02:03. Не число — «0:00».
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// То же для скринридера: «1 минута 40 секунд» читается лучше, чем «1:40».
export function sayTime(seconds) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const plural = (n, one, few, many) => {
    const tail = n % 100;
    if (tail > 10 && tail < 20) return many;
    if (n % 10 === 1) return one;
    return n % 10 > 1 && n % 10 < 5 ? few : many;
  };
  const parts = [];
  if (m) parts.push(`${m} ${plural(m, 'минута', 'минуты', 'минут')}`);
  if (s || !m) parts.push(`${s} ${plural(s, 'секунда', 'секунды', 'секунд')}`);
  return parts.join(' ');
}
