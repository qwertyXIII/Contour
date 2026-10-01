// Шапка «как на iPhone» (блок masthead): крупно по центру, при прокрутке фото и
// имя уменьшаются и переезжают в полосу «фото слева, имя справа», которая
// остаётся наверху.
//
// Движение — прямое, от пальца: доля сжатия — это доля пути прокрутки до места,
// где шапка прилипает. Пружины здесь нет и быть не должно — палец и есть кривая.
// Поэтому не motion.js, а одна переменная: при прокрутке пишется только
// --masthead-p, и только на самой шапке (переменная на корне пересчитала бы
// стили всего экрана — handbook, «Производительность»). Куда ехать каждой части,
// меряется один раз и при смене размера: прокрутка раскладку не трогает вовсе.
//
// «Меньше движения» — не оживает: шапка остаётся крупной и уезжает с экраном.
//
// Постер (masthead_view_poster) — то же движение, только фото — прямоугольник во
// всю ширину, и сжимается он в две фазы: сначала по центру в крупный круг над
// именем, потом круг едет в шапку — слева, имя и строка справа от него — и мельчает.
// Какой квадрат постера станет кругом и какой у круга радиус, меряется здесь же
// (--masthead-cx / -ct / -cb / -r у фото), а срезает CSS к той же доле.
import { MASTHEAD } from '../../utils/constants.js';
import { reduced } from '../../utils/motion.js';

const px = (value) => `${value.toFixed(2)}px`;

/** Ближайший предок, который прокручивается; нет — страница. */
function scrollParent(el) {
  for (let at = el.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === 'auto' || overflowY === 'scroll') return at;
  }
  return document.scrollingElement;
}

export class Masthead {
  #root;
  #view = null;
  #resize = null;
  #frame = 0;
  #pinAt = 1;
  #p = -1;
  #stop = () => {};
  #onScroll = () => {
    if (!this.#frame) this.#frame = requestAnimationFrame(() => this.#update());
  };

  constructor(root) {
    this.#root = root;
  }

