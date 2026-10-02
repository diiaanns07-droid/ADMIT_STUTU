// ASHEN OATH — modules/fx/common.js. Владелец: №7 [VFX].
// Общие «кирпичи» хореографий V6: у всех рун один ритм — накопление → выпуск → полёт → удар → послесвечение,
// круг-глиф с символом руны под заклинателем, глиф у ладони, сбор искр, взрыв, послесвечение.
// Всё безопасно при отсутствии подсистем (fx.glyph/bolts/trails/decals/shock могут быть null).

import { runeStroke } from './glyph.js'; // [W4-ЗАКЛИНАНИЯ] штрихи символа для руны в воздухе

const TAU = Math.PI * 2;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const hasVec = (o) => !!o && typeof o === 'object' && isNum(o.x) && isNum(o.y) && isNum(o.z);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeIn = (t) => Math.pow(clamp(t, 0, 1), 2);

// Стихия → строка градиента частиц (kit RAMP) и дым.
export const RAMP = {
  fire: 'fire', storm: 'storm', heal: 'heal', star: 'star', wind: 'wind', eternal: 'eternal', frost: 'frost',
  void: 'void', time: 'time', reset: 'reset', gold: 'gold', earth: 'ember', rival: 'rival', tempest: 'tempest', // [W4-ЗАКЛИНАНИЯ] буря
};
export const SMOKE = { fire: 'firesmoke', frost: 'frostsmoke', void: 'voidsmoke', earth: 'dust' };
export const rampOf = (el, remote) => (remote ? 'rival' : (RAMP[el] || 'gold'));

/**
 * Кто колдует и куда: для своих событий — наш герой → цель (Регент/соперник); для data.remote — соперник → наш герой.
 * Возвращает новый объект (события редки — аллокация допустима).
 */
export function caster(fx, ev, d, opts) {
  const V3 = fx.THREE.Vector3;
  const remote = fx.isRemote(d);
  const o = opts || {};
  const c = {
    remote, rival: remote ? 1 : 0,
    feet: fx.anchor('feet', new V3(), remote),
    chest: fx.anchor('chest', new V3(), remote),
    hand: fx.anchor(o.hand || 'handR', new V3(), remote),
    handL: fx.anchor('handL', new V3(), remote),
    head: fx.anchor('head', new V3(), remote),
    target: new V3(),
    targetGround: new V3(),
    dir: new V3(), fwd: new V3(), right: new V3(), dist: 1,
  };
  // цель: data.to (если это не сам заклинатель) → lockTarget/Регент
  const to = d && hasVec(d.to) ? d.to : null;
  if (to && Math.hypot(to.x - c.chest.x, to.z - c.chest.z) > 0.8) c.target.set(to.x, to.y, to.z);
  else fx.target(c.target, remote);
  c.targetGround.set(c.target.x, fx.groundY(c.target.x, c.target.z, c.target.y - (remote ? 1.25 : 2.6)), c.target.z);
  c.dir.subVectors(c.target, c.hand);
  c.dist = Math.max(0.5, c.dir.length());
  c.dir.multiplyScalar(1 / c.dist);
  c.fwd.set(c.target.x - c.feet.x, 0, c.target.z - c.feet.z);
  if (c.fwd.lengthSq() < 1e-6) c.fwd.set(0, 0, -1);
  c.fwd.normalize();
  c.right.set(-c.fwd.z, 0, c.fwd.x);
  return c;
}

/** Круг-глиф с символом руны под заклинателем: раскрывается, горит, гаснет. */
export function runeCircle(fx, c, rune, el, o) {
  o = o || {};
  const P = fx.pal(el, { remote: c.remote });
  const g = fx.glyph;
  let h = null;
  if (g) {
    try {
      h = g.spawn({
        pos: { x: c.feet.x, y: c.feet.y + 0.04, z: c.feet.z }, radius: o.radius || 1.7, symbol: rune,
        color: P.mid, hot: P.core, intensity: (o.intensity || 1.8) * 0.8, dur: o.dur || 1.8, unfold: o.unfold || 0.3,
        spin: o.spin ?? 0.5, rings: o.rings || 2, ticks: o.ticks || 28, style: o.style || 'rune', rival: c.rival,
        follow: o.follow ? () => fx.anchor('feet', c.feet, c.remote) : null,
      });
      if (h && o.flare !== false) fx.kit.after(o.flareAt ?? 0.05, () => h.flare && h.flare(1));
    } catch (e) { h = null; }
  }
  // запасной вариант и «пыль света» по кольцу
  fx.kit.emit({
    at: c.feet, shape: 'ring', radius: (o.radius || 1.7) * 0.95, count: o.motes ?? 26, dir: { x: 0, y: 1, z: 0 }, cone: 0.15,
    speed: [0.4, 1.4], life: [0.5, 1.1], size: [0.07, 0.01], ramp: rampOf(el, c.remote), intensity: 2.2, sprite: 'spark', rival: c.remote,
  });
  return h;
}

