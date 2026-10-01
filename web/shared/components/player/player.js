// Вид музыкального плеера: виджет, экран «Сейчас играет», ТВ. Вид ничем не
// владеет — рисует player:state своего сеанса (data-session) и шлёт ему
// player:command. Обновляет только то, что есть в его разметке: у виджета
// 4×1 нет очереди и громкости, у ТВ — кнопок.
//
// Позиция между сообщениями сеанса досчитывается по часам (position + прошедшее
// с at), поэтому полоса едет плавно и от сеанса, который сообщает о себе раз
// в несколько секунд (Spotify).
//
// Сменился трек — название и исполнитель уезжают туда, откуда пришли бы
// предыдущие, новые приезжают с другой стороны; обложка перетекает в новую.
//
// Кадры время и полоса считают, только пока вид на экране: видов одного сеанса
// бывает несколько (виджет, экран, ТВ), и тот, что за краем, крутился бы зря.
import { EVENTS, PLAYER } from '../../utils/constants.js';
import { emit, h, setIcon, svgIcon } from '../../utils/dom.js';
import { appear, leave, swap } from '../../utils/motion.js';
import { formatTime, sayTime } from '../../utils/time.js';

export class Player {
  #root;
  #session;
  #parts;
  #state = null;
  #queueKey = '';
  #frame = 0;
  #scrubbing = false;
  #swapping = false;
  #ghost = null;
  #seen = true;

