/*
 * Набор капсул кольца: сколько их, где стоят, кто защищён, кто выбран.
 *
 * Число меняется на лету и без рывка. Лишние гаснут и удаляются, новые вырастают в
 * середине случайных промежутков, потом все плавно расходятся к равным углам.
 * Защищённую капсулу при уменьшении не убирают: она может сдвинуться, но не
 * исчезает. Каждая капсула адресуема по id — её можно выбрать касанием и задать
 * ей свою длину, ширину и цвета поверх того, что рисует кольцо.
 */

import { TAU, clamp, evenAngles, removalCandidates } from './orb-layout.js';

const OVERRIDES = ['inner', 'outer', 'width', 'innerColor', 'outerColor'];

export function createRing({ defs, layer, uid, config, random, still }) {
  const capsules = [];
  let sequence = 0;
  let layout = null;
  let selectedId = null;
  let onSelect = null;
  let desired = Math.round(clamp(config.count, 1, config.maxCount));

  function element(tag, attributes, parent) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    parent.append(node);
    return node;
  }

  /** Капсула — группа с прямоугольником и свой градиент «внутрь → наружу». */
  function createCapsule(angle, bornAt = null) {
    const id = `capsule-${++sequence}`;
    const gradientId = `orb-gradient-${uid}-${sequence}`;
    const gradient = element('linearGradient', { id: gradientId, x1: '0%', y1: '0%', x2: '0%', y2: '100%' }, defs);
    const outerStop = element('stop', { offset: '0%', 'stop-color': '#fff' }, gradient);
    const innerStop = element('stop', { offset: '100%', 'stop-color': '#fff' }, gradient);
    const group = element('g', { class: 'orb__capsule', 'data-capsule': id }, layer);
    const rect = element('rect', { fill: `url(#${gradientId})` }, group);
    group.addEventListener('click', () => select(id));
    return {
      id, angle, group, rect, gradient, innerStop, outerStop,
      protected: false, overrides: {},
      currentInner: 0, currentOuter: 0, currentWidth: 0, currentRadius: config.radius,
      newbornAt: bornAt, retiringAt: null, written: null,
      lastInnerColor: '#ffffff', lastOuterColor: '#ffffff', lastActivity: 0,
    };
  }

  for (let index = 0; index < desired; index += 1) {
    capsules.push(createCapsule(-Math.PI / 2 + index * TAU / desired));
  }

  function select(id) {
    selectedId = capsules.some((capsule) => capsule.id === id) ? id : null;
    for (const capsule of capsules) capsule.group.classList.toggle('is-selected', capsule.id === selectedId);
    onSelect?.(selectedId);
  }

  function reflow(now) {
    const targets = evenAngles(capsules.map((capsule) => capsule.angle));
    layout = { started: now, items: capsules.map((capsule, index) => ({ capsule, from: capsule.angle, to: targets[index] })) };
    if (!still) return;
    for (const item of layout.items) item.capsule.angle = item.to;
    layout = null;
  }

  function add(amount, now) {
    for (let added = 0; added < amount; added += 1) {
      const gap = Math.floor(clamp(random(), 0, 0.999999) * capsules.length);
      const next = gap === capsules.length - 1 ? capsules[0].angle + TAU : capsules[gap + 1].angle;
      capsules.splice(gap + 1, 0, createCapsule((capsules[gap].angle + next) / 2, still ? null : now));
    }
    reflow(now);
  }

  function remove(capsule) {
    const index = capsules.indexOf(capsule);
    if (index < 0) return;
    capsule.group.remove();
    capsule.gradient.remove();
    capsules.splice(index, 1);
    if (selectedId === capsule.id) select(null);
  }

  /** Уходящая, которую снова надо, возвращается с той прозрачности, где была. */
  function revive(capsule, now) {
    const visibility = 1 - clamp((now - capsule.retiringAt) / config.appearMs);
    capsule.newbornAt = now - visibility * config.appearMs;
    capsule.retiringAt = null;
  }

  /** Привести число капсул к желаемому: вернуть уходящие, убрать лишние, добавить. */
  function reconcile(now) {
    const needed = Math.max(0, capsules.length - desired);
    const retiring = capsules.filter((capsule) => capsule.retiringAt !== null);
    for (const capsule of retiring.slice(needed)) revive(capsule, now);
    const pending = capsules.filter((capsule) => capsule.retiringAt !== null).length;
    if (needed > pending) {
      const removals = removalCandidates(capsules.map(view), needed - pending, random);
      if (!removals) {
        desired = capsules.filter((capsule) => capsule.protected).length;
        return;
      }
      const chosen = removals.map((item) => capsules.find((capsule) => capsule.id === item.id));
      if (still) {
        chosen.forEach(remove);
        reflow(now);
      } else {
        for (const capsule of chosen) capsule.retiringAt = now;
      }
    } else if (needed === 0 && desired > capsules.length) {
      add(desired - capsules.length, now);
    }
  }

  /** Кадр: сдвинуть к равным углам и убрать догоревшие. */
  function advance(now) {
    if (layout) {
      const t = clamp((now - layout.started) / config.reflowMs);
      const amount = t * t * (3 - 2 * t);
      for (const item of layout.items) item.capsule.angle = item.from + (item.to - item.from) * amount;
      if (amount >= 1) layout = null;
    }
  }

  function sweep(now) {
    const finished = capsules.filter((capsule) => capsule.retiringAt !== null && now - capsule.retiringAt >= config.appearMs);
    if (!finished.length) return;
    finished.forEach(remove);
    reflow(now);
    reconcile(now);
  }

  function view(capsule) {
    return { id: capsule.id, protected: capsule.protected, retiring: capsule.retiringAt !== null };
  }

  function setCount(value, now) {
    const protectedCount = capsules.filter((capsule) => capsule.protected).length;
    desired = Math.round(clamp(Number(value), Math.max(1, protectedCount), config.maxCount));
    reconcile(now);
    return desired;
  }

  function update(id, patch, now) {
    const capsule = capsules.find((item) => item.id === id);
    if (!capsule) return false;
    if ('protected' in patch) {
      capsule.protected = Boolean(patch.protected);
      if (capsule.protected && capsule.retiringAt !== null) {
        revive(capsule, now);
        desired = Math.max(desired, capsules.filter((item) => item.protected).length);
        reconcile(now);
      }
    }
    for (const key of OVERRIDES) {
      if (!(key in patch)) continue;
      if (patch[key] === null || patch[key] === undefined) delete capsule.overrides[key];
      else capsule.overrides[key] = patch[key];
    }
    capsule.written = null;
    return true;
  }

  return {
    capsules,
    advance,
    sweep,
    setCount,
    update,
    select,
    count: () => desired,
    onSelect(callback) { onSelect = typeof callback === 'function' ? callback : null; },
  };
}
