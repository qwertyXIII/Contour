// Карта: берёт провайдера по имени из data-provider и отдаёт ему, что
// показать. Сам блок провайдеров не знает — их регистрирует index.js
// (utils/map-providers.js), поэтому смена провайдера — это смена имени.
//
//   <div class="map" data-provider="schematic" data-route="82.89,55.03 82.92,55.04">
//     <div class="map__canvas"></div>
//     <span class="map-pin map__pin" data-at="82.89,55.03">…</span>
//     <p class="map__attribution"></p>
//   </div>
//
// Метки — наши блоки map-pin, провайдер только ставит их на место: облик один
// у всех провайдеров. Без data-fit="none" карта вписывает маршрут и метки;
// с ним — встаёт в data-center / data-zoom.
//
// Появление — здесь, одно у всех провайдеров: когда карта впервые на экране
// (и когда пришёл новый маршрут), первая метка падает на место, линия
// маршрута проводится от начала к концу, следом падают остальные. Линию
// проводит провайдер (drawRoute(доля) — необязательная часть договора), время
// и «меньше движения» — utils/motion.js.
import { EVENTS, MAP } from '../../utils/constants.js';
import { emit, h } from '../../utils/dom.js';
import { logger } from '../../utils/logger.js';
import { mapProvider } from '../../utils/map-providers.js';
import { appear, hide, reduced, run, stop } from '../../utils/motion.js';
import { boundsOf, parsePoints } from './mercator.js';

export class MapView {
  #root;
  #name;
  #adapter = null;
  #pins = [];
  #route = false;
  #line = { share: 1 };
  #visible = false;
  #waiting = false;

  constructor(root) {
    this.#root = root;
    this.#name = root.dataset.provider || MAP.defaultProvider;
  }

  init() {
    const create = mapProvider(this.#name);
    if (!create) {
      this.#fail(MAP.labels.noProvider(this.#name));
      return this;
    }
    let canvas = this.#root.querySelector('.map__canvas');
    if (!canvas) {
      canvas = h('div', { class: 'map__canvas' });
      this.#root.prepend(canvas);
    }
    const [center] = parsePoints(this.#root.dataset.center);
    const zoom = Number(this.#root.dataset.zoom) || undefined;
    Promise.resolve()
      .then(() => create(canvas, { theme: this.#theme(), center, zoom }))
      .then((adapter) => this.#ready(adapter))
      .catch((error) => this.#fail(MAP.labels.error, error));
    this.#root.addEventListener(EVENTS.mapSet, (event) => {
      this.#apply(event.detail);
      if (event.detail?.route || event.detail?.markers) this.#arm();
    });
    document.addEventListener(EVENTS.themeChange, () => this.#adapter?.setTheme(this.#theme()));
    new IntersectionObserver(([entry]) => {
      this.#visible = entry.isIntersecting;
      if (this.#visible && this.#waiting) this.#play();
    }, { threshold: MAP.revealAt }).observe(this.#root);
    return this;
  }

  #ready(adapter) {
    this.#adapter = adapter;
    const attribution = this.#root.querySelector('.map__attribution');
    if (attribution && adapter.attribution) attribution.textContent = adapter.attribution;
    this.#apply(this.#fromMarkup());
    this.#arm();
    this.#root.classList.add(MAP.ready);
    emit(this.#root, EVENTS.mapReady, { provider: this.#name });
  }

  // Спрятать метки и линию до показа: карта на экране — сразу, иначе — когда придёт.
  #arm() {
    if (!this.#adapter || reduced()) return;
    stop(this.#line);
    hide(this.#pins, { from: 'above' });
    if (this.#route) this.#adapter.drawRoute?.(0);
    this.#waiting = true;
    if (this.#visible) this.#play();
  }

  async #play() {
    this.#waiting = false;
    const [first, ...rest] = this.#pins;
    const draws = this.#route && this.#adapter.drawRoute;
    if (!draws) {
      appear(this.#pins, { from: 'above', spring: 'bouncy', order: true });
      return;
    }
    appear(first, { from: 'above', spring: 'bouncy' });
    const drawn = await run(this.#line, (share) => this.#adapter?.drawRoute(share));
    if (drawn) appear(rest, { from: 'above', spring: 'bouncy', order: true });
  }

  // Что показать при запуске — из разметки: маршрут, метки, вписать ли их.
  #fromMarkup() {
    const points = parsePoints(this.#root.dataset.route);
    const markers = [...this.#root.querySelectorAll(':scope > [data-at]')].map((el, i) => ({
      id: el.dataset.id ?? String(i),
      at: parsePoints(el.dataset.at)[0],
      el,
    })).filter((marker) => marker.at);
    const [center] = parsePoints(this.#root.dataset.center);
    const fit = this.#root.dataset.fit !== 'none' && boundsOf([...points, ...markers.map((m) => m.at)]);
    return {
      markers,
      route: points.length ? { points } : null,
      view: fit ? { bounds: fit } : { center: center ?? [0, 0], zoom: Number(this.#root.dataset.zoom) || MAP.minZoom },
    };
  }

  #apply({ view, markers, route } = {}) {
    if (!this.#adapter) return;
    if (markers) {
      this.#adapter.setMarkers(markers);
      this.#pins = markers.map((marker) => marker.el);
    }
    if (route !== undefined) {
      this.#adapter.setRoute(route);
      this.#route = Boolean(route?.points?.length);
    }
    if (view) this.#adapter.setView(view);
  }

  // Провайдеру — явная тема: у настоящей карты свои светлый и тёмный стили.
  #theme() {
    const scheme = getComputedStyle(this.#root).colorScheme;
    if (scheme === 'dark' || scheme === 'light') return scheme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  #fail(reason, error) {
    if (error) logger.warn('Карта не нарисовалась', { provider: this.#name, error: error.message });
    this.#root.classList.add(MAP.error);
    this.#root.append(h('p', { class: 'map__message', role: 'status', text: reason }));
    emit(this.#root, EVENTS.mapError, { provider: this.#name, reason });
  }
}
