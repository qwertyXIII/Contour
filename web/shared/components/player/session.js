// Сеанс музыки над своим <audio>: очередь, повтор, перемешивание. Виды
// (блок player) им не владеют — они шлют player:command и рисуют
// player:state. Сеанс узнают по data-session: сколько бы видов ни смотрело
// на один сеанс (виджет и экран «Сейчас играет»), они показывают одно.
//
// Spotify и любой другой источник — другой сеанс тем же договором: виды
// не заметят разницы. Этот — для своих файлов по HTTP.
//
// data-tap у <audio> — разрешить кольцу слышать трек: на первом «играть»
// сеанс заводит разбор звука и объявляет его по своему имени
// (utils/audio-taps.js). Цена — в tap.js.
//
//   <audio data-session="home" data-tap preload="metadata"></audio>
//   player:command { session: 'home', action: 'load', value: { queue, index, source } }
import { EVENTS, PLAYER } from '../../utils/constants.js';
import { registerTap } from '../../utils/audio-taps.js';
import { emit } from '../../utils/dom.js';
import { createTap } from './tap.js';

export class AudioSession {
  #audio;
  #name;
  #queue = [];
  #index = -1;
  #repeat = 'off';
  #shuffle = false;
  #source = '';
  #tap = null;

  constructor(audio) {
    this.#audio = audio;
    this.#name = audio.dataset.session;
  }

  init() {
    document.addEventListener(EVENTS.playerCommand, (event) => {
      if (event.detail.session === this.#name) this.#run(event.detail);
    });
    ['play', 'pause', 'timeupdate', 'durationchange', 'volumechange', 'progress', 'seeked', 'error']
      .forEach((type) => this.#audio.addEventListener(type, () => this.#publish()));
    this.#audio.addEventListener('ended', () => this.#ended());
    return this;
  }

  #run({ action, value }) {
    const audio = this.#audio;
    const actions = {
      load: () => this.#load(value),
      toggle: () => (audio.paused ? this.#play() : audio.pause()),
      next: () => this.#step(1),
      prev: () => (audio.currentTime > PLAYER.restartAfterSec ? this.#seek(0) : this.#step(-1)),
      seek: () => this.#seek(Number(value)),
      volume: () => {
        audio.volume = Math.max(0, Math.min(1, Number(value)));
        audio.muted = false;
      },
      mute: () => { audio.muted = !audio.muted; },
      shuffle: () => { this.#shuffle = !this.#shuffle; },
      repeat: () => { this.#repeat = PLAYER.repeat[(PLAYER.repeat.indexOf(this.#repeat) + 1) % PLAYER.repeat.length]; },
      select: () => this.#go(Number(value), { play: true }),
      sync: () => {},
    };
    actions[action]?.();
    this.#publish();
  }

  #load({ queue = [], index = 0, source = '' } = {}) {
    this.#queue = queue;
    this.#source = source;
    this.#go(index, { play: false });
  }

  #go(index, { play }) {
    const track = this.#queue[index];
    if (!track) return;
    this.#index = index;
    this.#audio.src = track.src;
    if (play) this.#play();
  }

  #play() {
    if (!this.#audio.src && this.#queue.length) this.#go(Math.max(this.#index, 0), { play: false });
    this.#listen();
    this.#audio.play()?.catch(() => this.#publish());
  }

  // Разбор звука для кольца — из жеста «играть», один раз на элемент.
  #listen() {
    if (!('tap' in this.#audio.dataset)) return;
    if (!this.#tap) {
      this.#tap = createTap(this.#audio);
      if (this.#tap) registerTap(this.#name, this.#tap.read);
    }
    this.#tap?.resume();
  }

  #seek(seconds) {
    const duration = this.#audio.duration || 0;
    this.#audio.currentTime = Math.max(0, Math.min(duration, seconds));
  }

  // Следующий или предыдущий: при перемешивании — любой другой; в конце
  // очереди без повтора — остановиться на последнем.
  #step(direction) {
    const total = this.#queue.length;
    if (!total) return;
    const playing = !this.#audio.paused;
    let next = this.#index + direction;
    if (this.#shuffle && total > 1) {
      next = (this.#index + 1 + Math.floor(Math.random() * (total - 1))) % total;
    } else if (next < 0 || next >= total) {
      if (this.#repeat === 'off') return;
      next = (next + total) % total;
    }
    this.#go(next, { play: playing });
  }

  #ended() {
    if (this.#repeat === 'one') {
      this.#seek(0);
      this.#play();
      return;
    }
    const last = this.#index === this.#queue.length - 1;
    if (last && this.#repeat === 'off' && !this.#shuffle) {
      this.#publish();
      return;
    }
    this.#step(1);
    this.#play();
  }

  #publish() {
    const audio = this.#audio;
    const track = this.#queue[this.#index] ?? {};
    const buffered = audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0;
    emit(audio, EVENTS.playerState, {
      session: this.#name,
      playing: !audio.paused,
      position: audio.currentTime,
      at: performance.now(),
      duration: Number.isFinite(audio.duration) ? audio.duration : track.duration ?? 0,
      buffered,
      volume: audio.volume,
      muted: audio.muted,
      title: track.title ?? '',
      artist: track.artist ?? '',
      cover: track.cover ?? '',
      // Главные цвета обложки, если источник их знает; нет — вид разберёт картинку сам.
      colors: track.colors ?? null,
      source: this.#source,
      index: this.#index,
      queue: this.#queue.map(({ title, artist, cover, duration }) => ({ title, artist, cover, duration })),
      repeat: this.#repeat,
      shuffle: this.#shuffle,
    });
  }
}