/** Вертикальный глиф у ладони, лицом к цели (накопление каста). */
export function handGlyph(fx, c, rune, el, o) {
  o = o || {};
  const g = fx.glyph;
  if (!g) return null;
  const P = fx.pal(el, { remote: c.remote });
  const at = o.at || c.hand;
  try {
    return g.spawn({
      pos: { x: at.x + c.dir.x * 0.25, y: at.y + c.dir.y * 0.25, z: at.z + c.dir.z * 0.25 },
      normal: { x: c.dir.x, y: c.dir.y, z: c.dir.z }, radius: o.radius || 0.45, symbol: rune,
      color: P.mid, hot: P.core, intensity: o.intensity || 2.4, dur: o.dur || 0.55, unfold: o.unfold || 0.12,
      spin: o.spin ?? 2.2, rings: o.rings || 2, ticks: 16, style: o.style || 'rune', rival: c.rival,
    });
  } catch (e) { return null; }
}

/** Искры, стягивающиеся в точку за time секунд (накопление). */
export function gather(fx, at, el, remote, o) {
  o = o || {};
  const t = o.time || 0.22, R = o.radius || 1.1;
  fx.kit.emit({
    at, shape: 'shell', radius: R, count: o.count || 36, radial: -R / t * 0.95, speed: [0, 0.2], life: [t * 0.9, t * 1.05],
    size: [0.03, 0.09], ramp: rampOf(el, remote), intensity: o.intensity || 2.6, sprite: 'spark', stretch: 0.035, fadeIn: 0.3, curve: 1,
    rival: remote, essential: !!o.essential,
  });
  fx.kit.flash(at, { color: fx.pal(el, { remote }).hot, size: [0.1, o.glow || 0.7], dur: t + 0.08, intensity: 2.2, sprite: 'glow', pull: 0.35, rival: remote, fadeIn: 0.8, curve: 1 });
}

/** Вспышка выпуска: звезда + конус искр вперёд. */
export function muzzle(fx, at, dir, el, remote, o) {
  o = o || {};
  const P = fx.pal(el, { remote });
  fx.kit.flash(at, { color: P.core, size: [0.2, o.size || 1.1], dur: 0.14, intensity: 4, sprite: 'star', pull: 0.35, rival: remote });
  fx.kit.flash(at, { color: P.hot, size: [0.3, (o.size || 1.1) * 1.4], dur: 0.2, intensity: 2.2, sprite: 'glow', pull: 0.35, rival: remote });
  fx.kit.emit({ at, dir, cone: 0.45, count: o.count || 22, speed: [3, 9], life: [0.12, 0.3], size: [0.07, 0.01], ramp: rampOf(el, remote), intensity: 3, sprite: 'spark', stretch: 0.03, drag: 4, rival: remote, essential: true });
}

/**
 * Полёт точки from → to за dur (квадратичная кривая с подъёмом lift), колбэки каждый кадр и в конце.
 * onStep(pos, dir, k, dt) — pos/dir переиспользуются (не хранить!). onHit(pos).
 */
export function fly(fx, from, to, dur, o) {
  const V3 = fx.THREE.Vector3;
  const a = new V3().copy(from), b = new V3().copy(to);
  const lift = o && isNum(o.lift) ? o.lift : 0.4, side = o && isNum(o.side) ? o.side : 0;
  const ctrl = new V3().lerpVectors(a, b, 0.5);
  ctrl.y += lift;
  if (side) { const rx = -(b.z - a.z), rz = b.x - a.x, l = Math.hypot(rx, rz) || 1; ctrl.x += rx / l * side; ctrl.z += rz / l * side; }
  const pos = new V3(), prev = new V3().copy(a), dir = new V3();
  return fx.kit.actor({
    dur,
    update(t, k, dt) {
      const e = o && o.ease ? o.ease(k) : k;
      const u = 1 - e;
      pos.set(u * u * a.x + 2 * u * e * ctrl.x + e * e * b.x, u * u * a.y + 2 * u * e * ctrl.y + e * e * b.y, u * u * a.z + 2 * u * e * ctrl.z + e * e * b.z);
      dir.subVectors(pos, prev);
      if (dir.lengthSq() > 1e-10) dir.normalize(); else dir.subVectors(b, a).normalize();
      prev.copy(pos);
      if (o && o.onStep) o.onStep(pos, dir, k, dt);
    },
    end() { if (o && o.onHit) o.onHit(b); },
  });
}