  init() {
    if (reduced() || !this.#root.querySelector('.masthead__title')) return this;
    this.#view = scrollParent(this.#root);
    this.#root.classList.add(MASTHEAD.live);
    // Размер меняется, когда экран показали (он собирается спрятанным) и когда
    // сменилась ширина: тогда и меряем, а прокрутка только пишет долю.
    this.#resize = new ResizeObserver(() => this.#measure());
    this.#resize.observe(this.#root);
    const target = this.#view === document.scrollingElement ? window : this.#view;
    target.addEventListener('scroll', this.#onScroll, { passive: true });
    this.#stop = () => target.removeEventListener('scroll', this.#onScroll);
    return this;
  }

  // Экран ушёл: тело панели живёт дальше, и слушать его прокрутку больше незачем.
  #alive() {
    if (this.#root.isConnected) return true;
    this.#stop();
    this.#resize?.disconnect();
    cancelAnimationFrame(this.#frame);
    return false;
  }

  /**
   * Где части стоят крупно и где им стоять в полосе. Меряется без липкости: у
   * прилипшей шапки положение — прилипшее, а нужно своё место в экране.
   */
  #measure() {
    if (!this.#alive()) return;
    const root = this.#root;
    root.classList.remove(MASTHEAD.live);
    const height = root.offsetHeight;
    const width = root.clientWidth;
    const view = this.#view;
    const viewTop = view === document.scrollingElement ? 0 : view.getBoundingClientRect().top + view.clientTop;
    const natural = root.getBoundingClientRect().top - viewTop + view.scrollTop;
    const parts = ['lead', 'title', 'note'].map((name) => root.querySelector(`.masthead__${name}`));
    // Без липкости у частей и шапки один offsetParent: место части — разность.
    const boxes = parts.map((el) => el && {
      x: el.offsetLeft - root.offsetLeft, y: el.offsetTop - root.offsetTop, w: el.offsetWidth, h: el.offsetHeight,
    });
    root.classList.add(MASTHEAD.live);
    if (!height || !boxes[0] || !boxes[1]) return;

    const style = getComputedStyle(root);
    const strip = parseFloat(style.getPropertyValue('--masthead-strip')) || MASTHEAD.strip;
    const photo = parseFloat(style.getPropertyValue('--masthead-photo-compact')) || MASTHEAD.photo;
    const titleScale = parseFloat(style.getPropertyValue('--masthead-title-s')) || MASTHEAD.titleScale;
    const band = height - strip;
    const geo = { band, strip, photo, titleScale, width, height, natural, style, gutter: this.#gutter() };
    if (root.classList.contains(MASTHEAD.poster)) this.#poster(parts, boxes, geo);
    else this.#row(parts, boxes, geo);

    // Липнет так, что видна только полоса у самого верха; отступ сверху у тела
    // прокрутки липкость отсчитывает от себя — его и вычитаем.
    const pad = view === document.scrollingElement ? 0 : parseFloat(getComputedStyle(view).paddingTop) || 0;
    root.style.setProperty('--masthead-top', px(strip - height - pad));
    this.#pinAt = Math.max(1, natural + band);
    this.#p = -1;
    this.#update();
  }

  /** Обычная шапка: фото — к левому краю полосы, по её середине; текст — справа от него столбиком. */
  #row(parts, [lead, title, note], { band, strip, photo, titleScale, width, gutter }) {
    this.#place(parts[0], gutter - lead.x, band + (strip - photo) / 2 - lead.y, photo / Math.min(lead.w, lead.h));
    // Длинное сжимается, чтобы влезть.
    const left = gutter + photo + MASTHEAD.gap;
    const room = Math.max(1, width - left - gutter);
    const ts = Math.min(titleScale, room / title.w);
    const ns = note ? Math.min(1, room / note.w) : 1;
    const block = title.h * ts + (note ? MASTHEAD.lineGap + note.h * ns : 0);
    const top = band + (strip - block) / 2;
    this.#place(parts[1], left - title.x, top - title.y, ts);
    if (note) this.#place(parts[2], left - note.x, top + title.h * ts + MASTHEAD.lineGap - note.y, ns);
  }

  /**
   * Постер — в две фазы одной доли (CSS делит --masthead-p на них в «колене»
   * --masthead-knee): сначала его квадрат сжимается и срезается в крупный круг
   * (--masthead-photo-poster) по центру места под шапкой, имя и строка — под ним по
   * центру; потом готовый круг едет в полосу — слева, сразу за «назад» шапки
   * навигатора (--masthead-start), — и мельчает, имя и строка переезжают вправо от
   * него, как в первой шапке. Квадрат — по ширине из середины, по высоте вокруг
   * середины места над именем (там лицо на фото и буквы без фото, туда же встают
   * буквы: --masthead-focus). В первой фазе путь вбок и уменьшение идут одной
   * долей — круг по центру всю дорогу.
   */
  #poster(parts, [lead, title, note], { band, strip, photo, titleScale, width, height, natural, style, gutter }) {
    const side = Math.min(lead.w, lead.h);
    const focus = (title.y - lead.y) / 2;
    const crop = { x: (lead.w - side) / 2, y: Math.min(Math.max(focus - side / 2, 0), lead.h - side) };
    const set = (name, value) => parts[0].style.setProperty(name, px(value));
    set('--masthead-cx', crop.x);
    set('--masthead-ct', crop.y);
    set('--masthead-cb', lead.h - side - crop.y);
    set('--masthead-r', side / 2);
    set('--masthead-focus', lead.h / 2 - focus);
    const read = (name, fallback) => {
      const value = parseFloat(style.getPropertyValue(name));
      return Number.isFinite(value) ? value : fallback;
    };
    const knee = read('--masthead-knee', MASTHEAD.knee);
    const big = read('--masthead-photo-poster', MASTHEAD.posterPhoto);
    const titleMid = read('--masthead-title-m', MASTHEAD.titleMid);
    const noteScale = read('--masthead-note-s', 1);
    const start = read('--masthead-start', 0);
    const rowPad = read('--masthead-row-pad', 0);

    // Колено: круг, имя и строка — по середине того, что видно под шапкой, когда
    // прокрутили на долю колена (координаты — от верха шапки-постера).
    const seen = knee * Math.max(1, natural + band) - natural + strip;
    const tm = Math.min(titleMid, Math.max(1, width - 2 * gutter) / title.w);
    const nm = note ? Math.min(1, Math.max(1, width - 2 * gutter) / note.w) : 1;
    const midBlock = big + MASTHEAD.posterGap + title.h * tm + (note ? note.h * nm : 0);
    const mid = seen + Math.max(0, (height - seen - midBlock) / 2);
    const midUnder = mid + big + MASTHEAD.posterGap;
    // Конец: строка шапки — круг слева за «назад», справа от него имя и строка связи,
    // по середине ряда кнопок; справа им отдано столько же, сколько «…».
    const left = gutter + start;
    const center = band + strip - rowPad - photo / 2;
    const textLeft = left + photo + MASTHEAD.gap;
    const room = Math.max(1, width - textLeft - left);
    const ts = Math.min(titleScale, room / title.w);
    const ns = note ? Math.min(noteScale, room / note.w) : 1;
    const top = center - (title.h * ts + (note ? MASTHEAD.lineGap + note.h * ns : 0)) / 2;

    // Круг: из квадрата постера — крупным по центру в колене, маленьким слева в конце.
    const circle = (size, x, y) => ({ s: size / side, dx: x - lead.x - crop.x * (size / side), dy: y - lead.y - crop.y * (size / side) });
    this.#phases(parts[0], circle(big, (width - big) / 2, mid), circle(photo, left, center - photo / 2));
    // Имя и строка: по центру под крупным кругом — и вправо от маленького, мельче.
    const at = (box, scale, x, y) => ({ s: scale, dx: x - box.x, dy: y - box.y });
    this.#phases(parts[1], at(title, tm, (width - title.w * tm) / 2, midUnder), at(title, ts, textLeft, top));
    if (note) {
      this.#phases(parts[2], at(note, nm, (width - note.w * nm) / 2, midUnder + title.h * tm),
        at(note, ns, textLeft, top + title.h * ts + MASTHEAD.lineGap));
    }
  }

  /** Путь части в две фазы: к колену (`mid`) и от него к концу (`end`) — второе приращением. */
  #phases(el, mid, end) {
    this.#place(el, mid.dx, mid.dy, mid.s);
    el.style.setProperty('--masthead-dx2', px(end.dx - mid.dx));
    el.style.setProperty('--masthead-dy2', px(end.dy - mid.dy));
    el.style.setProperty('--masthead-s2', end.s.toFixed(4));
  }

  /**
   * Поле слева, на которое шапка вышла за край места (постер во всю ширину): столько
   * же отступает содержимое экрана — полоса держит тот же край. Без выхода — ноль.
   */
  #gutter() {
    const view = this.#view;
    if (view === document.scrollingElement) return 0;
    const content = view.getBoundingClientRect().left + view.clientLeft + (parseFloat(getComputedStyle(view).paddingLeft) || 0);
    return Math.max(0, content - this.#root.getBoundingClientRect().left);
  }

  #place(el, dx, dy, s) {
    el.style.setProperty('--masthead-dx', px(dx));
    el.style.setProperty('--masthead-dy', px(dy));
    el.style.setProperty('--masthead-s', s.toFixed(4));
  }

  #update() {
    this.#frame = 0;
    if (!this.#alive()) return;
    const top = this.#view.scrollTop;
    const p = Math.min(1, Math.max(0, top / this.#pinAt));
    // Писать только перемену: та же доля — та же строка стилей, пересчёт зря.
    if (Math.abs(p - this.#p) < MASTHEAD.epsilon) return;
    this.#p = p;
    this.#root.style.setProperty('--masthead-p', p.toFixed(4));
  }
}
