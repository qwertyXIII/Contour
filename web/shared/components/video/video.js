// Видео со своими элементами управления поверх нативного <video>. Нативный
// элемент — источник правды: время, буфер, звук, конец, ошибка приходят его
// событиями, и облик только отражает их.
//
// Мышь: щелчок — играть/пауза, двойной — во весь экран. Палец: касание
// показывает и прячет элементы (как у системных плееров). Клавиши, когда
// фокус внутри: пробел или k — играть, ←/→ — ±5 с, m — звук, f — во весь экран.
import { VIDEO } from '../../utils/constants.js';
import { setIcon } from '../../utils/dom.js';
import { formatTime, sayTime } from '../../utils/time.js';
import { buildControls } from './controls.js';

export class Video {
  #root;
  #video;
  #ui;
  #idleTimer = 0;
  #frame = 0;
  #scrubbing = false;

  constructor(root) {
    this.#root = root;
    this.#video = root.querySelector('.video__native');
  }

  init() {
    if (!this.#video) return this;
    const canFullscreen = Boolean(this.#root.requestFullscreen || this.#root.webkitRequestFullscreen || this.#video.webkitEnterFullscreen);
    this.#video.controls = false;
    this.#video.playsInline = true;
    this.#ui = buildControls(this.#root, { canFullscreen });
    this.#listenVideo();
    this.#listenControls();
    this.#root.classList.add(VIDEO.enhanced);
    this.#syncDuration();
    this.#syncSound();
    if (this.#video.error) this.#failed();
    return this;
  }

  #listenVideo() {
    const on = (type, fn) => this.#video.addEventListener(type, fn);
    on('play', () => this.#playing(true));
    on('pause', () => this.#playing(false));
    on('waiting', () => this.#set(VIDEO.waiting, true));
    on('playing', () => this.#set(VIDEO.waiting, false));
    on('canplay', () => this.#set(VIDEO.waiting, false));
    on('ended', () => this.#ended());
    on('error', () => this.#failed());
    on('durationchange', () => this.#syncDuration());
    on('loadedmetadata', () => this.#syncDuration());
    on('timeupdate', () => this.#syncTime());
    on('progress', () => this.#syncBuffer());
    on('volumechange', () => this.#syncSound());
    const screen = () => this.#syncFullscreen();
    document.addEventListener('fullscreenchange', screen);
    document.addEventListener('webkitfullscreenchange', screen);
  }

  #listenControls() {
    const { big, toggle, mute, full, seek } = this.#ui;
    big.addEventListener('click', () => this.#togglePlay());
    toggle.addEventListener('click', () => this.#togglePlay());
    mute.addEventListener('click', () => { this.#video.muted = !this.#video.muted; });
    full?.addEventListener('click', () => this.#toggleFullscreen());
    seek.addEventListener('input', () => {
      this.#scrubbing = true;
      this.#video.currentTime = Number(seek.value);
      this.#syncTime();
    });
    seek.addEventListener('change', () => { this.#scrubbing = false; });
    this.#video.addEventListener('pointerup', (event) => this.#onSurface(event));
    this.#video.addEventListener('dblclick', () => full && this.#toggleFullscreen());
    this.#root.addEventListener('pointermove', (event) => event.pointerType === 'mouse' && this.#wake());
    this.#root.addEventListener('focusin', () => this.#wake());
    this.#root.addEventListener('keydown', (event) => this.#onKey(event));
  }

  #togglePlay() {
    if (this.#video.paused || this.#video.ended) {
      if (this.#video.ended) this.#video.currentTime = 0;
      this.#video.play()?.catch(() => {});
    } else {
      this.#video.pause();
    }
  }

  // Мышь по картинке — играть/пауза; палец — показать или спрятать элементы.
  #onSurface(event) {
    if (event.pointerType === 'mouse') {
      if (event.button === 0) this.#togglePlay();
      return;
    }
    const started = this.#root.classList.contains(VIDEO.started);
    if (!started) this.#togglePlay();
    else if (this.#root.classList.contains(VIDEO.idle) || this.#video.paused) this.#wake();
    else this.#sleep();
  }

  #onKey(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const onButton = event.target.closest('button');
    const actions = {
      ' ': onButton ? null : () => this.#togglePlay(),
      k: () => this.#togglePlay(),
      ArrowLeft: () => this.#skip(-VIDEO.skipSec),
      ArrowRight: () => this.#skip(VIDEO.skipSec),
      m: () => { this.#video.muted = !this.#video.muted; },
      f: this.#ui.full ? () => this.#toggleFullscreen() : null,
    };
    // Буквы — по клавише, а не по символу: в русской раскладке «k» — это «л».
    const letters = { KeyK: 'k', KeyM: 'm', KeyF: 'f' };
    const action = actions[letters[event.code] ?? event.key];
    if (!action) return;
    event.preventDefault();
    action();
    this.#wake();
  }

  #skip(seconds) {
    const duration = this.#video.duration || 0;
    this.#video.currentTime = Math.max(0, Math.min(duration, this.#video.currentTime + seconds));
  }

  #toggleFullscreen() {
    const current = document.fullscreenElement ?? document.webkitFullscreenElement;
    if (current === this.#root) {
      (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
      return;
    }
    const request = this.#root.requestFullscreen ?? this.#root.webkitRequestFullscreen;
    // iPhone не умеет «во весь экран» для обёртки — только системный плеер для самого видео.
    if (request) request.call(this.#root)?.catch?.(() => this.#video.webkitEnterFullscreen?.());
    else this.#video.webkitEnterFullscreen?.();
  }

  #playing(on) {
    this.#set(VIDEO.playing, on);
    if (on) {
      this.#set(VIDEO.started, true);
      this.#set(VIDEO.ended, false);
      this.#tick();
      this.#wake();
    } else {
      this.#wake();
      cancelAnimationFrame(this.#frame);
    }
    const { icons, labels } = VIDEO;
    [this.#ui.toggle, this.#ui.big].forEach((button) => {
      setIcon(button.querySelector('.icon'), on ? icons.pause : icons.play);
      button.setAttribute('aria-label', on ? labels.pause : labels.play);
    });
  }

  #ended() {
    this.#set(VIDEO.ended, true);
    setIcon(this.#ui.big.querySelector('.icon'), VIDEO.icons.replay);
    this.#ui.big.setAttribute('aria-label', VIDEO.labels.replay);
  }

  #failed() {
    this.#set(VIDEO.error, true);
    this.#set(VIDEO.waiting, false);
  }

  // Пока играет — время и полоса каждый кадр: timeupdate приходит 4 раза в секунду, и тонкая полоса дёргалась бы.
  #tick() {
    cancelAnimationFrame(this.#frame);
    const step = () => {
      this.#syncTime();
      if (!this.#video.paused) this.#frame = requestAnimationFrame(step);
    };
    this.#frame = requestAnimationFrame(step);
  }

  // Элементы видны; во время показа прячутся через VIDEO.idleMs без движения.
  #wake() {
    this.#set(VIDEO.idle, false);
    clearTimeout(this.#idleTimer);
    if (!this.#video.paused) this.#idleTimer = setTimeout(() => this.#sleep(), VIDEO.idleMs);
  }

  #sleep() {
    if (this.#video.paused || this.#root.contains(document.activeElement) && document.activeElement !== this.#video) return;
    this.#set(VIDEO.idle, true);
  }

  #syncDuration() {
    const duration = this.#video.duration;
    if (!Number.isFinite(duration)) return;
    this.#ui.seek.max = String(duration);
    this.#ui.badge.textContent = formatTime(duration);
    this.#syncTime();
  }

  #syncTime() {
    const { currentTime: now, duration } = this.#video;
    const total = Number.isFinite(duration) ? duration : 0;
    if (!this.#scrubbing) this.#ui.seek.value = String(now);
    const share = total ? (now / total) * 100 : 0;
    this.#ui.seekRoot.style.setProperty('--range-fill', `${share}%`);
    this.#ui.seek.setAttribute('aria-valuetext', `${sayTime(now)} из ${sayTime(total)}`);
    this.#ui.time.textContent = `${formatTime(now)} / ${formatTime(total)}`;
  }

  #syncBuffer() {
    const { buffered, duration } = this.#video;
    if (!buffered.length || !Number.isFinite(duration) || !duration) return;
    const end = buffered.end(buffered.length - 1);
    this.#ui.seekRoot.style.setProperty('--range-buffer', `${(end / duration) * 100}%`);
  }

  #syncSound() {
    const muted = this.#video.muted || this.#video.volume === 0;
    this.#set(VIDEO.muted, muted);
    setIcon(this.#ui.mute.querySelector('.icon'), muted ? VIDEO.icons.mute : VIDEO.icons.sound);
    this.#ui.mute.setAttribute('aria-label', muted ? VIDEO.labels.unmute : VIDEO.labels.mute);
  }

  #syncFullscreen() {
    const on = (document.fullscreenElement ?? document.webkitFullscreenElement) === this.#root;
    this.#set(VIDEO.fullscreen, on);
    if (!this.#ui.full) return;
    setIcon(this.#ui.full.querySelector('.icon'), on ? VIDEO.icons.exit : VIDEO.icons.enter);
    this.#ui.full.setAttribute('aria-label', on ? VIDEO.labels.exit : VIDEO.labels.enter);
  }

  #set(modifier, on) {
    this.#root.classList.toggle(modifier, on);
  }
}
