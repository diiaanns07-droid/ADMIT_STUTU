// ASHEN OATH — modules/fx/common.js. Владелец: №7 [VFX].
// Общие «кирпичи» хореографий V6: у всех рун один ритм — накопление → выпуск → полёт → удар → послесвечение,
// круг-глиф с символом руны под заклинателем, глиф у ладони, сбор искр, взрыв, послесвечение.
// Всё безопасно при отсутствии подсистем (fx.glyph/bolts/trails/decals/shock могут быть null).

const TAU = Math.PI * 2;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const hasVec = (o) => !!o && typeof o === 'object' && isNum(o.x) && isNum(o.y) && isNum(o.z);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeIn = (t) => Math.pow(clamp(t, 0, 1), 2);

// Стихия → строка градиента частиц (kit RAMP) и дым.
export const RAMP = {
  fire: 'fire', storm: 'storm', heal: 'heal', star: 'star', wind: 'wind', eternal: 'eternal', frost: 'frost',
  void: 'void', time: 'time', reset: 'reset', gold: 'gold', earth: 'ember', rival: 'rival',
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
        color: P.mid, hot: P.core, intensity: o.intensity || 1.8, dur: o.dur || 1.8, unfold: o.unfold || 0.3,
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
  kit.flash(at, { color: P.core, size: [0.6 * s, 3.2 * s], dur: 0.22, intensity: 5, sprite: 'star', pull: 0.6, rival: remote });
  kit.flash(at, { color: P.hot, size: [1.0 * s, 4.2 * s], dur: 0.42, intensity: 2.6, sprite: 'glow', pull: 0.6, rival: remote });
  // огненный шар / облако стихии
  kit.emit({ at, radius: 0.35 * s, count: 34 * s, speed: [1.5 * s, 4.5 * s], life: [0.35, 0.75], size: [0.55 * s, 1.5 * s], ramp: o.ballRamp || R, intensity: 2.4, sprite: o.ballSprite || 'flame', drag: 3.5, gravity: -1.5, turb: 0.8, spin: [-1.5, 1.5], rival: remote, essential: true });
  // искры
  kit.emit({ at, count: 70 * s, speed: [4 * s, 12 * s], life: [0.35, 0.9], size: [0.07, 0.015], ramp: R, intensity: 3.2, sprite: 'spark', stretch: 0.035, gravity: 7, drag: 1.4, ground: ground.y + 0.03, rival: remote, essential: true });
  // кольцо по земле
  if (o.ring !== false) {
    kit.emit({ at: { x: ground.x, y: ground.y + 0.08, z: ground.z }, shape: 'ring', radius: 0.35 * s, count: 56 * s, radial: 9 * s, speed: [0, 0.4], dir: { x: 0, y: 1, z: 0 }, cone: 0.2, life: [0.25, 0.5], size: [0.45 * s, 0.1], ramp: R, intensity: 2.6, sprite: o.ringSprite || 'ember', drag: 4.5, rival: remote, essential: true });
    if (fx.shock) { try { fx.shock.ring({ pos: { x: ground.x, y: ground.y + 0.05, z: ground.z }, r0: 0.3, r1: 5.5 * s, dur: 0.5, color: P.mid, hot: P.core, intensity: 2, rival: remote ? 1 : 0 }); } catch (e) { /* ignore */ } }
  }
  if (fx.shock && o.sphere !== false) { try { fx.shock.sphere({ pos: at, r0: 0.2, r1: 2.6 * s, dur: 0.35, color: P.hot, hot: P.core, intensity: 1.4, rival: remote ? 1 : 0 }); } catch (e) { /* ignore */ } }
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
  try { return fx.decals.spawn({ pos: at, radius, kind, life: (o && o.life) || 7, color: P.mid, hot: P.core, intensity: 1.6, rival: remote ? 1 : 0 }); } catch (e) { return null; }
}

/** Лента-след (если есть подсистема). */
export function trail(fx, el, remote, o) {
  if (!fx.trails) return null;
  const P = fx.pal(el, { remote });
  try { return fx.trails.create({ color: P.mid, hot: P.core, rival: remote ? 1 : 0, ...o }); } catch (e) { return null; }
}

export { TAU, isNum, hasVec };
