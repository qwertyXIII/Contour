// Звук в просмотре — голосовое, аудиофайл: значок, подпись, волна и «слушать».
// Волна — из самого звука: слайд раскодирует файл (Web Audio) и берёт пики по
// полоскам; не вышло — ровная волна, слушать всё равно можно. Проигранная часть
// волны — акцентом (блок waveform, __bar_played); касание волны — перемотка.
//
// Звук играет обычный <audio>: из касания по кнопке, поэтому iOS его пускает.
// Ушли со слайда — пауза (quiet), закрыли просмотр — адрес отпускает владелец.
//
// Есть ссылка потока — звук по ней: малый файл берётся целиком (волна — из него),
// большой играет кусками прямо по ссылке, а волна остаётся ровной: раскодировать
// час звука ради 48 полосок — сотни мегабайт в памяти телефона.
import { VIEWER } from '../../utils/constants.js';
import { h, setIcon, svgIcon } from '../../utils/dom.js';
import { formatTime, sayTime } from '../../utils/time.js';
import { decodePeaks } from '../../utils/peaks.js';

/** Полосок в волне: на телефоне — во всю ширину колонки. */
const BARS = 48;

/** До скольких байт звук берётся целиком ради волны: 8 МБ — четверть часа речи в AAC. */
const WHOLE_MAX = 8 * 1024 * 1024;

/**
 * Слайд звука; `source` — { blob() → Promise<Blob>, stream?() → Promise<url|null> }:
 * как взять сам файл, знает владелец просмотра.
 */
export function soundSlide(slide, item, source, keep) {
  const bars = Array.from({ length: BARS }, () => h('i', { class: 'waveform__bar', style: { '--h': '.3' } }));
  const wave = h('span', { class: 'waveform viewer__wave', role: 'slider', tabindex: '0', 'aria-label': VIEWER.labels.seek, 'aria-valuemin': '0' }, ...bars);
  const time = h('span', { class: 'viewer__time' }, item.duration ? formatTime(item.duration) : '');
  const play = h('button', {
    class: 'button button_view_primary button_shape_round button_size_l viewer__play', type: 'button', 'aria-label': VIEWER.labels.play, disabled: true,
  }, svgIcon('play', 'button__icon'));
  const audio = h('audio', { preload: 'auto' });
  slide.append(h('div', { class: 'viewer__sound' },
    h('span', { class: 'viewer__glyph' }, svgIcon(item.icon || 'music')),
    h('p', { class: 'viewer__name' }, item.title || ''),
    wave,
    h('div', { class: 'viewer__controls' }, play, time),
    audio));

  const total = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : item.duration || 0);
  const paint = () => {
    const share = total() ? audio.currentTime / total() : 0;
    const played = Math.round(share * BARS);
    bars.forEach((bar, i) => bar.classList.toggle('waveform__bar_played', i < played));
    time.textContent = audio.currentTime > 0 ? `${formatTime(audio.currentTime)} / ${formatTime(total())}` : formatTime(total());
    wave.setAttribute('aria-valuemax', String(Math.round(total())));
    wave.setAttribute('aria-valuenow', String(Math.round(audio.currentTime)));
    wave.setAttribute('aria-valuetext', sayTime(audio.currentTime));
  };
  const state = () => {
    const playing = !audio.paused;
    setIcon(play.querySelector('.icon'), playing ? 'pause' : 'play');
    play.setAttribute('aria-label', playing ? VIEWER.labels.pause : VIEWER.labels.play);
  };
  ['timeupdate', 'loadedmetadata', 'seeked'].forEach((name) => audio.addEventListener(name, paint));
  ['play', 'pause', 'ended'].forEach((name) => audio.addEventListener(name, state));
  play.addEventListener('click', () => (audio.paused ? void audio.play() : audio.pause()));
  const seekTo = (clientX) => {
    const box = wave.getBoundingClientRect();
    if (!box.width || !total()) return;
    audio.currentTime = Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * total();
  };
  wave.addEventListener('click', (event) => seekTo(event.clientX));
  wave.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -5, ArrowRight: 5 }[event.key];
    if (!step) return;
    event.preventDefault();
    audio.currentTime = Math.max(0, Math.min(total(), audio.currentTime + step));
  });

  const whole = async (blob) => {
    audio.src = keep(URL.createObjectURL(blob));
    play.disabled = false;
    const peaks = await decodePeaks(blob, BARS).catch(() => null);
    peaks?.forEach((peak, i) => bars[i].style.setProperty('--h', peak.toFixed(2)));
  };
  const load = async () => {
    const url = source.stream ? await source.stream() : null;
    if (!url) return whole(await source.blob());
    // Один запрос на оба случая: по длине из заголовков — дочитать целиком или бросить и играть кусками.
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Ошибка ${response.status}`);
    const size = Number(response.headers.get('content-length'));
    if (size > 0 && size <= WHOLE_MAX) return whole(await response.blob());
    void response.body?.cancel();
    audio.src = url;
    play.disabled = false;
    return undefined;
  };
  load()
    .catch(() => {
      slide.classList.add(VIEWER.broken);
      time.textContent = VIEWER.labels.failed;
    });
  paint();
}