/** Взрыв: вспышки, огненный шар, искры, кольцо по земле, дым, свет, тряска. scale ~1. */
export function explosion(fx, at, ground, el, remote, o) {
  o = o || {};
  const s = o.scale || 1, P = fx.pal(el, { remote }), R = rampOf(el, remote), kit = fx.kit;
  kit.flash(at, { color: P.core, size: [0.6 * s, 2.8 * s], dur: 0.2, intensity: 4.5, sprite: 'star', pull: 0.6, rival: remote });
  kit.flash(at, { color: P.hot, size: [0.9 * s, 3.4 * s], dur: 0.38, intensity: 2.0, sprite: 'glow', pull: 0.6, rival: remote });
  // огненный шар / облако стихии
  kit.emit({ at, radius: 0.35 * s, count: 34 * s, speed: [1.5 * s, 4.5 * s], life: [0.35, 0.75], size: [0.55 * s, 1.5 * s], ramp: o.ballRamp || R, intensity: 2.4, sprite: o.ballSprite || 'flame', drag: 3.5, gravity: -1.5, turb: 0.8, spin: [-1.5, 1.5], rival: remote, essential: true });
  // искры
  kit.emit({ at, count: 70 * s, speed: [4 * s, 12 * s], life: [0.35, 0.9], size: [0.07, 0.015], ramp: R, intensity: 3.2, sprite: 'spark', stretch: 0.035, gravity: 7, drag: 1.4, ground: ground.y + 0.03, rival: remote, essential: true });
  // кольцо по земле
  if (o.ring !== false) {
    kit.emit({ at: { x: ground.x, y: ground.y + 0.08, z: ground.z }, shape: 'ring', radius: 0.35 * s, count: 56 * s, radial: 9 * s, speed: [0, 0.4], dir: { x: 0, y: 1, z: 0 }, cone: 0.2, life: [0.25, 0.5], size: [0.45 * s, 0.1], ramp: R, intensity: 2.6, sprite: o.ringSprite || 'ember', drag: 4.5, rival: remote, essential: true });
    if (fx.shock) { try { fx.shock.ring({ pos: { x: ground.x, y: ground.y + 0.05, z: ground.z }, r0: 0.3, r1: 5.5 * s, dur: 0.5, color: P.mid, hot: P.core, intensity: 2, rival: remote ? 1 : 0 }); } catch (e) { /* ignore */ } }
  }
  if (fx.shock && o.sphere !== false) { try { fx.shock.sphere({ pos: at, r0: 0.2, r1: 1.9 * s, dur: 0.3, color: P.hot, hot: P.core, intensity: 0.9, rival: remote ? 1 : 0 }); } catch (e) { /* ignore */ } }
  // дым
  if (o.smoke !== false) {
    kit.emit({ at, radius: 0.6 * s, count: 22 * s, speed: [0.3, 1.4], life: [1.4, 2.6], size: [0.9 * s, 2.4 * s], ramp: SMOKE[el] || 'smoke', intensity: 1, sprite: 'smoke', blend: 'alpha', drag: 1.2, gravity: -0.7, turb: 0.5, spin: [-0.6, 0.6], delay: 0.12, rival: remote });
  }
  kit.light(at, { color: P.hot, intensity: 1.6 * s, range: 14, dur: 0.6, attack: 0.04 });
  if (kit.distort) kit.distort(at, 0.6 * s);
  kit.shake(o.shake ?? 0.32 * s);
  kit.hitstop(o.hitstop ?? 55 * s);
}

/** Послесвечение: тлеющие искры/угольки медленно поднимаются dur секунд. */
export function afterglow(fx, at, el, remote, o) {
  o = o || {};
  fx.kit.emit({
    at, radius: o.radius || 0.8, count: o.count || 30, dir: { x: 0, y: 1, z: 0 }, cone: 0.5, speed: [0.2, 0.9], life: [0.8, 1.8],
    size: [0.05, 0.01], ramp: o.ramp || rampOf(el, remote), intensity: 2.2, sprite: o.sprite || 'ember', turb: 0.35, gravity: -0.3, drag: 0.8,
    delay: o.dur || 1.5, rival: remote,
  });
}

/** Декаль на земле (если есть подсистема). */
export function decal(fx, at, kind, radius, el, remote, o) {
  if (!fx.decals) return null;
  const P = fx.pal(el, { remote });
  try { return fx.decals.spawn({ pos: at, radius, kind, life: (o && o.life) || 7, color: P.mid, hot: P.core, intensity: (o && o.intensity) || 1.4, rival: remote ? 1 : 0 }); } catch (e) { return null; }
}

/** Лента-след (если есть подсистема). */
export function trail(fx, el, remote, o) {
  if (!fx.trails) return null;
  const P = fx.pal(el, { remote });
  try { return fx.trails.create({ color: P.mid, hot: P.core, rival: remote ? 1 : 0, ...o }); } catch (e) { return null; }
}

export { TAU, isNum, hasVec };

