/*
 * Волна со знаком — для двусторонних капсул кольца: положительная полуволна
 * тянет наружу, отрицательная — внутрь. Чистые функции, их проверяют тесты.
 */

const clamp = (value) => Math.min(1, Math.max(0, value));

/**
 * Пики положительной (наружу) и отрицательной (внутрь) полуволн на каждую капсулу.
 *
 * Окно — короткое: весь буфер анализатора слишком длинный, в каждый его кусок
 * попадает много целых периодов, и почти все капсулы получили бы одни и те же два
 * пика. Короткое окно сохраняет форму волны по кругу.
 */
export function waveformPeaks(bytes, count, {
  sampleRate = 48_000,
  windowMs = 8,
  noiseFloor = 0,
  gain = 1,
} = {}) {
  if (!bytes?.length || !Number.isInteger(count) || count < 1) return [];
  const length = Math.min(bytes.length,
    Math.max(count * 2, Math.round(sampleRate * windowMs / 1000)));
  const offset = bytes.length - length;
  let center = 0;
  for (let index = offset; index < bytes.length; index += 1) center += bytes[index];
  center /= length;

  return Array.from({ length: count }, (_, index) => {
    const first = offset + Math.floor(index * length / count);
    if (first >= bytes.length) return { inner: 0, outer: 0 };
    const last = Math.min(bytes.length, offset + Math.max(
      Math.floor((index + 1) * length / count),
      Math.floor(index * length / count) + 1,
    ));
    return peaksOf(bytes, first, last, center, noiseFloor, gain);
  });
}

function peaksOf(bytes, first, last, center, noiseFloor, gain) {
  let positive = 0;
  let negative = 0;
  let positiveSum = 0;
  let negativeSum = 0;
  for (let sample = first; sample < last; sample += 1) {
    const value = (bytes[sample] - center) / 128;
    positive = Math.max(positive, value);
    negative = Math.max(negative, -value);
    positiveSum += Math.max(0, value);
    negativeSum += Math.max(0, -value);
  }
  const size = last - first;
  return {
    outer: clamp((positive * 0.75 + positiveSum / size * 0.25 - noiseFloor) * gain),
    inner: clamp((negative * 0.75 + negativeSum / size * 0.25 - noiseFloor) * gain),
  };
}

/**
 * Рисунок по кругу — от полос спектра, а насколько каждая полоса растёт наружу и
 * внутрь — решает настоящая волна. Сырой снимок волны в каждом кадре со своей
 * случайной фазой и по всему кругу выглядит второй, посторонней анимацией.
 */
export function bipolarSpectrum(bands, polarity) {
  if (!Array.isArray(bands)) return [];
  const positive = clamp(polarity?.outer ?? 0);
  const negative = clamp(polarity?.inner ?? 0);
  const strongest = Math.max(positive, negative);
  if (strongest < 0.02) return bands.map(() => ({ inner: 0, outer: 0 }));
  const outerWeight = positive / strongest;
  const innerWeight = negative / strongest;
  return bands.map((band) => ({
    outer: clamp(band * outerWeight),
    inner: clamp(band * innerWeight),
  }));
}
