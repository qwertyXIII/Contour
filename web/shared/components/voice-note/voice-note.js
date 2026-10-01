// Голосовое в ленте (блок voice-note, ADR-0072 Alter'а): ▶, волна, время.
//
// Звук берётся лениво — когда голосовое показалось на экране или его нажали: в
// истории их может быть много, и тянуть каждое при открытии чата незачем. Волна —
// из самого звука (utils/peaks.js); не раскодировалось — ровная, слушать можно.
// Играет обычный <audio> из касания по кнопке — так iOS его пускает. Играет одно
// голосовое за раз: нажали другое — прежнее встаёт на паузу.
import { VOICE_NOTE } from '../../utils/constants.js';
import { h, setIcon, svgIcon } from '../../utils/dom.js';
import { formatTime, sayTime } from '../../utils/time.js';
import { decodePeaks } from '../../utils/peaks.js';

let playing = null;

/**
 * Голосовое: `load()` → Promise<Blob> — сам звук (хозяин знает, откуда: запись в
 * памяти или адрес сервера); `seconds` — длительность, если известна заранее.
 * Возвращает узел блока.
 */
export function voiceNote({ load, seconds = 0 }) {
  const bars = Array.from({ length: VOICE_NOTE.bars }, () => h('i', { class: 'waveform__bar', style: { '--h': '.3' } }));
  const wave = h('span', {
    class: 'waveform voice-note__wave', role: 'slider', tabindex: '0', 'aria-label': VOICE_NOTE.labels.seek, 'aria-valuemin': '0',
  }, ...bars);
  const play = h('button', { class: 'voice-note__play', type: 'button', 'aria-label': VOICE_NOTE.labels.play }, svgIcon('play'));
  const time = h('span', { class: 'voice-note__time' }, seconds ? formatTime(seconds) : '');
  const audio = h('audio', { preload: 'auto' });
  const root = h('div', { class: 'voice-note' }, play, wave, time, audio);

  let ready = null;
  const total = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : seconds);
  const paint = () => {
    const share = total() ? audio.currentTime / total() : 0;
    const done = Math.round(share * bars.length);
    bars.forEach((bar, i) => bar.classList.toggle('waveform__bar_played', i < done && (audio.currentTime > 0)));
    time.textContent = audio.currentTime > 0 && !audio.ended ? formatTime(audio.currentTime) : (total() ? formatTime(total()) : '');
    wave.setAttribute('aria-valuemax', String(Math.round(total())));
    wave.setAttribute('aria-valuenow', String(Math.round(audio.currentTime)));
    wave.setAttribute('aria-valuetext', sayTime(audio.currentTime));
  };
  const state = () => {
    const on = !audio.paused;
    root.classList.toggle('voice-note_playing', on);
    setIcon(play.querySelector('.icon'), on ? 'pause' : 'play');
    play.setAttribute('aria-label', on ? VOICE_NOTE.labels.pause : VOICE_NOTE.labels.play);
  };
  ['timeupdate', 'loadedmetadata', 'seeked', 'ended'].forEach((name) => audio.addEventListener(name, paint));
  ['play', 'pause', 'ended'].forEach((name) => audio.addEventListener(name, state));
  audio.addEventListener('play', () => {
    if (playing && playing !== audio) playing.pause();
    playing = audio;
  });

  /** Звук и волна — один раз; не вышло — голосовое помечено, кнопка гаснет. */
  const prepare = () => {
    ready ??= load()
      .then(async (blob) => {
        audio.src = URL.createObjectURL(blob);
        const peaks = await decodePeaks(blob, bars.length).catch(() => null);
        peaks?.forEach((peak, i) => bars[i].style.setProperty('--h', peak.toFixed(2)));
        return true;
      })
      .catch(() => {
        root.classList.add('voice-note_broken');
        play.disabled = true;
        time.textContent = VOICE_NOTE.labels.failed;
        return false;
      });
    return ready;
  };

  play.addEventListener('click', async () => {
    if (!audio.paused) { audio.pause(); return; }
    // Звук уже пришёл — играем в том же такте касания: так его пускает iOS.
    if (audio.src) { void audio.play(); return; }
    if (await prepare()) void audio.play().catch(() => {});
  });
  const seekTo = (clientX) => {
    const box = wave.getBoundingClientRect();
    if (!box.width || !total() || !audio.src) return;
    audio.currentTime = Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * total();
  };
  wave.addEventListener('click', (event) => seekTo(event.clientX));
  wave.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -5, ArrowRight: 5 }[event.key];
    if (!step || !audio.src) return;
    event.preventDefault();
    audio.currentTime = Math.max(0, Math.min(total(), audio.currentTime + step));
  });

  // Показалось на экране — подготовить заранее: волна видна до нажатия.
  const seen = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    seen.disconnect();
    void prepare();
  });
  seen.observe(root);
  paint();
  return root;
}
