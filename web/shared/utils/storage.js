// localStorage для удобств одного зрителя (тема, раскрытое меню). В приватном
// режиме или при запрете хранилища доступ бросает — тогда просто не помним.
export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },

  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Хранилище недоступно — настройка проживёт до перезагрузки.
    }
  },
};
