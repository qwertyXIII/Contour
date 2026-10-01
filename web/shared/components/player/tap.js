// Разбор звука сеанса для кольца: <audio> → Web Audio → анализатор → динамики.
//
// ⚠️ Звук после этого идёт через AudioContext, и назад дороги нет (элемент
// привязан к контексту навсегда):
//   - на iPhone свёрнутое приложение усыпляет контекст — музыка в фоне молчит;
//   - звук с чужого сайта без CORS контекст отдаёт тишиной.
// Поэтому разбор — только по согласию разметки (data-tap у <audio>) и только
// из жеста: создать контекст не из нажатия — он спит, и музыка молчит.
import { PLAYER } from '../../utils/constants.js';

/** { read(count), resume() } или null, если Web Audio нет. */
export function createTap(audio) {
  const Context = window.AudioContext ?? window.webkitAudioContext;
  if (!Context) return null;
  const context = new Context();
  const analyser = context.createAnalyser();
  analyser.fftSize = PLAYER.tap.fftSize;
  analyser.smoothingTimeConstant = PLAYER.tap.smoothing;
  context.createMediaElementSource(audio).connect(analyser);
  analyser.connect(context.destination);
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const hzPerBin = context.sampleRate / 2 / bins.length;
  return {
    resume: () => context.resume().catch(() => {}),
    read: (count) => bands(analyser, bins, hzPerBin, count),
  };
}

// Полосы по логарифму частоты: в каждой — пик её корзин; высокие подтянуты наклоном.
function bands(analyser, bins, hzPerBin, count) {
  analyser.getByteFrequencyData(bins);
  const { lowHz, highHz, curve, tilt } = PLAYER.tap;
  const ratio = highHz / lowHz;
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((lowHz * ratio ** (i / count)) / hzPerBin);
    const to = Math.max(from + 1, Math.ceil((lowHz * ratio ** ((i + 1) / count)) / hzPerBin));
    let peak = 0;
    for (let k = from; k < to && k < bins.length; k += 1) peak = Math.max(peak, bins[k]);
    return Math.min(1, (peak / 255) ** curve * (1 + (tilt * i) / count));
  });
}
