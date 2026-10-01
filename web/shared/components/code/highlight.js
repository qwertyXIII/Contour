// Подсветка кода — общая для всех поверхностей: блок кода в разметке Markdown,
// файл с кодом в просмотре, дальше — шаги трассировки, ответы Alter'а.
//
// Библиотека — highlight.js (vendor/highlight, BSD-3): ядро и грамматики языков
// отдельными модулями. Грузится по требованию: ядро — при первом коде на экране,
// язык — когда он встретился (25 ходовых, остальные — простым текстом). Разметку
// highlight.js отдаёт уже экранированной — чужой код HTML не станет.
//
// Цвета — классы `hljs-*`, раскрашивает блок code (токены темы), своих стилей
// библиотеки не берём.

/** Имя грамматики по языку или расширению: у людей и файлов имена разные. */
const ALIASES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', javascript: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', typescript: 'typescript',
  json: 'json', jsonc: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'shell', console: 'shell',
  py: 'python', python: 'python',
  css: 'css', scss: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  sql: 'sql', psql: 'sql',
  yml: 'yaml', yaml: 'yaml',
  md: 'markdown', markdown: 'markdown',
  go: 'go', rs: 'rust', rust: 'rust', java: 'java', kt: 'kotlin', kotlin: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', csharp: 'csharp',
  php: 'php', rb: 'ruby', ruby: 'ruby', diff: 'diff', patch: 'diff',
  ini: 'ini', toml: 'ini', conf: 'ini', env: 'ini', dockerfile: 'dockerfile', docker: 'dockerfile',
  txt: 'plaintext', text: 'plaintext', plaintext: 'plaintext',
};

const VENDOR = new URL('../../vendor/highlight/', import.meta.url);

let core = null;
const languages = new Map(); // имя грамматики → обещание регистрации

/** Грамматика по языку или расширению; не знаем — `null` (простой текст). */
export function languageOf(name) {
  return ALIASES[String(name ?? '').trim().toLowerCase().replace(/^\./, '')] ?? null;
}

async function engine() {
  core ??= import(new URL('core.min.js', VENDOR).href).then((module) => module.default);
  return core;
}

async function withLanguage(name) {
  const hljs = await engine();
  if (!languages.has(name)) {
    languages.set(name, import(new URL(`languages/${name}.min.js`, VENDOR).href)
      .then((module) => hljs.registerLanguage(name, module.default))
      .catch(() => languages.delete(name)));
  }
  await languages.get(name);
  return hljs.getLanguage(name) ? hljs : null;
}

/** Подсвеченная разметка текста; язык не знаем — `null`, показывать как есть. */
export async function highlightText(text, lang) {
  const name = languageOf(lang);
  if (!name || name === 'plaintext') return null;
  const hljs = await withLanguage(name);
  return hljs ? hljs.highlight(text, { language: name, ignoreIllegals: true }).value : null;
}

/**
 * Подсветить элемент кода на месте: его текст — источник, разметка — поверх.
 * Язык — аргументом или из класса `language-*` (так его ставит Markdown).
 */
export async function highlightElement(el, lang) {
  const fromClass = [...el.classList].find((c) => c.startsWith('language-'))?.slice('language-'.length);
  const html = await highlightText(el.textContent, lang ?? fromClass);
  if (html === null) return false;
  el.innerHTML = html;
  el.classList.add('code_lit');
  return true;
}
