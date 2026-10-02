/**
 * Пропускная способность выхода по живому трафику — по рывкам, а не по соединению.
 *
 * «Байты соединения / его время» на закрытии меряет не канал, а то, сколько
 * соединение простояло: HTTP/2 к сайту держится минутами и почти всё время
 * молчит. Поэтому relay сообщает каждый кусок (`data`), а здесь куски режутся
 * на рывки — подряд, без пауз дольше `gapMs`. В счёт идёт только рывок, по
 * которому канал правда виден:
 * - не меньше `minBytes` и не короче `minMs` — маленький ответ меряет задержку,
 *   а не канал, а короткий целиком приходится на медленный старт TCP;
 * - без задержки со стороны клиента (`paused`): relay останавливает выход, когда
 *   клиент не успевает забирать (телефон на слабой мобильной сети), и такой
 *   рывок меряет клиента, а не выход;
 * - первый кусок рывка — точка отсчёта, его байты не считаются: время пошло с
 *   его прихода, и с ним скорость завышалась бы.
 * Только вниз: вверх ходят запросы, и большой отдачи почти не бывает.
 *
 * Не из `stats/meter.ts`: его скорость по выходу — сумма того, сколько сейчас
 * просят все потребители, а не сколько выход способен отдать, и про задержку
 * со стороны клиента он не знает.
 *
 * Каждый такой замер — нижняя граница канала (мог упереться сайт), поэтому
 * сводит их верхний квантиль, а не среднее (`speed.ts`).
 */

export type FlowTuning = {
  /** Пауза дольше — рывок кончился. */
  gapMs: number;
  minBytes: number;
  minMs: number;
};

export const FLOW_DEFAULTS: FlowTuning = { gapMs: 500, minBytes: 1_000_000, minMs: 500 };

/** Что звать из relay по одному соединению через выход. */
export type Flow = {
  /** Пришёл кусок от выхода. */
  data(bytes: number, now?: number): void;
  /** Клиент не успевает — relay остановил выход: текущий рывок не в счёт. */
  paused(): void;
  /** Соединение закрыто: досчитать последний рывок (его конец — последний кусок, не закрытие). */
  end(): void;
};

/** `onTransfer` получает только годные рывки: байты, мс, когда кончился. */
export function startFlow(tuning: FlowTuning, onTransfer: (bytes: number, ms: number, at: number) => void): Flow {
  let start = -1;
  let last = 0;
  let bytes = 0;
  let clean = true;
  let ended = false;

  const close = (): void => {
    if (start >= 0 && clean && bytes >= tuning.minBytes && last - start >= tuning.minMs) onTransfer(bytes, last - start, last);
    start = -1;
    bytes = 0;
    clean = true;
  };

  return {
    data(n, now = Date.now()) {
      if (ended || n <= 0) return;
      if (start >= 0 && now - last > tuning.gapMs) close();
      if (start < 0) { start = now; last = now; return; }
      bytes += n;
      last = now;
    },
    paused() { clean = false; },
    end() {
      if (ended) return;
      ended = true;
      close();
    },
  };
}
