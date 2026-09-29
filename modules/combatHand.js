// ASHEN OATH — [HAND] бой для лука и магии рукой: способности 'arrow' и 'hand_orb'. Владелец: №6 [HAND].
// Чистая симуляция (без DOM и Three), подключается к modules/combat.js хуками с тегом [HAND]:
//   const hand = createCombatHand(api)   — api даёт combat.js изнутри замыкания (см. хук там);
//   hand.readInput(input)                — каждый кадр после чтения ввода (input.bow / input.handSpell, контракт C2);
//   hand.clearInput()                    — кадр ввода невалиден;
//   hand.step(h)                         — каждый фиксированный шаг: выстрелы, полёт, попадания, горение, цепь, дождь;
//   hand.decorateSnapshot(snap)          — снаряды в snap.projectiles (kind 'arrow' | 'hand_orb' + element),
//                                          snap.player.bow / handSpell, откаты в snap.cooldowns;
//   hand.reset() / hand.clear()          — новый бой / исход боя.
// Попадания — по Регенту (вертикальный цилиндр, как у болтов) и по целям registerTarget({...}) — это
// соперник PvP (№3 [PVP]): { id, kind:'player', getPosition()→{x,y,z} (ступни), radius, height, onHit(hit) }.
// hit = { damage, element, kind, projectileId, point, dir{x,y,z}, charged, twoHand, knockback{x,z}|null,
//         slowSec, burnSec, burnDps, chain } — урон сопернику применяет сама цель (по сети).
// События (контракт C3): bow_draw_start, bow_draw {draw}, bow_release {draw, charged, element}, arrow_hit {damage, element},
// hand_spell_form {element, power}, hand_spell_throw {element, power, dir}, hand_spell_hit {element, damage},
// hand_spell_cancel; дополнительно: bow_cancel, bow_element {element, rune}, arrow_rain {center, radius, delay, count},
// hand_chain {from, to}, element_apply {element, target, duration}, projectile_impact (для modules/effects.js).

export const HAND_COMBAT_VERSION = 'HAND-combat-1';

export const HAND_COMBAT_DEFAULTS = Object.freeze({
  arrow: Object.freeze({
    speedMin: 24, speedMax: 62,      // м/с по натяжению
    gravity: 9,                      // м/с² — стрела летит дугой
    damageMin: 7, damageMax: 36,     // по натяжению (draw^1.2)
    chargedMul: 1.4,                 // заряженная (полное натяжение 0,35 с)
    rapidMul: 0.55,                  // серия недонатянутых — слабые стрелы
    radius: 0.12, lifetime: 3.2,
    energy: 4, energyCharged: 8, cooldown: 0.22,
    pierce: 1,                       // заряженная пробивает цель и летит дальше
    spawnHeight: 1.5, spawnForward: 0.55,
    aimYawDeg: 28, aimPitchDeg: 22, liftDeg: 3,
    assistDeg: 12, assistK: 0.85,    // мягкий аим-ассист к цели в конусе
    maxLive: 18,
  }),
  rain: Object.freeze({ count: 10, radius: 3.4, delay: 0.85, damage: 8, energy: 22, cooldown: 6, height: 16, speed: 34, reach: 16 }),
  orb: Object.freeze({
    speedMin: 14, speedMax: 22, damageMin: 14, damageMax: 48, twoHandMul: 1.7,
    radiusMin: 0.2, radiusMax: 0.42, twoHandRadius: 1.5,
    energyBase: 8, energyPower: 12, twoHandEnergy: 1.5, cooldown: 0.8,
    lifetime: 3, homing: 3.2, assistDeg: 18, dirYawDeg: 35, dirPitchDeg: 20,
    spawnHeight: 1.45, spawnForward: 0.5, spawnSide: 0.3, splash: 2.4, maxLive: 6,
  }),
  fire: Object.freeze({ burnSec: 3, burnDps: 6, tick: 0.5 }),
  storm: Object.freeze({ chainMul: 0.45, chainDelay: 0.18 }),
  frost: Object.freeze({ slowSec: 2.5, orbSlowSec: 3.5 }),
  earth: Object.freeze({ knockback: 6, staggerSec: 0.45, orbStunSec: 0.6 }),
  drawEventStep: 0.1, drawEventMs: 90,
  lockConeDeg: 40,                   // цель стрелы/сгустка/дождя — только в этом конусе от линии прицела
});

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const num = (v, d = 0) => (fin(v) ? v : d);
const ELS = ['fire', 'storm', 'frost', 'earth'];
const elem = (e) => (ELS.includes(e) ? e : null);
const DEG = Math.PI / 180;
const IDLE_BOW = Object.freeze({ active: false, phase: 'idle', draw: 0, aimX: 0, aimY: 0, charged: false, element: null });
const IDLE_SPELL = Object.freeze({ phase: 'idle', element: 'fire', power: 0, size: 0, twoHand: false });

