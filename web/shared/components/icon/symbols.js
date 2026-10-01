// Символы спрайта по адресу файла: один запрос на файл, дальше — из памяти.
// Файл разбирается XML-парсером: это наш ресурс, а не HTML-строка, и
// скрипты в разобранном документе не выполняются.
const files = new Map();

function parse(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  return new Map([...doc.querySelectorAll('symbol[id]')].map((symbol) => [symbol.id, symbol]));
}

async function request(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Спрайт ${url}: ${response.status}`);
  return parse(await response.text());
}

/** Map id → <symbol> из файла спрайта. Неудачный запрос не кэшируется. */
export function loadSymbols(url) {
  if (!files.has(url)) {
    const pending = request(url);
    pending.catch(() => files.delete(url));
    files.set(url, pending);
  }
  return files.get(url);
}