  constructor(root) {
    this.#root = root;
    this.#session = root.dataset.session;
    const part = (name) => root.querySelector(`.player__${name}`);
    this.#parts = {
      title: part('title'), artist: part('artist'), source: part('source'), cover: part('cover'),
      now: part('time_kind_now'), total: part('time_kind_total'), line: part('line'), next: part('next'),
      queue: part('queue'), seek: part('seek'), volume: part('volume'), badge: part('badge'),
    };
  }

  init() {
    document.addEventListener(EVENTS.playerState, (event) => {
      if (event.detail.session === this.#session) this.#render(event.detail);
    });
    this.#root.addEventListener('click', (event) => this.#onClick(event));
    this.#bindRange(this.#parts.seek, 'seek', (value) => Number(value));
    this.#bindRange(this.#parts.volume, 'volume', (value) => Number(value) / 100);
    this.#command('sync');
    new IntersectionObserver(([entry]) => {
      this.#seen = entry.isIntersecting;
      if (!this.#seen || !this.#state) return;
      this.#paint();
      if (this.#state.playing) this.#tick();
    }).observe(this.#root);
    return this;
  }

  #command(action, value) {
    emit(this.#root, EVENTS.playerCommand, { session: this.#session, action, value });
  }

  #onClick(event) {
    const button = event.target.closest('[data-command]');
    if (button) this.#command(button.dataset.command);
    const track = event.target.closest('.player__track');
    if (track) this.#command('select', Number(track.dataset.index));
  }

  // Перемотка и громкость — нативный range: пока палец на нём, сеанс не
  // перетягивает ручку назад своими сообщениями.
  #bindRange(root, action, read) {
    const input = root?.querySelector('.range__input');
    if (!input) return;
    input.addEventListener('input', () => {
      this.#scrubbing = action === 'seek';
      this.#command(action, read(input.value));
    });
    input.addEventListener('change', () => { this.#scrubbing = false; });
  }

  #render(state) {
    const turn = this.#turn(this.#state, state);
    this.#state = state;
    const { source, cover, next } = this.#parts;
    const has = state.index >= 0 && state.title;
    this.#root.classList.toggle(PLAYER.playing, state.playing);
    this.#root.classList.toggle(PLAYER.idle, !has);
    if (turn) this.#swapTrack(turn);
    else if (!this.#swapping) this.#names();
    if (source) source.textContent = state.source;
    if (cover && turn) this.#flowCover(cover, state.cover);
    else if (cover && !this.#ghost) this.#cover(cover, state.cover);
    if (next) next.textContent = this.#upNext(state);
    this.#buttons(state);
    this.#queue(state);
    this.#volume(state);
    this.#paint();
    cancelAnimationFrame(this.#frame);
    if (state.playing) this.#tick();
  }

  #names() {
    const { title, artist } = this.#parts;
    const state = this.#state;
    const has = state.index >= 0 && state.title;
    if (title) title.textContent = has ? state.title : PLAYER.labels.nothing;
    if (artist) artist.textContent = state.artist;
  }

  // Трек сменился (а не просто пришло новое состояние): куда листнули. Через
  // край очереди — по-прежнему «вперёд» и «назад», а не через всю очередь.
  #turn(before, after) {
    if (!before?.title || !after.title || after.index < 0) return 0;
    if (before.index === after.index && before.title === after.title) return 0;
    const step = after.index - before.index;
    const edge = (after.queue?.length ?? 0) - 1;
    if (edge > 0 && Math.abs(step) === edge) return -Math.sign(step);
    return step < 0 ? -1 : 1;
  }

  #swapTrack(direction) {
    const names = [this.#parts.title, this.#parts.artist].filter(Boolean);
    if (!names.length) return;
    this.#swapping = true;
    swap(names, () => this.#names(), { direction }).then((done) => {
      if (done) this.#swapping = false;
    });
  }

  // Старая обложка остаётся сверху копией и тает, когда новая уже пришла.
  #flowCover(img, src) {
    this.#ghost?.remove();
    const ghost = img.hidden ? null : img.cloneNode();
    if (ghost) img.after(ghost);
    this.#ghost = ghost;
    this.#cover(img, src);
    const reveal = () => {
      if (this.#ghost !== ghost) return;
      appear(img, { from: 'grow' });
      if (!ghost) return;
      leave(ghost, { to: 'none', duration: 'normal' }).then(() => {
        ghost.remove();
        if (this.#ghost === ghost) this.#ghost = null;
      });
    };
    if (!src) reveal();
    else img.decode().then(reveal, reveal);
  }

  #cover(img, src) {
    img.hidden = !src;
    if (src && img.getAttribute('src') !== src) img.src = src;
  }

  #upNext({ queue, index, repeat, shuffle }) {
    if (shuffle) return '';
    const following = queue[index + 1] ?? (repeat === 'all' ? queue[0] : null);
    return following ? PLAYER.labels.upNext(following.title) : '';
  }

  #buttons(state) {
    const { icons, labels } = PLAYER;
    this.#root.querySelectorAll('[data-command="toggle"]').forEach((button) => {
      setIcon(button.querySelector('.icon'), state.playing ? icons.pause : icons.play);
      button.setAttribute('aria-label', state.playing ? labels.pause : labels.play);
    });
    this.#root.querySelectorAll('[data-command="shuffle"]').forEach((button) => {
      button.setAttribute('aria-pressed', String(state.shuffle));
    });
    this.#root.querySelectorAll('[data-command="repeat"]').forEach((button) => {
      button.setAttribute('aria-pressed', String(state.repeat !== 'off'));
      button.setAttribute('aria-label', labels.repeat[state.repeat]);
    });
    if (this.#parts.badge) this.#parts.badge.hidden = state.repeat !== 'one';
    const muted = state.muted || state.volume === 0;
    this.#root.querySelectorAll('[data-command="mute"]').forEach((button) => {
      setIcon(button.querySelector('.icon'), muted ? icons.mute : icons.sound);
      button.setAttribute('aria-label', muted ? labels.unmute : labels.mute);
    });
  }

  #volume(state) {
    const input = this.#parts.volume?.querySelector('.range__input');
    if (!input || document.activeElement === input) return;
    const value = state.muted ? 0 : Math.round(state.volume * 100);
    input.value = String(value);
    this.#parts.volume.style.setProperty('--range-fill', `${value}%`);
  }

  // Очередь строится заново, только когда сменился её состав; текущий трек — aria-current.
  #queue({ queue, index, playing }) {
    const list = this.#parts.queue;
    if (!list) return;
    const key = queue.map((track) => track.title).join('\n');
    if (key !== this.#queueKey) {
      this.#queueKey = key;
      list.replaceChildren(...queue.map((track, i) => trackRow(track, i)));
    }
    [...list.children].forEach((row, i) => {
      const current = i === index;
      row.toggleAttribute('aria-current', current);
      // Класс движения не снимается: значок оживает, только если он был при вставке.
      row.querySelector('.player__now')?.classList.toggle(PLAYER.nowPaused, !(current && playing));
    });
  }

  #tick() {
    cancelAnimationFrame(this.#frame);
    if (!this.#seen) return;
    const step = () => {
      this.#paint();
      if (this.#state?.playing && this.#seen) this.#frame = requestAnimationFrame(step);
    };
    this.#frame = requestAnimationFrame(step);
  }

  #paint() {
    const state = this.#state;
    if (!state) return;
    const elapsed = state.playing ? (performance.now() - state.at) / 1000 : 0;
    const position = Math.min(state.duration || 0, state.position + elapsed);
    const share = state.duration ? (position / state.duration) * 100 : 0;
    const { now, total, line, seek } = this.#parts;
    // Секунда меняется раз в 60 кадров: писать текст каждый кадр — будить наблюдателей страницы зря.
    setText(now, formatTime(position));
    setText(total, formatTime(state.duration));
    line?.style.setProperty('--player-progress', `${share}%`);
    const input = seek?.querySelector('.range__input');
    if (!input) return;
    input.max = String(state.duration || 0);
    if (!this.#scrubbing) input.value = String(position);
    input.setAttribute('aria-valuetext', `${sayTime(position)} из ${sayTime(state.duration)}`);
    seek.style.setProperty('--range-fill', `${share}%`);
    seek.style.setProperty('--range-buffer', `${state.duration ? (state.buffered / state.duration) * 100 : 0}%`);
  }
}

function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

// Строка очереди: обложка, название, исполнитель, длительность; у текущего
// вместо длительности — эквалайзер (он двигается, пока играет).
function trackRow(track, index) {
  return h('button', { class: 'row row_interactive player__track', type: 'button', dataset: { index: String(index) } },
    h('span', { class: 'row__lead' },
      h('span', { class: 'thumb thumb_size_s' },
        track.cover ? h('img', { class: 'thumb__image', src: track.cover, alt: '', loading: 'lazy' }) : svgIcon('music'))),
    h('span', { class: 'row__body' },
      h('span', { class: 'row__title', text: track.title }),
      h('span', { class: 'row__note', text: track.artist ?? '' })),
    h('span', { class: 'row__trail' },
      h('span', { class: 'player__track-time', text: formatTime(track.duration) }),
      svgIcon(PLAYER.icons.now, 'icon_motion_loop player__now')));
}