// Пролёт отрезка a0→a1 сквозь вертикальный цилиндр (основание b, радиус r, высота yMin..yMax над основанием).
function sweptCylinder(a0, a1, b, r, yMin, yMax) {
  const px = a0.x - b.x, pz = a0.z - b.z, dx = a1.x - a0.x, dz = a1.z - a0.z;
  const A = dx * dx + dz * dz, B = px * dx + pz * dz, Cc = px * px + pz * pz - r * r;
  let t0, t1;
  if (A < 1e-12) { if (Cc > 0) return -1; t0 = 0; t1 = 1; }
  else {
    const disc = B * B - A * Cc;
    if (disc < 0) return -1;
    const s = Math.sqrt(disc);
    t0 = (-B - s) / A; t1 = (-B + s) / A;
    if (t1 < 0 || t0 > 1) return -1;
    t0 = Math.max(0, t0); t1 = Math.min(1, t1);
  }
  const y0 = a0.y - b.y, dy = a1.y - a0.y;
  if (Math.abs(dy) < 1e-12) return y0 >= yMin && y0 <= yMax ? t0 : -1;
  let ta = (yMin - y0) / dy, tb = (yMax - y0) / dy;
  if (ta > tb) { const q = ta; ta = tb; tb = q; }
  const u0 = Math.max(t0, ta), u1 = Math.min(t1, tb);
  return u0 <= u1 ? u0 : -1;
}

// Угол вылета для попадания в точку на (d по горизонтали, dy по высоте) при скорости v и тяжести g.
function ballisticPitch(d, dy, v, g) {
  if (!(g > 0)) return Math.atan2(dy, Math.max(0.01, d));
  const v2 = v * v, disc = v2 * v2 - g * (g * d * d + 2 * dy * v2);
  if (disc < 0) return Math.PI / 4;
  return Math.atan((v2 - Math.sqrt(disc)) / (g * Math.max(0.01, d)));
}

