// Markdown — в разметку системы (блок prose), общий для всех поверхностей:
// документ в просмотре файлов, дальше — ответы Alter'а, описания.
//
// Библиотеки: marked (разбор, MIT) и DOMPurify (чистка, Apache-2.0/MPL-2.0) — из
// vendor, грузятся по требованию: разметка нужна не на каждом экране.
//
// ⚠️ Текст бывает чужим: файл прислал незнакомец в бизнес-чате. Поэтому HTML
// после разбора всегда проходит чистку, и сверх неё:
//   - картинок нет (`<img>` — ни своего, ни чужого адреса): картинка с чужого
//     адреса сказала бы отправителю, что файл открыли, и где. На месте — её подпись;
//   - ссылки открываются в новом окне и не передают, откуда пришли;
//   - блоки кода подсвечиваются (components/code/highlight.js).
import { highlightElement } from '../code/highlight.js';

const VENDOR = new URL('../../vendor/', import.meta.url);

let tools = null;

async function load() {
  tools ??= Promise.all([
    import(new URL('marked/marked.esm.js', VENDOR).href),
    import(new URL('dompurify/purify.es.js', VENDOR).href),
  ]).then(([{ Marked }, { default: DOMPurify }]) => {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName !== 'A') return;
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    });
    // Свой разборщик, а не общий `marked`: настройки не текут к чужим вызовам.
    const parser = new Marked({ gfm: true, breaks: true }, IMAGE_AS_TEXT);
    return { parser, DOMPurify };
  });
  return tools;
}

/** Картинку Markdown — подписью: `![чек](url)` → «чек». */
const IMAGE_AS_TEXT = { renderer: { image: ({ text }) => (text ? `<span class="prose__image">${escape(text)}</span>` : '') } };

function escape(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Нарисовать Markdown в элементе: он становится блоком prose. Возвращает
 * обещание — когда разметка и подсветка на месте.
 */
export async function renderMarkdown(el, text) {
  const { parser, DOMPurify } = await load();
  const html = DOMPurify.sanitize(parser.parse(String(text ?? '')), {
    FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input', 'button', 'video', 'audio', 'source', 'picture'],
    FORBID_ATTR: ['style'],
  });
  el.classList.add('prose');
  el.innerHTML = html;
  // Таблица шире экрана листается вбок сама, а не растягивает страницу.
  el.querySelectorAll('table').forEach((table) => {
    const wrap = document.createElement('div');
    wrap.className = 'prose__table';
    table.replaceWith(wrap);
    wrap.append(table);
  });
  await Promise.all([...el.querySelectorAll('pre code')].map((code) => {
    code.classList.add('code', 'code_block');
    return highlightElement(code);
  }));
  return el;
}