// ====================================================================== [W4-ЗАКЛИНАНИЯ] читаемость заклинаний
// Жюри сидит в 3–5 м от проектора: каждое заклинание должно сразу читаться — что вылетело, откуда и куда.
//  - herald()  — предвестник: в момент распознавания жеста у руки вспышка и руна (0,15 с) — жест связан с эффектом;
//  - airRune() — нарисованный символ вспыхивает крупно в воздухе перед героем и «становится» заклинанием;
//  - createComet() — единый облик снаряда в полёте: белое ядро + цветной ореол + 2–3 слоя частиц + лента-след
//    + короткий свет из общего пула (на low kit.light → null), голова крупнее хвоста — видно направление.
// Всё — частицы kit (один вызов отрисовки на все), ленты trails и знаки glyph (по одному вызову на подсистему).


const HERALD_SYM = { fire: 'fire', storm: 'storm', void: 'vee', wind: 'spira', tempest: 'storm', frost: 'frost', earth: 'earth', heal: 'orbis', star: 'stella', eternal: 'lemnis', time: 'clepsydra', reset: 'alpha', gold: 'fire', rival: 'storm' };
/** Символ для предвестника: руна → сама руна, иначе знак стихии. */
export const heraldSymbol = (el, rune) => (typeof rune === 'string' && rune ? rune : (HERALD_SYM[el] || 'fire'));

// предвыделенные опции (события редки, но emit/flash зовутся много раз — без лишних объектов)
const _hf = { color: 0, size: [0, 0], dur: 0.15, intensity: 4, sprite: 'star', pull: 0.35, rival: false, rot: 0, fadeIn: 0.02, curve: 0.45 };
const _he = { at: null, dir: null, cone: Math.PI, count: 8, speed: [1.5, 4], life: [0.12, 0.22], size: [0.05, 0.01], ramp: 'gold', intensity: 3, sprite: 'spark', stretch: 0.025, drag: 4, rival: false, essential: true };

/**
 * Предвестник у руки: белая звезда + цветное кольцо-волна + руна-спрайт (0,15 с), искры; на medium/high — чёткий
 * знак glyph поверх (одна запись пула, без новых вызовов отрисовки). o: { symbol, scale:1, dir (к цели), glyph:true }.
 */
export function herald(fx, at, el, remote, o) {
  if (!at || !isNum(at.x)) return;
  o = o || {};
  const kit = fx.kit, P = fx.pal(el, { remote }), k = isNum(o.scale) ? o.scale : 1;
  const sf = (() => { try { return fx.reduced() ? 0.7 : 1; } catch (e) { return 1; } })();
  _hf.rival = !!remote; _hf.fadeIn = 0.02; _hf.curve = 0.45;
  // белая звезда — «щелчок» распознавания
  _hf.color = P.core; _hf.size[0] = 0.12 * k; _hf.size[1] = 0.95 * k * sf; _hf.dur = 0.15; _hf.intensity = 4.4; _hf.sprite = 'star'; _hf.pull = 0.4; _hf.rot = 0;
  kit.flash(at, _hf);
  // кольцо-волна цвета стихии
  _hf.color = P.mid; _hf.size[0] = 0.18 * k; _hf.size[1] = 1.25 * k * sf; _hf.dur = 0.16; _hf.intensity = 3; _hf.sprite = 'ring'; _hf.pull = 0.38; _hf.rot = 0;
  kit.flash(at, _hf);
  // руна-спрайт (атлас kit) — видна и на low, где знаки glyph экономятся
  _hf.color = P.hot; _hf.size[0] = 0.55 * k; _hf.size[1] = 0.7 * k; _hf.dur = 0.15; _hf.intensity = 3.2; _hf.sprite = 'rune'; _hf.pull = 0.42; _hf.rot = (Math.random() - 0.5) * 0.4;
  kit.flash(at, _hf);
  _he.at = at; _he.dir = o.dir || null; _he.cone = o.dir ? 0.9 : Math.PI; _he.count = 9; _he.ramp = rampOf(el, remote); _he.rival = !!remote;
  kit.emit(_he);
  _he.at = null; _he.dir = null;
  // чёткий знак у руки (глиф): только medium/high — на low пул знаков мал (5), его берегут руны
  const g = fx.glyph;
  if (g && o.glyph !== false && kit.Q && kit.Q.glyphDetail > 0) {
    try {
      g.spawn({
        pos: at, billboard: true, radius: 0.36 * k, symbol: heraldSymbol(el, o.symbol), symbolScale: 0.62, style: 'rune', rings: 1, ticks: 12,
        color: P.mid, hot: P.core, intensity: 2.6, symbolGlow: 2, write: 0, flare: 1, pop: 0.45, unfold: 0.08, dur: 0.2, fade: 0.08, spin: 3,
        rival: remote ? 1 : 0, dark: el === 'void' && !remote,
      });
    } catch (e) { /* без знака */ }
  }
}