export function createCombatHand(api, patch = {}) {
  const K = { ...HAND_COMBAT_DEFAULTS };
  if (patch && typeof patch === 'object') for (const k of Object.keys(patch)) if (K[k] && typeof K[k] === 'object' && patch[k] && typeof patch[k] === 'object') K[k] = { ...K[k], ...patch[k] };
  const targets = new Map();
  let seq = 0, rngS = 0x2468ace, bossTargetable = true;   // цели и «бить ли Регента» переживают reset (дуэль, реванш)
  const rnd = () => ((rngS = (rngS * 16807) % 2147483647) / 2147483647);
  let S;
  function fresh() {
    return {
      bow: IDLE_BOW, spell: IDLE_SPELL,
      bowPrev: false, lastDrawEv: 0, lastDrawT: -1e9, chargedPrev: false,
      pendingRelease: null, pendingThrow: null, pendingEv: [],
      arrowCd: 0, orbCd: 0, rainCd: 0, time: 0,
      list: [],                    // снаряды {id, kind, element, position, velocity, radius, damage, age, lifetime, gravity, pierce, hits:Set, charged, twoHand, homing, power, draw, rain}
      burns: new Map(),            // targetKey → {until, dps, next}
      chains: [],                  // {t, amount, targetKey, from}
      rains: [],                   // {t, center, left}
      stats: { arrows: 0, arrowHits: 0, orbs: 0, orbHits: 0, rains: 0, damage: 0 },
    };
  }
  S = fresh();

  const st = () => api.st;
  const playing = () => st() && st().status === 'playing';
  const vec = (x, y, z) => ({ x, y, z });
  const nextId = (k) => `${k}:hand:${++seq}`;
  function facing() {
    const P = st().p;
    if (st().engaged) return api.toBossUnit();
    return { x: Math.sin(P.yaw), z: Math.cos(P.yaw) };
  }
  function handPoint(side) {            // примерная точка кисти героя (события, вылет снарядов)
    const P = st().p, f = facing(), s = side === 'left' ? -1 : 1;
    const rx = -f.z, rz = f.x;          // вправо на экране (как screenRight при moveSign = 1)
    return vec(P.x + f.x * 0.45 + rx * 0.28 * s, P.y + 1.4, P.z + f.z * 0.45 + rz * 0.28 * s);
  }
  function emit(type, pos, data) { if (playing()) api.emit(type, pos, data); }

  // ───────── цели ─────────
  function bossTarget() {
    const B = st().b;
    if (!bossTargetable || !B || B.dead) return null;
    return { key: 'boss', kind: 'boss', base: api.BOSS, radius: api.C.boss.hitRadius, height: api.C.boss.height, aim: api.bossAim() };
  }
  function allTargets() {
    const out = [];
    const b = bossTarget();
    if (b) out.push(b);
    for (const t of targets.values()) {
      let p = null;
      try { p = t.getPosition && t.getPosition(); } catch (e) { p = null; }
      if (!p || !fin(p.x) || !fin(p.z)) continue;
      const base = vec(p.x, num(p.y), p.z);
      out.push({ key: `t:${t.id}`, kind: t.kind || 'player', base, radius: num(t.radius, 0.45), height: num(t.height, 1.9), aim: vec(base.x, base.y + num(t.height, 1.9) * 0.6, base.z), ref: t });
    }
    return out;
  }
  function lockTarget(from, dir, coneDeg = K.lockConeDeg) {
    // ближайшая к направлению взгляда цель в пределах 80 м и конуса прицела (боссу приоритет в lock-on); позади — не цель
    let best = null, bestA = Infinity;
    for (const t of allTargets()) {
      const dx = t.aim.x - from.x, dz = t.aim.z - from.z, d = Math.hypot(dx, dz);
      if (d > 80 || d < 0.3) continue;
      const a = Math.acos(clamp((dx * dir.x + dz * dir.z) / d, -1, 1));
      if (a > coneDeg * DEG + Math.atan2(t.radius, d)) continue;
      const score = a - (t.kind === 'boss' && st().engaged ? 0.2 : 0);
      if (score < bestA) { bestA = score; best = t; }
    }
    return best;
  }

  // ───────── ввод ─────────
  function readInput(input) {
    if (!input || typeof input !== 'object') return;
    const b = input.bow && typeof input.bow === 'object' ? input.bow : null;
    const m = input.handSpell && typeof input.handSpell === 'object' ? input.handSpell : null;
    const now = S.time;
    if (b) {
      const bow = {
        active: !!b.active, phase: typeof b.phase === 'string' ? b.phase : b.active ? 'drawing' : 'idle',
        draw: clamp01(num(b.draw)), aimX: clamp(num(b.aimX), -1, 1), aimY: clamp(num(b.aimY), -1, 1),
        charged: !!b.charged, element: elem(b.element),
      };
      // натяжение идёт, пока стрела наложена (phase nocked/drawing), а не пока держится стойка (active)
      const drawing = !b.release && (typeof b.phase === 'string' ? !!b.nocked || b.phase === 'nocked' || b.phase === 'drawing' : bow.active);
      if (drawing && !S.bowPrev) { S.pendingEv.push(['bow_draw_start', 'left', { element: bow.element, aimX: bow.aimX, aimY: bow.aimY }]); S.lastDrawEv = 0; }
      if (drawing && (Math.abs(bow.draw - S.lastDrawEv) >= K.drawEventStep || bow.charged !== S.chargedPrev) && now - S.lastDrawT >= K.drawEventMs / 1000) {
        S.lastDrawEv = bow.draw; S.lastDrawT = now;
        S.pendingEv.push(['bow_draw', 'right', { draw: Math.round(bow.draw * 100) / 100, charged: bow.charged, element: bow.element }]);
      }
      S.chargedPrev = bow.charged;
      if (b.rune && bow.element) S.pendingEv.push(['bow_element', 'left', { element: bow.element, rune: String(b.rune) }]);
      if (b.release) S.pendingRelease = { draw: bow.draw, charged: bow.charged, element: bow.element, aimX: bow.aimX, aimY: bow.aimY, rain: !!b.rain, rapid: !!b.rapid };
      else if (!drawing && S.bowPrev && !S.pendingRelease) S.pendingEv.push(['bow_cancel', 'left', {}]);
      S.bowPrev = drawing;
      S.bow = bow.active || bow.phase === 'ready' ? bow : IDLE_BOW;
    } else { if (S.bowPrev) S.pendingEv.push(['bow_cancel', 'left', {}]); S.bowPrev = false; S.bow = IDLE_BOW; }
    if (m) {
      const el = elem(m.element) || 'fire';
      if (m.formed) S.pendingEv.push(['hand_spell_form', 'right', { element: el, power: clamp01(num(m.power)) }]);
      if (m.phase === 'throw') S.pendingThrow = { element: el, power: clamp01(num(m.power)), size: clamp01(num(m.size, 0.5)), dir: { x: clamp(num(m.dir && m.dir.x), -1, 1), y: clamp(num(m.dir && m.dir.y), -1, 1) }, twoHand: !!m.twoHand, how: m.how || 'push' };
      if (m.cancel) S.pendingEv.push(['hand_spell_cancel', 'right', { element: el, reason: m.cancelReason || 'cancel' }]);
      const on = m.phase === 'form' || m.phase === 'hold';
      S.spell = on ? { phase: m.phase, element: el, power: clamp01(num(m.power)), size: clamp01(num(m.size)), twoHand: !!m.twoHand } : IDLE_SPELL;
    } else S.spell = IDLE_SPELL;
  }
  function clearInput() {
    if (S.bowPrev && !S.pendingRelease) S.pendingEv.push(['bow_cancel', 'left', { reason: 'tracking' }]);
    S.bowPrev = false; S.bow = IDLE_BOW; S.spell = IDLE_SPELL; S.pendingRelease = null; S.pendingThrow = null;
  }

  // ───────── выстрелы ─────────
  function spendEnergy(cost) {
    const P = st().p;
    if (P.energy < cost - 1e-9) return false;
    P.energy = Math.max(0, P.energy - cost);
    P.regenDelay = api.C.player.energyRegenDelay;
    return true;
  }
  function aimedDir(f, aimX, aimY, yawDeg, pitchDeg, from, speed, gravity, assistDeg, assistK) {
    // горизонталь: курс героя + поворот по aimX; вертикаль: баллистика до цели + aimY
    const a = aimX * yawDeg * DEG;
    const rx = -f.z, rz = f.x;
    let hx = f.x * Math.cos(a) + rx * Math.sin(a), hz = f.z * Math.cos(a) + rz * Math.sin(a);
    const tgt = lockTarget(from, { x: hx, z: hz });
    let pitch = (K.arrow.liftDeg + aimY * pitchDeg) * DEG;
    let assist = null;
    if (tgt) {
      const dx = tgt.aim.x - from.x, dz = tgt.aim.z - from.z, d = Math.hypot(dx, dz) || 1;
      const ideal = ballisticPitch(d, tgt.aim.y - from.y, speed, gravity);
      pitch = ideal + aimY * pitchDeg * DEG;
      const yawErr = Math.acos(clamp((dx * hx + dz * hz) / d, -1, 1));
      const pitchErr = Math.abs(pitch - ideal);
      if (yawErr <= assistDeg * DEG && pitchErr <= assistDeg * DEG * 1.2) {
        const k = assistK;
        hx += (dx / d - hx) * k; hz += (dz / d - hz) * k;
        const l = Math.hypot(hx, hz) || 1; hx /= l; hz /= l;
        pitch += (ideal - pitch) * k;
        assist = tgt.key;
      }
    }
    const c = Math.cos(pitch);
    return { dir: vec(hx * c, Math.sin(pitch), hz * c), target: tgt, assist };
  }

  function spawnArrow(r) {
    const A = K.arrow;
    const P = st().p;
    if (P.dead) return;
    if (S.arrowCd > 1e-6) { api.deny('arrow', 'cooldown', { remaining: S.arrowCd }); return; }
    if (r.rain) { spawnRain(r); return; }
    const cost = r.charged ? A.energyCharged : A.energy;
    if (!spendEnergy(cost)) { api.deny('arrow', 'energy', { cost }); return; }
    S.arrowCd = A.cooldown;
    P.castTimer = Math.max(P.castTimer || 0, 0.18);
    const f = facing();
    const from = handPoint('left');
    from.y = P.y + A.spawnHeight;
    const speed = A.speedMin + (A.speedMax - A.speedMin) * r.draw;
    const aim = aimedDir(f, r.aimX, r.aimY, A.aimYawDeg, A.aimPitchDeg, from, speed, A.gravity, A.assistDeg, A.assistK);
    let dmg = (A.damageMin + (A.damageMax - A.damageMin) * Math.pow(r.draw, 1.2)) * (r.charged ? A.chargedMul : 1) * (r.rapid ? A.rapidMul : 1);
    dmg = Math.round(dmg * 10) / 10;
    const id = nextId('arrow');
    addOwn({
      id, kind: 'arrow', element: r.element, position: vec(from.x, from.y, from.z),
      velocity: vec(aim.dir.x * speed, aim.dir.y * speed, aim.dir.z * speed),
      radius: A.radius * (r.charged ? 1.3 : 1), damage: dmg, age: 0, lifetime: A.lifetime, gravity: A.gravity,
      pierce: r.charged ? A.pierce : 0, hits: new Set(), charged: r.charged, draw: r.draw,
    }, A.maxLive);
    S.stats.arrows++;
    emit('bow_release', from, { draw: r.draw, charged: r.charged, element: r.element, projectileId: id, aimX: r.aimX, aimY: r.aimY, rapid: r.rapid, rain: false, damage: dmg, assist: aim.assist, velocity: vec(aim.dir.x * speed, aim.dir.y * speed, aim.dir.z * speed) });
    emit('player_cast', from, { ability: 'arrow', projectileId: id, element: r.element, velocity: vec(aim.dir.x * speed, aim.dir.y * speed, aim.dir.z * speed) });
  }
  function spawnRain(r) {
    const R = K.rain, A = K.arrow;
    if (S.rainCd > 1e-6) { api.deny('arrow_rain', 'cooldown', { remaining: S.rainCd }); r.rain = false; spawnArrow(r); return; }
    if (!spendEnergy(R.energy)) { api.deny('arrow_rain', 'energy', { cost: R.energy }); return; }
    S.rainCd = R.cooldown; S.arrowCd = A.cooldown;
    const P = st().p, f = facing(), from = handPoint('left');
    from.y = P.y + A.spawnHeight;
    const tgt = lockTarget(from, f);
    const center = tgt && Math.hypot(tgt.base.x - P.x, tgt.base.z - P.z) <= 60 ? vec(tgt.base.x, tgt.base.y, tgt.base.z)
      : vec(P.x + f.x * R.reach, 0, P.z + f.z * R.reach);
    if (!tgt) center.y = api.groundY(center.x, center.z);
    // залп вверх — видимая стрела без урона
    const upId = nextId('arrow');
    addOwn({ id: upId, kind: 'arrow', element: r.element, position: vec(from.x, from.y, from.z), velocity: vec(f.x * 6, 42, f.z * 6), radius: A.radius * 1.3, damage: 0, age: 0, lifetime: 0.7, gravity: 0, pierce: 0, hits: new Set(), charged: true, draw: 1, volley: true }, A.maxLive);
    S.rains.push({ t: S.time + R.delay, center, left: R.count, element: r.element, next: S.time + R.delay });
    S.stats.rains++;
    emit('bow_release', from, { draw: r.draw, charged: r.charged, element: r.element, projectileId: upId, aimX: r.aimX, aimY: r.aimY, rain: true });
    emit('arrow_rain', center, { center, radius: R.radius, delay: R.delay, count: R.count, element: r.element });
  }
  function stepRain() {
    const R = K.rain;
    for (const rn of S.rains) {
      while (rn.left > 0 && S.time >= rn.next) {
        rn.left--; rn.next += 0.045;
        const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * R.radius;
        const x = rn.center.x + Math.cos(a) * d, z = rn.center.z + Math.sin(a) * d;
        const y = rn.center.y + R.height;
        addOwn({ id: nextId('arrow'), kind: 'arrow', element: rn.element, position: vec(x - 1.2, y, z - 0.6), velocity: vec(2.4, -R.speed, 1.2), radius: K.arrow.radius * 1.2, damage: R.damage, age: 0, lifetime: 1.6, gravity: 0, pierce: 0, hits: new Set(), charged: false, draw: 1, rainDrop: true }, K.arrow.maxLive + R.count);
      }
    }
    S.rains = S.rains.filter((rn) => rn.left > 0);
  }

  function spawnOrb(r) {
    const O = K.orb;
    const P = st().p;
    if (P.dead) return;
    if (S.orbCd > 1e-6) { api.deny('hand_orb', 'cooldown', { remaining: S.orbCd }); return; }
    const cost = (O.energyBase + O.energyPower * r.power) * (r.twoHand ? O.twoHandEnergy : 1);
    if (!spendEnergy(cost)) { api.deny('hand_orb', 'energy', { cost }); return; }
    S.orbCd = O.cooldown;
    P.castTimer = Math.max(P.castTimer || 0, 0.3);
    const f = facing();
    const from = handPoint('right');
    from.y = P.y + O.spawnHeight;
    const speed = O.speedMin + (O.speedMax - O.speedMin) * r.power;
    const aim = aimedDir(f, r.dir.x * (O.dirYawDeg / K.arrow.aimYawDeg), r.dir.y * (O.dirPitchDeg / K.arrow.aimPitchDeg), K.arrow.aimYawDeg, K.arrow.aimPitchDeg, from, speed, 0, O.assistDeg, 0.6);
    const mul = r.twoHand ? O.twoHandMul : 1;
    const dmg = Math.round((O.damageMin + (O.damageMax - O.damageMin) * r.power) * mul * 10) / 10;
    const radius = (O.radiusMin + (O.radiusMax - O.radiusMin) * r.size) * (r.twoHand ? O.twoHandRadius : 1);
    const id = nextId('hand_orb');
    addOwn({
      id, kind: 'hand_orb', element: r.element, position: vec(from.x, from.y, from.z),
      velocity: vec(aim.dir.x * speed, aim.dir.y * speed, aim.dir.z * speed), radius, damage: dmg, age: 0, lifetime: O.lifetime,
      gravity: 0, pierce: 0, hits: new Set(), twoHand: r.twoHand, power: r.power, homing: aim.assist ? aim.target && aim.target.key : null,
    }, O.maxLive);
    S.stats.orbs++;
    emit('hand_spell_throw', from, { element: r.element, power: r.power, dir: r.dir, twoHand: r.twoHand, projectileId: id, damage: dmg, radius, how: r.how, velocity: vec(aim.dir.x * speed, aim.dir.y * speed, aim.dir.z * speed) });
    emit('player_cast', from, { ability: 'hand_orb', projectileId: id, element: r.element, twoHand: r.twoHand });
  }

  function addOwn(pr, cap) {
    let n = 0;
    for (const q of S.list) if (q.kind === pr.kind) n++;
    if (n >= cap) { const i = S.list.findIndex((q) => q.kind === pr.kind); if (i >= 0) S.list.splice(i, 1); }
    S.list.push(pr);
  }

  // ───────── попадания и стихии ─────────
  function dealBoss(amount, source, point, extra, noCombo) {
    const P = st().p;
    const c = P.combo, ct = P.comboTimer;
    const hp0 = st().b.hp;
    const evs = st().events, n0 = Array.isArray(evs) ? evs.length : 0;
    api.damageBoss(amount, source, point, extra);
    if (noCombo && st().p) {
      st().p.combo = c; st().p.comboTimer = ct;
      // событие boss_hit тика горения не должно «щёлкать» комбо в HUD
      if (Array.isArray(evs)) for (let i = n0; i < evs.length; i++) if (evs[i] && evs[i].type === 'boss_hit' && evs[i].data) evs[i].data.combo = c;
    }
    const dealt = Math.max(0, hp0 - (st().b ? st().b.hp : hp0));
    S.stats.damage += dealt;
    return dealt;
  }
  function applyHit(pr, tgt, point) {
    const kind = pr.kind, el = pr.element;
    const dir = (() => { const v = pr.velocity, l = Math.hypot(v.x, v.y, v.z) || 1; return vec(v.x / l, v.y / l, v.z / l); })();
    const kb = el === 'earth' ? { x: dir.x * K.earth.knockback, z: dir.z * K.earth.knockback } : null;
    const source = kind === 'arrow' ? 'arrow' : 'hand_orb';
    emit('projectile_impact', point, { owner: 'player', kind, projectileId: pr.id, result: tgt.kind === 'boss' ? 'boss' : 'player', element: el, radius: pr.radius, velocity: vcopy(pr.velocity) });
    // C3-событие попадания — до урона: смертельный удар тоже его даёт (после исхода emit молчит)
    if (kind === 'arrow') { S.stats.arrowHits++; emit('arrow_hit', point, { damage: pr.damage, element: el, charged: !!pr.charged, target: tgt.kind, targetId: tgt.ref ? tgt.ref.id : 'boss', projectileId: pr.id, draw: pr.draw, rain: !!pr.rainDrop }); }
    else { S.stats.orbHits++; emit('hand_spell_hit', point, { element: el, damage: pr.damage, twoHand: !!pr.twoHand, target: tgt.kind, targetId: tgt.ref ? tgt.ref.id : 'boss', projectileId: pr.id, power: pr.power, radius: pr.radius }); }
    if (tgt.kind === 'boss') {
      dealBoss(pr.damage, source, point, { kind, projectileId: pr.id, element: el, charged: !!pr.charged, twoHand: !!pr.twoHand });
      if (!playing()) return;
      const B = st().b;
      if (el === 'fire') addBurn('boss', pr.twoHand ? 1.6 : 1);
      if (el === 'storm') S.chains.push({ t: S.time + K.storm.chainDelay, amount: pr.damage * K.storm.chainMul, from: vcopy(point), exclude: 'boss', element: 'storm' });
      if (el === 'frost') {
        const dur = kind === 'hand_orb' ? K.frost.orbSlowSec : K.frost.slowSec;
        if (!(B.slow > 0)) emit('slow_start', api.bossAim(), { duration: dur, slow: api.C.runes.clepsydra.slow, source: 'frost' });
        B.slow = Math.max(B.slow || 0, dur);
        emit('element_apply', api.bossAim(), { element: 'frost', target: 'boss', duration: dur });
      }
      if (el === 'earth') {
        B.hitReact = Math.max(B.hitReact || 0, K.earth.staggerSec);
        if (kind === 'hand_orb' && pr.twoHand) {
          B.stun = Math.max(B.stun || 0, K.earth.orbStunSec);
          emit('boss_stunned', api.bossAim(), { duration: K.earth.orbStunSec, source: 'earth' });
        }
        emit('element_apply', point, { element: 'earth', target: 'boss', knockback: kb, duration: K.earth.staggerSec });
      }
    } else if (tgt.ref && typeof tgt.ref.onHit === 'function') {
      try {
        tgt.ref.onHit({
          damage: pr.damage, element: el, kind, projectileId: pr.id, point: vcopy(point), dir, charged: !!pr.charged, twoHand: !!pr.twoHand,
          knockback: kb, slowSec: el === 'frost' ? (kind === 'hand_orb' ? K.frost.orbSlowSec : K.frost.slowSec) : 0,
          burnSec: el === 'fire' ? K.fire.burnSec : 0, burnDps: el === 'fire' ? K.fire.burnDps : 0, chain: el === 'storm',
        });
      } catch (e) { /* цель сама решает, как применить урон */ }
      if (el === 'storm') S.chains.push({ t: S.time + K.storm.chainDelay, amount: pr.damage * K.storm.chainMul, from: vcopy(point), exclude: tgt.key, element: 'storm' });
    }
  }
  function vcopy(p) { return vec(p.x, p.y, p.z); }
  function addBurn(key, mul) {
    const F = K.fire;
    const b = S.burns.get(key);
    if (b) { b.until = S.time + F.burnSec; b.dps = Math.max(b.dps, F.burnDps * mul); }
    else { S.burns.set(key, { until: S.time + F.burnSec, dps: F.burnDps * mul, next: S.time + F.tick }); emit('element_apply', api.bossAim(), { element: 'fire', target: key, duration: F.burnSec }); }
  }
  function stepBurns() {
    for (const [key, b] of S.burns) {
      if (key !== 'boss' || !bossTarget()) { S.burns.delete(key); continue; }
      while (S.time + 1e-6 >= b.next && b.next <= b.until + 1e-6 && playing()) {
        b.next += K.fire.tick;
        dealBoss(b.dps * K.fire.tick, 'burn', api.bossAim(), { element: 'fire', dot: true }, true);
      }
      if (S.time > b.until + 1e-6) S.burns.delete(key);
    }
  }
  function stepChains() {
    if (!S.chains.length) return;
    const keep = [];
    for (const c of S.chains) {
      if (S.time < c.t) { keep.push(c); continue; }
      // цепь на одну цель: другая цель, если есть (соперник/босс), иначе — повторный удар по той же
      const all = allTargets();
      let tgt = all.find((t) => t.key !== c.exclude) || all.find((t) => t.key === c.exclude);
      if (!tgt || !playing()) continue;
      emit('hand_chain', tgt.aim, { from: c.from, to: vcopy(tgt.aim), element: 'storm', target: tgt.kind });
      if (tgt.kind === 'boss') dealBoss(c.amount, 'chain', tgt.aim, { element: 'storm', chain: true });
      else if (tgt.ref && typeof tgt.ref.onHit === 'function') { try { tgt.ref.onHit({ damage: c.amount, element: 'storm', kind: 'chain', projectileId: null, point: vcopy(tgt.aim), dir: vec(0, 0, 0), chain: true }); } catch (e) { /* ignore */ } }
    }
    S.chains = keep;
  }

  function stepProjectiles(h) {
    if (!S.list.length) return;
    const tg = allTargets();
    const list = S.list;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      const prev = vcopy(pr.position);
      if (pr.homing) {
        const t = tg.find((x) => x.key === pr.homing);
        if (t) {
          const sp = Math.hypot(pr.velocity.x, pr.velocity.y, pr.velocity.z) || 1;
          let dx = t.aim.x - pr.position.x, dy = t.aim.y - pr.position.y, dz = t.aim.z - pr.position.z;
          const dl = Math.hypot(dx, dy, dz) || 1;
          const k = 1 - Math.exp(-K.orb.homing * h);
          let vx = pr.velocity.x + (dx / dl * sp - pr.velocity.x) * k, vy = pr.velocity.y + (dy / dl * sp - pr.velocity.y) * k, vz = pr.velocity.z + (dz / dl * sp - pr.velocity.z) * k;
          const vl = Math.hypot(vx, vy, vz) || 1;
          pr.velocity.x = vx / vl * sp; pr.velocity.y = vy / vl * sp; pr.velocity.z = vz / vl * sp;
        }
      }
      if (pr.gravity) pr.velocity.y -= pr.gravity * h;
      pr.position.x += pr.velocity.x * h; pr.position.y += pr.velocity.y * h; pr.position.z += pr.velocity.z * h;
      pr.age += h;
      let dead = false;
      if (!pr.volley && pr.damage > 0) {
        for (const t of tg) {
          if (pr.hits.has(t.key)) continue;
          const u = sweptCylinder(prev, pr.position, t.base, pr.radius + t.radius, -pr.radius, t.height + pr.radius);
          if (u < 0) continue;
          const point = vec(prev.x + (pr.position.x - prev.x) * u, prev.y + (pr.position.y - prev.y) * u, prev.z + (pr.position.z - prev.z) * u);
          pr.hits.add(t.key);
          applyHit(pr, t, point);
          if (!playing()) { S.list.length = 0; return; }
          if (pr.kind === 'hand_orb' && pr.twoHand) { splash(pr, point, t.key, tg); if (!playing()) { S.list.length = 0; return; } }
          if (pr.pierce > 0) { pr.pierce--; pr.damage *= 0.7; continue; }
          dead = true; break;
        }
      }
      if (!dead) {
        const gy = api.groundY(pr.position.x, pr.position.z);
        if (pr.position.y <= gy && pr.age > 0.05) {
          if (!pr.volley) emit('projectile_impact', vec(pr.position.x, gy, pr.position.z), { owner: 'player', kind: pr.kind, projectileId: pr.id, result: 'floor', element: pr.element });
          if (pr.kind === 'hand_orb' && pr.twoHand) { splash(pr, vec(pr.position.x, gy, pr.position.z), null, tg); if (!playing()) { S.list.length = 0; return; } }
          dead = true;
        } else if (pr.age >= pr.lifetime) dead = true;
      }
      if (!dead) list[w++] = pr;
    }
    list.length = w;
  }
  function splash(pr, point, exceptKey, tg) {
    const R = K.orb.splash;
    for (const t of tg) {
      if (t.key === exceptKey || pr.hits.has(t.key)) continue;
      if (Math.hypot(t.base.x - point.x, t.base.z - point.z) - t.radius > R) continue;
      pr.hits.add(t.key);
      applyHit({ ...pr, damage: pr.damage * 0.5 }, t, vec(t.aim.x, t.aim.y, t.aim.z));
      if (!playing()) return;
    }
  }

  function step(h) {
    if (!playing()) return;
    S.time += h;
    S.arrowCd = Math.max(0, S.arrowCd - h); S.orbCd = Math.max(0, S.orbCd - h); S.rainCd = Math.max(0, S.rainCd - h);
    if (S.pendingEv.length) {
      for (const [type, side, data] of S.pendingEv) emit(type, handPoint(side), data);
      S.pendingEv.length = 0;
    }
    if (S.pendingRelease) { const r = S.pendingRelease; S.pendingRelease = null; spawnArrow(r); if (!playing()) return; }
    if (S.pendingThrow) { const r = S.pendingThrow; S.pendingThrow = null; spawnOrb(r); if (!playing()) return; }
    stepRain();
    stepProjectiles(h);
    if (!playing()) return;
    stepBurns();
    if (!playing()) return;
    stepChains();
  }

  // Предпросмотр полёта стрелы (для дуги прицела у визуала): точка и скорость вылета с аим-ассистом, как у spawnArrow.
  function launchPreview(bow) {
    const A = K.arrow, P = st().p;
    const from = handPoint('left');
    from.y = P.y + A.spawnHeight;
    const speed = A.speedMin + (A.speedMax - A.speedMin) * bow.draw;
    const aim = aimedDir(facing(), bow.aimX, bow.aimY, A.aimYawDeg, A.aimPitchDeg, from, speed, A.gravity, A.assistDeg, A.assistK);
    return { from, vel: vec(aim.dir.x * speed, aim.dir.y * speed, aim.dir.z * speed), g: A.gravity, assist: aim.assist || null };
  }

  // ───────── снимок ─────────
  function decorateSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return snap;
    if (snap.player) {
      snap.player.bow = { ...S.bow };            // свежие объекты: потребители снимка могут их менять
      if (S.bow.active && S.bow.draw > 0.05 && playing()) { try { snap.player.bow.launch = launchPreview(S.bow); } catch (e) { /* без дуги */ } }
      snap.player.handSpell = { ...S.spell };
      if (S.bow.active && (snap.player.action === 'idle' || snap.player.action === 'move')) snap.player.action = 'cast';
    }
    if (snap.cooldowns) {
      snap.cooldowns.arrowRemaining = S.arrowCd; snap.cooldowns.arrowTotal = K.arrow.cooldown;
      snap.cooldowns.handOrbRemaining = S.orbCd; snap.cooldowns.handOrbTotal = K.orb.cooldown;
      snap.cooldowns.rainRemaining = S.rainCd; snap.cooldowns.rainTotal = K.rain.cooldown;
    }
    if (S.list.length && Array.isArray(snap.projectiles)) {
      const cap = Math.max(0, num(api.C.sim.maxProjectiles, 48) - snap.projectiles.length);
      const from = Math.max(0, S.list.length - cap);
      for (let i = from; i < S.list.length; i++) {
        const pr = S.list[i];
        snap.projectiles.push({
          id: pr.id, owner: 'player', kind: pr.kind, element: pr.element || null,
          position: vcopy(pr.position), velocity: vcopy(pr.velocity), radius: pr.radius,
          damage: pr.damage, charged: !!pr.charged, twoHand: !!pr.twoHand, pierce: pr.pierce, from: 'hand',
        });
      }
    }
    return snap;
  }

  return {
    version: HAND_COMBAT_VERSION,
    readInput, clearInput, step, decorateSnapshot,
    reset() { S = fresh(); rngS = 0x2468ace; },
    clear() { S.list.length = 0; S.rains.length = 0; S.chains.length = 0; S.burns.clear(); S.pendingRelease = null; S.pendingThrow = null; },
    registerTarget(t) { if (t && t.id != null) targets.set(String(t.id), t); return () => targets.delete(String(t && t.id)); },
    unregisterTarget(id) { targets.delete(String(id)); },
    setBossTargetable(on) { bossTargetable = on !== false; },
    get config() { return K; },
    getDebug() { return { version: HAND_COMBAT_VERSION, live: S.list.length, arrowCd: S.arrowCd, orbCd: S.orbCd, rainCd: S.rainCd, burns: S.burns.size, rains: S.rains.length, stats: { ...S.stats }, bow: S.bow, spell: S.spell, targets: targets.size }; },
  };
}
