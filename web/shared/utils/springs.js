// Пружины на кадр — для того, что догоняет цель с запозданием и лёгким перелётом:
// реплики ленты при прокрутке («как в iMessage»), реплики и кольцо в переходе голоса
// (ADR-0072 Alter'а). Не anime.js: цель меняется на каждом движении пальца, а
// пересоздавать анимацию десятки раз в секунду на каждую реплику — дороже простой
// физики. Шаг — полунеявный Эйлер, dt не больше двух кадров (вкладку будили из фона).
// «Меньше движения» — сразу в цель.
import { reduced } from './motion.js';

// Покой по умолчанию — для долей (0…1); у пикселей свой порог (`rest`), иначе цикл
// крутил бы кадры ради сотых долей пикселя, которых не видно.
const REST = 0.01;
const MAX_DT = 1 / 30;

export class Spring {
  constructor({ stiffness = 300, damping = 26, value = 0, rest = REST } = {}) {
    this.k = stiffness;
    this.c = damping;
    this.rest = rest;
    this.x = value;
    this.v = 0;
    this.target = value;
  }

  /** Шаг на dt секунд; возвращает положение. */
  step(dt) {
    if (reduced()) return this.snap(this.target);
    const a = this.k * (this.target - this.x) - this.c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    if (this.resting) this.snap(this.target);
    return this.x;
  }

  get resting() {
    return Math.abs(this.target - this.x) < this.rest && Math.abs(this.v) < this.rest * 10;
  }

  snap(value) {
    this.x = value;
    this.target = value;
    this.v = 0;
    return value;
  }
}

/**
 * Цикл кадров, который сам засыпает: `tick(dt)` возвращает true, пока есть что
 * двигать. `wake()` — будить (идёт — ничего не делает), `idle()` — обещание
 * «всё стоит».
 */
export function frameLoop(tick) {
  let id = 0;
  let last = 0;
  let waiters = [];
  const run = (now) => {
    const dt = Math.min(MAX_DT, Math.max(0, (now - last) / 1000));
    last = now;
    if (tick(dt || 1 / 60)) {
      id = requestAnimationFrame(run);
      return;
    }
    id = 0;
    const done = waiters;
    waiters = [];
    done.forEach((resolve) => resolve());
  };
  return {
    wake() {
      if (id) return;
      last = performance.now();
      id = requestAnimationFrame(run);
    },
    idle: () => (id ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()),
    get running() { return Boolean(id); },
  };
}