// ---------------------------------------------------------------------- руна в воздухе
const STROKE_CACHE = new Map();
function strokeOf(rune) {
  if (STROKE_CACHE.has(rune)) return STROKE_CACHE.get(rune);
  let pts = null;
  try { pts = runeStroke(rune, 28); } catch (e) { pts = null; }
  STROKE_CACHE.set(rune, pts);
  return pts;
}
const _ae = { at: null, count: 1, speed: [0.2, 1.2], life: [0.18, 0.34], size: [0.07, 0.015], ramp: 'gold', intensity: 3, sprite: 'spark', drag: 2.5, rival: false, essential: false, dir: null, cone: Math.PI, stretch: 0 };
const _ap = { x: 0, y: 0, z: 0 };
const _gs = { to: null, travelAt: 0, travelDur: 0.14, shrink: 0.3 };

/**
 * Руна в воздухе: символ крупно вспыхивает перед героем (знак glyph «bare» без колец, лицом к камере, белое ядро
 * линий + цвет стихии, вспышка и искры по штрихам), держится hold с и «становится» заклинанием — в момент launchAt
 * знак рассыпается искрами и улетает (mode):
 *   'through' — к цели (снаряд вылетает из знака и «прошивает» его), 'absorb' — втягивается в точку to (в героя),
 *   'up' — уходит вверх (молния с неба). Хореография руны в своём обработчике rune_cast вызывает air.plan(mode, to)
 *   и выпускает заклинание из air.pos в момент air.launchAt (часы kit); без plan — 'through' к цели.
 * c — caster(); o: { pos, hold:0.22, travel:0.14, radius:0.95, mode, to, glyph:true, burst:true, write:0.09, intensity }.
 * Возвращает air: { rune, el, remote, pos, radius, t0, launchAt, hold, mode, to, glyph, plan(mode, to), released }.
 */
