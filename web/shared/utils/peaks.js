// Огибающая звука полосками для волны (блок waveform): пики по отрезкам — доля от
// самого громкого. Общая для просмотра файлов и голосовых в ленте (ADR-0072).

/** Пики по `count` отрезкам раскодированного звука (AudioBuffer). */
export function peaksOf(buffer, count) {
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / count));
  const peaks = [];
  for (let i = 0; i < count; i += 1) {
    let peak = 0;
    for (let j = i * step, end = Math.min(data.length, j + step); j < end; j += 1) peak = Math.max(peak, Math.abs(data[j]));
    peaks.push(peak);
  }
  const top = Math.max(...peaks, 1e-6);
  return peaks.map((p) => p / top);
}

/** Раскодировать файл (Web Audio) и взять пики; не умеет — null, волна останется ровной. */
export async function decodePeaks(blob, count) {
  const Context = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Context) return null;
  // Один канал, частота не важна: нужна только огибающая.
  const context = new Context(1, 1, 8000);
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  return peaksOf(buffer, count);
}
