// Звук для кольца: сеанс музыки, чей звук играет здесь же, объявляет под своим
// именем функцию «спектр сейчас» — read(count) → count чисел 0…1, от низких к
// высоким. Кольцо спрашивает по имени сеанса. Нет функции — звук играет не
// здесь (Spotify на телевизоре) или разбор не разрешён, и кольцо дышит само.
const taps = new Map();

export function registerTap(session, read) {
  taps.set(session, read);
}

export function dropTap(session) {
  taps.delete(session);
}

export function tapOf(session) {
  return taps.get(session) ?? null;
}