export function airRune(fx, c, rune, el, o) {
  o = o || {};
  const V3 = fx.THREE.Vector3, kit = fx.kit;
  const remote = c.remote, P = fx.pal(el, { remote });
  const R = (isNum(o.radius) ? o.radius : 0.95) * (fx.reduced && fx.reduced() ? 0.85 : 1);
  // перед героем: на линии к цели, выше плеча — с камеры за спиной знак не закрыт героем
  const pos = o.pos ? new V3().copy(o.pos) : new V3(c.chest.x + c.fwd.x * 1.7, c.chest.y + 0.62, c.chest.z + c.fwd.z * 1.7);
  const hold = isNum(o.hold) ? o.hold : 0.22, travel = isNum(o.travel) ? o.travel : 0.14;
  const air = {
    rune, el, remote, pos, radius: R, t0: kit.clock, launchAt: kit.clock + hold, hold,
    mode: o.mode || 'through', to: new V3(), glyph: null, released: false,
    plan(mode, to) {
      if (air.released) return air;
      if (typeof mode === 'string') air.mode = mode;
      if (to && isNum(to.x)) air.to.set(to.x, to.y, to.z); else defaultTo();
      return air;
    },
  };
  function defaultTo() {
    if (air.mode === 'absorb') air.to.copy(c.chest);
    else if (air.mode === 'up') air.to.set(pos.x + c.fwd.x * 1.5, pos.y + 3.2, pos.z + c.fwd.z * 1.5);
    else air.to.set(pos.x + (c.target.x - pos.x) * 0.35, pos.y + (c.target.y - pos.y) * 0.35, pos.z + (c.target.z - pos.z) * 0.35);
  }
  if (o.to && isNum(o.to.x)) air.to.set(o.to.x, o.to.y, o.to.z); else defaultTo();
  const g = fx.glyph;
  if (g && o.glyph !== false) {
    try {
      air.glyph = g.spawn({
        pos, billboard: true, radius: R, symbol: rune, symbolScale: 0.8, style: 'bare', color: P.mid, hot: P.core,
        intensity: isNum(o.intensity) ? o.intensity : 2.8, symbolGlow: 2.6, write: isNum(o.write) ? o.write : 0.09, flare: 1, pop: 0.35, unfold: 0.12,
        dur: hold + travel + 0.1, fade: 0.08, spin: 0, rival: remote ? 1 : 0, dark: el === 'void' && !remote,
      });
    } catch (e) { air.glyph = null; }
  }
  const gen = air.glyph ? air.glyph.gen : -1;
  // вспышка-ореол за знаком (bloom)
  _hf.rival = !!remote; _hf.fadeIn = 0.03; _hf.curve = 0.5; _hf.rot = 0;
  _hf.color = P.hot; _hf.size[0] = R * 0.8; _hf.size[1] = R * 2.4; _hf.dur = 0.26; _hf.intensity = 2.2; _hf.sprite = 'glow'; _hf.pull = 0.2;
  kit.flash(pos, _hf);
  _hf.color = P.core; _hf.size[0] = R * 0.3; _hf.size[1] = R * 1.3; _hf.dur = 0.12; _hf.intensity = 3.6; _hf.sprite = 'star'; _hf.pull = 0.25;
  kit.flash(pos, _hf);
  if (!air.glyph && o.glyph !== false) {
    // без подсистемы знаков — руна-спрайт атласа
    _hf.color = P.mid; _hf.size[0] = R * 1.6; _hf.size[1] = R * 1.9; _hf.dur = hold + travel; _hf.intensity = 3; _hf.sprite = 'rune'; _hf.pull = 0.2;
    kit.flash(pos, _hf);
  }
  // искры по штрихам символа — знак «вспыхивает»
  const pts = o.burst === false ? null : strokeOf(rune);
  if (pts) {
    const cam = kit.camera;
    let ux = 1, uy = 0, uz = 0, vx = 0, vy = 1, vz = 0;
    if (cam && cam.matrixWorld) { const e = cam.matrixWorld.elements; ux = e[0]; uy = e[1]; uz = e[2]; vx = e[4]; vy = e[5]; vz = e[6]; }
    const side = 0.8 * 1.3 * R;
    _ae.ramp = rampOf(el, remote); _ae.rival = !!remote; _ae.at = _ap; _ae.count = 1;
    const st = kit.Q && kit.Q.name === 'low' ? 2 : 1;
    for (let i = 0; i < pts.length; i += st) {
      const q = pts[i], lx = (q.x - 0.5) * side, ly = (0.5 - q.y) * side;
      _ap.x = pos.x + ux * lx + vx * ly; _ap.y = pos.y + uy * lx + vy * ly; _ap.z = pos.z + uz * lx + vz * ly;
      _ae.sprite = i & 1 ? 'spark' : 'glow'; _ae.size[0] = i & 1 ? 0.07 : 0.16; _ae.intensity = i & 1 ? 3 : 2;
      kit.emit(_ae);
    }
    _ae.at = null;
  }
  // превращение в момент выпуска: знак рассыпается искрами к цели заклинания и улетает за ними
  kit.after(hold, () => {
    air.released = true;
    const h = air.glyph;
    if (h && h.alive && h.gen === gen) {
      _gs.to = air.to; _gs.travelAt = undefined; _gs.travelDur = travel; _gs.shrink = air.mode === 'absorb' ? 0.12 : 0.3;
      try { h.set(_gs); h.flare(1); } catch (e) { /* без полёта */ }
      _gs.to = null;
    }
    kit.emit({ at: pos, to: air.to, shape: 'line', count: 16, speed: [0.3, 1.2], life: [0.12, 0.24], size: [0.08, 0.015], ramp: rampOf(el, remote), intensity: 3, sprite: 'spark', drag: 3, rival: remote, essential: true });
    _hf.rival = !!remote; _hf.color = P.core; _hf.size[0] = R * 0.25; _hf.size[1] = R * 1.1; _hf.dur = 0.12; _hf.intensity = 3.8; _hf.sprite = 'star'; _hf.pull = 0.25; _hf.rot = 0; _hf.fadeIn = 0.02; _hf.curve = 0.45;
    kit.flash(pos, _hf);
  });
  return air;
}

// ---------------------------------------------------------------------- комета (снаряд в полёте)
// Слой 2 — частицы стихии: огонь — языки пламени (вверх), гроза/буря — длинные искры, тьма — дымные «перья»
// и чёрное ядро, ветер — изумрудные листья по спирали; прочие — искры своей рампы.
const COMET_LOOK = {
  fire:    { sprite: 'flame', ramp: 'flame', grav: -1.6, turb: 0.5, stretch: 0, size: 0.9, trail: 'fire' },
  storm:   { sprite: 'spark', ramp: 'storm', grav: 0, turb: 0.2, stretch: 0.05, size: 0.35, trail: 'energy' },
  tempest: { sprite: 'spark', ramp: 'tempest', grav: 0, turb: 0.3, stretch: 0.06, size: 0.35, trail: 'energy' },
  void:    { sprite: 'wisp', ramp: 'void', grav: -0.4, turb: 0.6, stretch: 0, size: 0.8, trail: 'dark' },
  wind:    { sprite: 'leaf', ramp: 'wind', grav: -0.2, turb: 0.9, stretch: 0, size: 0.45, trail: 'energy' },
};
const COMET_DEF = { sprite: 'spark', ramp: null, grav: 0.6, turb: 0.2, stretch: 0.03, size: 0.35, trail: 'energy' };
const COMET_POOL = 24;

/**
 * createComet(fx) → { start(pos, el, o) → comet|null, active() }.
 * comet.step(pos, dir?, dt) — каждый кадр полёта (pos/dir можно переиспользовать), comet.end(hitPos?) — конец.
 * o: { size:0.3 (м, радиус головы), remote, light:true, lightK:1, dur (сек, для света), trail:true, trailWidth,
 *      ramp (своя рампа слоя искр), look (стихия облика, по умолчанию el), scope (сцена kit; по умолчанию текущая),
 *      rate:1 (доля частиц: очередь снарядов — реже; на low ещё ×0.7) }.
 */
export function createComet(fx) {
  const V3 = fx.THREE.Vector3, kit = fx.kit;
  const pool = [];
  const live = [];
  const eCore = { at: null, to: null, shape: 'point', count: 1, speed: [0, 0.05], life: [0.06, 0.08], size: [0.3, 0.2], sizeVar: 0.1, ramp: 'whiteHold', intensity: 3, sprite: 'glow', fadeIn: 0.05, essential: true, rival: false };
  const eHalo = { at: null, to: null, shape: 'point', count: 1, speed: [0, 0.08], life: [0.09, 0.13], size: [0.7, 0.45], sizeVar: 0.15, ramp: 'gold', intensity: 1.7, sprite: 'glow', fadeIn: 0.1, essential: true, rival: false };
  const eDark = { at: null, to: null, shape: 'point', count: 1, speed: [0, 0.05], life: [0.07, 0.09], size: [0.24, 0.18], sizeVar: 0.05, ramp: 'darkcore', intensity: 1, sprite: 'dot', blend: 'alpha', fadeIn: 0.05, essential: true, rival: false };
  const eTail = { at: null, radius: 0.08, count: 1, dir: null, cone: 0.5, speed: [0.5, 2.2], life: [0.16, 0.32], size: [0.06, 0.01], ramp: 'gold', intensity: 3, sprite: 'spark', stretch: 0.035, drag: 2.6, gravity: 0.8, essential: false, rival: false };
  const eEl = { at: null, radius: 0.1, count: 1, dir: null, cone: 1.1, speed: [0.3, 1.2], life: [0.22, 0.42], size: [0.3, 0.06], ramp: 'gold', intensity: 2.2, sprite: 'spark', stretch: 0, drag: 2, gravity: 0, turb: 0, spin: [-3, 3], essential: false, rival: false };
  const kLight = { color: 0xffffff, intensity: 0.6, range: 7, dur: 0.6, attack: 0.1, follow: null };

  function make() {
    const c = {
      alive: false, el: 'gold', look: COMET_DEF, P: null, remote: false, size: 0.3, ramp: 'gold', dark: false,
      pos: new V3(), prev: new V3(), dir: new V3(0, 0, -1), back: new V3(0, 0, 1), lp: new V3(), started: false,
      accA: 0, accB: 0, accC: 0, tr: null, scope: null, follow: null, rate: 1,
      step(p, d, dt) { stepC(c, p, d, dt); },
      end(hit) { endC(c, hit); },
    };
    c.follow = () => c.lp;
    return c;
  }
  for (let i = 0; i < 6; i++) pool.push(make());

  function start(p, el, o) {
    if (!p || !isNum(p.x)) return null;
    o = o || {};
    if (live.length >= COMET_POOL) endC(live[0]);
    const c = pool.pop() || make();
    const remote = !!o.remote;
    const lookEl = o.look || el;
    c.alive = true; c.el = el; c.remote = remote; c.look = COMET_LOOK[remote ? '' : lookEl] || COMET_DEF;
    c.P = fx.pal(el, { remote });
    c.size = isNum(o.size) ? o.size : 0.3;
    c.rate = clamp(isNum(o.rate) ? o.rate : 1, 0.1, 1) * (kit.Q && kit.Q.name === 'low' ? 0.7 : 1);
    c.ramp = o.ramp || rampOf(el, remote);
    c.dark = lookEl === 'void' && !remote;
    c.pos.copy(p); c.prev.copy(p); c.lp.copy(p); c.started = false;
    c.accA = 0; c.accB = 0; c.accC = 0;
    c.scope = o.scope !== undefined ? o.scope : kit.currentScope;
    c.tr = null;
    if (o.trail !== false && fx.trails) {
      try {
        const style = c.look.trail;
        c.tr = fx.trails.create({
          style, width: isNum(o.trailWidth) ? o.trailWidth : c.size * 1.25, life: isNum(o.trailLife) ? o.trailLife : 0.28, head: 1.1, taper: 1,
          color: c.P.mid, hot: style === 'dark' ? c.P.hot : c.P.core, intensity: 2.4, rival: remote ? 1 : 0, maxPoints: 26, minDist: 0.06,
        });
        if (c.tr) c.tr.push(p);
      } catch (e) { c.tr = null; }
    }
    if (o.light !== false) {
      kLight.color = c.P.hot; kLight.intensity = 0.55 * (isNum(o.lightK) ? o.lightK : 1); kLight.range = 7;
      kLight.dur = isNum(o.dur) ? o.dur + 0.1 : 0.7; kLight.follow = c.follow;
      kit.light(p, kLight);
      kLight.follow = null;
    }
    live.push(c);
    return c;
  }
  function stepC(c, p, d, dt) {
    if (!c.alive || !p) return;
    c.prev.copy(c.pos);
    c.pos.set(p.x, p.y, p.z);
    c.lp.copy(c.pos);
    if (d && isNum(d.x) && (d.x * d.x + d.y * d.y + d.z * d.z) > 1e-8) c.dir.set(d.x, d.y, d.z).normalize();
    else { c.dir.subVectors(c.pos, c.prev); if (c.dir.lengthSq() > 1e-10) c.dir.normalize(); }
    c.back.copy(c.dir).multiplyScalar(-1);
    if (c.tr) c.tr.push(c.pos);
    if (!(dt > 0)) return;
    const prevScope = kit.enterScope(c.scope);
    if (c.scope) kit.touchScope(c.scope, 0.25);
    const s = c.size, seg = c.started ? c.prev.distanceTo(c.pos) : 0;
    c.started = true;
    // голова: ядро и ореол вдоль пройденного за кадр отрезка — на 30 кадрах/с голова сплошная, а не пунктир
    // доля rate — дробное число частиц (kit округляет вероятностно): голова реже, но не пропадает надолго
    const nHead = Math.min(4, 1 + Math.floor(seg / Math.max(0.12, s * 0.9))) * Math.max(0.5, c.rate);
    const line = seg > 0.02;
    eHalo.at = line ? c.prev : c.pos; eHalo.to = line ? c.pos : null; eHalo.shape = line ? 'line' : 'point'; eHalo.count = nHead;
    eHalo.ramp = c.ramp; eHalo.rival = c.remote; eHalo.size[0] = s * 2.5; eHalo.size[1] = s * 1.7;
    kit.emit(eHalo);
    if (c.dark) {
      eDark.at = eHalo.at; eDark.to = eHalo.to; eDark.shape = eHalo.shape; eDark.count = nHead; eDark.size[0] = s * 0.95; eDark.size[1] = s * 0.75;
      kit.emit(eDark);
      // тьма: вместо белого ядра — светлый фиолетовый ободок вокруг чёрной сердцевины
      eCore.size[0] = s * 1.2; eCore.size[1] = s * 0.95; eCore.ramp = 'void'; eCore.sprite = 'ring';
    } else { eCore.size[0] = s * 1.05; eCore.size[1] = s * 0.7; eCore.ramp = 'whiteHold'; eCore.sprite = 'glow'; }
    eCore.at = eHalo.at; eCore.to = eHalo.to; eCore.shape = eHalo.shape; eCore.count = nHead; eCore.rival = c.remote;
    kit.emit(eCore);
    // слой 1: искры-хвост назад по полёту
    c.accA += dt * 46 * c.rate;
    let n = Math.floor(c.accA);
    if (n > 0) {
      c.accA -= n; if (n > 5) n = 5;
      eTail.at = c.pos; eTail.dir = c.back; eTail.count = n; eTail.ramp = n & 1 ? c.ramp : (c.dark ? 'void' : 'white'); eTail.radius = s * 0.5; eTail.rival = c.remote;
      eTail.size[0] = Math.max(0.05, s * 0.22);
      kit.emit(eTail);
    }
    // слой 2: частицы стихии
    const L = c.look;
    c.accB += dt * 24 * c.rate;
    n = Math.floor(c.accB);
    if (n > 0) {
      c.accB -= n; if (n > 3) n = 3;
      eEl.at = c.pos; eEl.dir = c.back; eEl.count = n; eEl.sprite = L.sprite; eEl.ramp = c.remote ? 'rival' : (L.ramp || c.ramp); eEl.rival = c.remote;
      eEl.gravity = L.grav; eEl.turb = L.turb; eEl.stretch = L.stretch; eEl.radius = s * 0.6;
      eEl.size[0] = s * L.size; eEl.size[1] = s * L.size * 0.25;
      kit.emit(eEl);
    }
    kit.enterScope(prevScope);
  }
  function endC(c, hit) {
    if (!c.alive) return;
    c.alive = false;
    if (c.tr) { if (hit && isNum(hit.x)) c.tr.push(hit); c.tr.stop(); c.tr = null; }
    c.scope = null;
    const i = live.indexOf(c);
    if (i >= 0) live.splice(i, 1);
    if (pool.length < COMET_POOL) pool.push(c);
  }
  function clear() { while (live.length) endC(live[live.length - 1]); }
  return { start, active: () => live.length, clear };
}
