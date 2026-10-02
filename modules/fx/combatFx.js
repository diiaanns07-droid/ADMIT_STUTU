// ASHEN OATH — modules/fx/combatFx.js. Владелец: №7 [VFX].
// Удары и отдача боя, щит, парирование/уклонение, появление и гибель героя, PvP-окраска ударов соперника.
//  - материал удара: Регент (фарфор/бронза/камень) — сколы камня, бело-голубые искры, пороховая пыль;
//    плоть (герой/соперник) — сдержанные тёмно-красные брызги + искры-угольки по направлению удара;
//    дерево — щепки; земля — комья и пыль. Сила слоёв, тряска и хит-стоп — по d.amount;
//  - щит: шестигранный фронтальный щит fx.hex (если подсистема есть) у груди, лицом к цели; блок — трещины и искры;
//  - парирование: острый серп-вспышка + «замедление времени» (кольцо-рябь); идеальное уклонение — остаточный образ + холодное кольцо;
//  - появление героя: столб света сверху, рунический круг, угольки, «сборка» тела из искр (~1.2 с);
//    гибель: тело рассыпается пеплом и угольками, тускнеющий круг, душа-огонёк уходит вверх.
// Слои поверх старых эффектов (return без true), кроме событий, которые старый код рисует не там (remote) или не знает.
// [W4-УДАР] удар Регента по герою и щит:
//  - попадание по герою: красный ореол-вспышка вокруг героя и кольцо искр по телу, пыль из-под ног (герой
//    отброшен), маленькое кольцо по земле, след-трещина под ногами (декаль tag 'hit'), красный свет (не на low);
//  - блок: шестигранный щит звенит (дрожь рёбер — shieldHex), трещины копятся (damage = износ щита: удары +
//    расход энергии), искры отскакивают веером по кромке, пыль у ног — героя сдвинуло;
//  - пролом (слэм сквозь щит — player_hit.shieldPierced; блок, исчерпавший энергию; PvP shield_break):
//    щит осыпается от точки удара, шестигранные пластины-осколки разлетаются (shieldHex.shatter; на low —
//    частицы), вспышка, рывок экрана; щит снова раскрывается через ~0,5 с, если его всё ещё держат.
// Частицы ударов и блоков — через жёсткий пул fx.shared.hitPool (hitFx.js).

import { clamp, easeOut, TAU, isNum, hasVec } from './common.js';

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const E = fx.E;
  const num = (v, d) => (isNum(v) ? v : d);
  const UP = new V3(0, 1, 0);
  const DOWN = new V3(0, -1, 0);
  const GOLD = E.gold, RIV = E.rival, TIME = E.time, FIRE = E.fire;

  // временные векторы обработчиков (только синхронно внутри одного вызова)
  const _p = new V3(), _d = new V3(), _q = new V3(), _r = new V3(), _u = new V3(), _cam = new V3();
  const _c0 = new V3(), _c1 = new V3();

  const snapNow = () => fx.snap;
  const isPvp = () => { const s = snapNow(); return !!(s && (s.mode === 'pvp' || s.opponent)); };
  function camDir(p, out) {
    kit.cameraPos(_cam);
    out.set(_cam.x - p.x, _cam.y - p.y, _cam.z - p.z);
    if (out.lengthSq() < 1e-8) out.set(0, 0, 1);
    return out.normalize();
  }
  function groundAt(p, fb) { return fx.groundY(p.x, p.z, num(fb, 0)); }
  const shock = (kind, o) => { if (fx.shock && typeof fx.shock[kind] === 'function') { try { fx.shock[kind](o); } catch (e) { /* ignore */ } } };
  const distort = (p, s) => { if (typeof kit.distort === 'function') { try { kit.distort(p, s); } catch (e) { /* ignore */ } } };
  const audio = (n, p, x) => { if (fx.legacy && typeof fx.legacy.audio === 'function') { try { fx.legacy.audio(n, p, x); } catch (e) { /* ignore */ } } };
  // [W4-УДАР] частицы ударов — через жёсткий пул hitFx (нет его — как раньше)
  const emitB = (o) => (fx.shared.hitPool ? fx.shared.hitPool.emit(o) : kit.emit(o));
  const pulse = (kind, k, pos) => (typeof fx.shared.hitPulse === 'function' ? fx.shared.hitPulse(kind, k, pos) : false);
  const lowQ = () => !!(kit.Q && kit.Q.name === 'low');
  const decalCap = () => (kit.Q && kit.Q.name === 'low' ? 2 : kit.Q && kit.Q.name === 'high' ? 8 : 5);

  // ================================================================== 1) МАТЕРИАЛЫ УДАРА
  // s — сила 0..1; dir — направление разлёта (к атакующему/камере, с подъёмом); gy — земля.
  function hitStone(p, dir, s, gy) {
    kit.flash(p, { color: 0xeef8ff, size: [0.14, 0.5 + 0.6 * s], dur: 0.08, intensity: 4.2, sprite: 'star', pull: 0.5 });
    kit.flash(p, { color: 0x9fd2ff, size: [0.3, 0.9 + 1.0 * s], dur: 0.2, intensity: 1.7, sprite: 'glow', pull: 0.5 });
    // бело-голубые искры (раскалённая бронза/фарфор)
    emitB({ at: p, dir, cone: 0.95, count: 12 + 22 * s, speed: [4, 8 + 6 * s], life: [0.16, 0.42], size: [0.055, 0.01], ramp: 'storm', intensity: 3.4, sprite: 'spark', stretch: 0.032, gravity: 7, drag: 1.6, ground: gy + 0.02, essential: true });
    // сколы камня (обычное смешивание, падают)
    emitB({ at: p, dir, cone: 1.0, count: 6 + 12 * s, speed: [2, 4.5 + 2.5 * s], life: [0.55, 1.0], size: [0.075, 0.06], sizeVar: 0.5, ramp: 'stone', blend: 'alpha', intensity: 1.1, sprite: 'debris', gravity: 9.8, drag: 0.5, spin: [-9, 9], ground: gy + 0.03, essential: true });
    // осколки фарфоровой маски — несколько светлых чешуек
    emitB({ at: p, dir, cone: 0.8, count: 2 + 4 * s, speed: [2.5, 5], life: [0.5, 0.9], size: [0.06, 0.05], ramp: 'stone', color: 0xd8d4cc, blend: 'alpha', intensity: 1.2, sprite: 'shard', gravity: 9, drag: 0.6, spin: [-12, 12], ground: gy + 0.03 });
    // пороховая пыль
    emitB({ at: p, radius: 0.12, dir, cone: 1.3, count: 4 + 6 * s, speed: [0.4, 1.3], life: [0.7, 1.3], size: [0.3, 0.85 + 0.6 * s], ramp: 'dust', blend: 'alpha', alpha: 0.75, intensity: 1, sprite: 'smoke', drag: 2.2, gravity: 0.25, turb: 0.4, spin: [-0.8, 0.8] });
    if (s > 0.3) kit.light(p, { color: 0xbfe2ff, intensity: 0.4 + 0.8 * s, range: 8, dur: 0.22, attack: 0.05 });
  }
  // плоть: brand = цвет «угольков» тела жертвы (свой — ember, соперник — фиолетовый)
  function hitFlesh(p, dir, s, gy, rivalBody) {
    kit.flash(p, { color: rivalBody ? RIV.hot : 0xff9a5a, size: [0.2, 0.6 + 0.5 * s], dur: 0.12, intensity: 2.4, sprite: 'glow', pull: 0.7, rival: rivalBody });
    kit.flash(p, { color: 0xfff0e0, size: [0.08, 0.32 + 0.3 * s], dur: 0.07, intensity: 3.4, sprite: 'star', pull: 0.75 });
    // тёмно-красные брызги — капли-штрихи, падают
    emitB({ at: p, dir, cone: 0.55, count: 8 + 12 * s, speed: [2, 4.5 + 2 * s], life: [0.3, 0.55], size: [0.045, 0.025], ramp: 'blood', blend: 'alpha', intensity: 0.85, sprite: 'spark', stretch: 0.018, gravity: 9, drag: 1.2, ground: gy + 0.01, essential: true });
    // морось
    emitB({ at: p, dir, cone: 0.6, count: 2 + 3 * s, speed: [0.6, 1.4], life: [0.25, 0.45], size: [0.12, 0.36], ramp: 'blood', blend: 'alpha', alpha: 0.5, intensity: 0.7, sprite: 'smoke', drag: 3 });
    // искры-угольки
    emitB({ at: p, dir, cone: 0.9, count: 8 + 10 * s, speed: [2, 6], life: [0.2, 0.5], size: [0.05, 0.01], ramp: rivalBody ? 'rival' : 'ember', intensity: 3, sprite: 'spark', stretch: 0.03, gravity: 4, drag: 2, rival: rivalBody, essential: true });
  }
  function hitWood(p, dir, s, gy) {
    kit.flash(p, { color: 0xffe2b0, size: [0.1, 0.5], dur: 0.08, intensity: 2.6, sprite: 'star', pull: 0.4 });
    kit.emit({ at: p, dir, cone: 1.0, count: 10 + 12 * s, speed: [2.5, 6], life: [0.6, 1.1], size: [0.1, 0.08], sizeVar: 0.5, ramp: 'wood', blend: 'alpha', intensity: 1.1, sprite: 'shard', gravity: 9.8, drag: 0.8, spin: [-12, 12], ground: gy + 0.02, essential: true });
    kit.emit({ at: p, radius: 0.1, dir, cone: 1.2, count: 3 + 4 * s, speed: [0.3, 1], life: [0.6, 1.1], size: [0.25, 0.7], ramp: 'dust', blend: 'alpha', alpha: 0.6, intensity: 1, sprite: 'smoke', drag: 2, turb: 0.3 });
    kit.emit({ at: p, radius: 0.3, count: 3 + 4 * s, speed: [0.3, 1.2], life: [1.2, 2.0], size: [0.09, 0.08], ramp: 'leaf', blend: 'alpha', intensity: 1, sprite: 'leaf', gravity: 1.2, drag: 2, turb: 0.8, spin: [-4, 4], ground: gy + 0.02 });
  }
  function hitDirt(p, s, gy) {
    _q.set(p.x, gy + 0.05, p.z);
    kit.emit({ at: _q, dir: UP, cone: 0.75, count: 6 + 8 * s, speed: [1.5, 4], life: [0.5, 0.9], size: [0.06, 0.05], sizeVar: 0.5, ramp: 'wood', blend: 'alpha', intensity: 0.8, sprite: 'debris', gravity: 9.8, drag: 0.6, spin: [-8, 8], ground: gy + 0.02, essential: true });
    kit.emit({ at: _q, radius: 0.15, dir: UP, cone: 1.3, count: 5 + 5 * s, speed: [0.5, 1.5], life: [0.8, 1.4], size: [0.4, 1.1 + 0.4 * s], ramp: 'dust', blend: 'alpha', alpha: 0.7, intensity: 1, sprite: 'smoke', drag: 2, gravity: -0.1, turb: 0.35, spin: [-0.6, 0.6] });
  }
  // фиолетовый слой удара соперника (PvP)
  function rivalImpact(p, dir, s) {
    kit.flash(p, { color: RIV.core, size: [0.14, 0.7 + 0.4 * s], dur: 0.1, intensity: 4, sprite: 'star', pull: 0.6, rival: true });
    kit.flash(p, { color: RIV.mid, size: [0.3, 1.2 + 0.5 * s], dur: 0.24, intensity: 2.1, sprite: 'glow', pull: 0.6, rival: true });
    kit.flash(p, { color: RIV.hot, size: [0.2, 1.5], dur: 0.3, intensity: 1.5, sprite: 'ring', pull: 0.6, rival: true });
    kit.emit({ at: p, dir, cone: 0.9, count: 16 + 8 * s, speed: [2.5, 7], life: [0.2, 0.45], size: [0.06, 0.01], ramp: 'rival', intensity: 3.2, sprite: 'spark', stretch: 0.03, gravity: 3, drag: 2, rival: true, essential: true });
    kit.emit({ at: p, radius: 0.12, count: 10, speed: [0.3, 1.2], life: [0.4, 0.8], size: [0.05, 0.01], ramp: 'rival', intensity: 2.4, sprite: 'ember', drag: 1.5, turb: 0.6, rival: true });
    kit.light(p, { color: RIV.mid, intensity: 0.6, range: 7, dur: 0.25 });
  }
  // направление разлёта: к точке from (горизонтально) + подъём
  function sprayDir(out, p, from, lift) {
    out.set(from.x - p.x, 0, from.z - p.z);
    if (out.lengthSq() < 1e-6) camDir(p, out).setY(0);
    if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
    out.normalize(); out.y += lift;
    return out.normalize();
  }
  // хит-стоп атакующего по урону: 0..45 мс (лёгкие удары ~14 — почти ноль, серия не «заикается»)
  const hsAttack = (s) => 45 * Math.pow(s, 1.2);
  const isSpellSrc = (d) => d.source === 'rune' || d.source === 'sigil' || !!d.rune || !!d.sigil;

  // ------------------------------------------------------------ boss_hit: по Регенту (или по сопернику в PvP)
  fx.on('boss_hit', (ev, d) => {
    const p = fx.evPos(ev, _p) || fx.target(_p, false);
    const amount = num(d.amount, 12);
    const s = clamp((amount - 10) / 50, 0, 1);
    const spell = isSpellSrc(d);
    const sm = spell ? 0.6 : 1;
    fx.anchor('chest', _c0, false);
    sprayDir(_d, p, _c0, 0.55);
    const b = fx.snap && fx.snap.boss;
    const gy = groundAt(p, b && b.position ? b.position.y : 0);
    const flesh = d.material === 'flesh' || (fx.snap && fx.snap.lockTarget && fx.snap.lockTarget.kind === 'player');
    if (flesh) hitFlesh(p, _d, s * sm, gy, isPvp());
    else if (d.material === 'wood') hitWood(p, _d, s * sm, gy);
    else hitStone(p, _d, s * sm, gy);
    if (!spell) {
      // старый onBossHit сам даёт 0.1 при amount ≥ 25 — доводим до 0.05..0.2
      const legacy = amount >= 25 ? 0.1 : 0;
      const want = 0.05 + 0.15 * s;
      if (want > legacy + 0.005) kit.shake(want - legacy);
      kit.hitstop(hsAttack(s));
    }
  });

  // ------------------------------------------------------------ [W4-УДАР] удар по нашему герою: ореол, пыль, след
  const HURT = 0xff2a18, HURT_HOT = 0xff8a5a;
  const fAura = { color: HURT, size: [0.6, 2.4], dur: 0.24, intensity: 2.0, sprite: 'glow', pull: 0.25, rival: false, curve: 0.5 };
  const fAuraRing = { color: HURT_HOT, size: [0.4, 2.6], dur: 0.26, intensity: 1.8, sprite: 'ring', pull: 0.25, rival: false, curve: 0.5 };
  const eAura = { at: null, shape: 'shell', radius: 0.55, radial: 2.6, count: 18, speed: [0, 0.3], life: [0.18, 0.36], size: [0.06, 0.012], ramp: 'blood', intensity: 2.6, sprite: 'spark', stretch: 0.025, drag: 3, essential: false, rival: false };
  const eKick = { at: new V3(), shape: 'ring', radius: 0.25, normal: UP, dir: UP, cone: 0.6, radial: 2.4, count: 10, speed: [0.3, 0.9], life: [0.6, 1.1], size: [0.3, 0.9], ramp: 'dust', blend: 'alpha', alpha: 0.7, intensity: 1, sprite: 'smoke', drag: 2.6, gravity: -0.1, turb: 0.3, spin: [-0.6, 0.6], essential: false, rival: false };
  const eGrit = { at: new V3(), dir: new V3(), cone: 0.7, count: 6, speed: [1.5, 3.5], life: [0.4, 0.75], size: [0.05, 0.04], sizeVar: 0.5, ramp: 'stone', blend: 'alpha', intensity: 0.9, sprite: 'debris', gravity: 9.8, drag: 0.6, spin: [-9, 9], ground: 0, essential: false, rival: false };
  const ringHurt = { pos: new V3(), r0: 0.2, r1: 1.8, dur: 0.34, color: HURT, hot: HURT_HOT, intensity: 1.5, thickness: 0.16, dustAmount: 1.3, distort: 0.4, wall: 0.25, rival: 0 };
  const decHurt = { pos: new V3(), radius: 0.8, kind: 'crack', life: 4.5, color: 0xd8442a, hot: HURT_HOT, intensity: 1.1, rival: 0, tag: 'hit', cap: 4, merge: 0.7 };
  const kHurt = { color: 0xff4a2a, intensity: 0.7, range: 6, dur: 0.3, attack: 0.04 };
  function heroHurt(p, dir, s, feet) {
    const lo = lowQ();
    fAura.size[1] = 2.0 + 0.8 * s; kit.flash(p, fAura);
    if (!lo) { fAuraRing.size[1] = 2.2 + 0.9 * s; kit.flash(p, fAuraRing); }
    eAura.at = p; eAura.count = 14 + 12 * s; emitB(eAura);
    // пыль из-под ног и мелкий щебень — по направлению отброса
    eKick.at.set(feet.x, feet.y + 0.06, feet.z); eKick.count = 8 + 8 * s; eKick.radial = 2 + 1.5 * s; emitB(eKick);
    eGrit.at.copy(eKick.at); eGrit.dir.set(dir.x, 0.9, dir.z); eGrit.ground = feet.y + 0.02; eGrit.count = 4 + 5 * s; emitB(eGrit);
    if (fx.shock && !lo) { ringHurt.pos.set(feet.x, feet.y + 0.04, feet.z); ringHurt.r1 = 1.5 + 0.8 * s; try { fx.shock.ring(ringHurt); } catch (e) { /* ignore */ } }
    if (fx.decals) {
      decHurt.pos.set(feet.x - dir.x * 0.25, feet.y, feet.z - dir.z * 0.25); decHurt.radius = 0.6 + 0.4 * s; decHurt.cap = decalCap();
      try { fx.decals.spawn(decHurt); } catch (e) { /* ignore */ }
    }
    kHurt.intensity = 0.5 + 0.5 * s; kit.light(p, kHurt);
  }

  // ------------------------------------------------------------ player_hit: наш герой (или соперник) получил удар
  function fleshHit(ev, d, victimRemote) {
    const p = fx.evPos(ev, _p) || fx.anchor('chest', _p, victimRemote);
    const feetY = fx.anchor('feet', _c1, victimRemote).y;
    if (p.y < feetY + 0.3) fx.anchor('chest', p, victimRemote);
    const amount = num(d.amount, 15);
    const s = clamp((amount - 10) / 40, 0, 1);
    // сила удара направлена от атакующего к жертве: брызги летят туда же
    if (hasVec(d.direction) && Math.hypot(d.direction.x, d.direction.z) > 1e-3) {
      _d.set(d.direction.x, 0, d.direction.z).normalize(); _d.y = 0.3; _d.normalize();
    } else {
      if (victimRemote) fx.anchor('chest', _c0, false); else fx.target(_c0, false);
      _d.set(p.x - _c0.x, 0, p.z - _c0.z);
      if (_d.lengthSq() < 1e-6) _d.set(0, 0, 1);
      _d.normalize(); _d.y = 0.3; _d.normalize();
    }
    const gy = groundAt(p, feetY);
    hitFlesh(p, _d, s, gy, victimRemote);
    const spell = isSpellSrc(d);
    if (!victimRemote) {
      _u.set(_c1.x, gy, _c1.z);
      heroHurt(p, _d, s, _u);   // [W4-УДАР]
      if (d.shieldPierced) breakShield(SH[0], p, 1, 'pierce');   // слэм сквозь щит — пролом
      // старый onPlayerHit даёт 0.32 + толчок; цель 0.25..0.5
      const want = 0.25 + 0.25 * s;
      if (want > 0.325) kit.shake(want - 0.32);
      if (!spell) kit.hitstop(amount < 16 ? 12 : 30 + 40 * s);
    } else {
      kit.shake(0.05 + 0.1 * s);
      if (!spell) kit.hitstop(hsAttack(clamp((amount - 10) / 50, 0, 1)));
      audio('bossHit', p, amount);
    }
  }
  fx.on('player_hit', (ev, d) => {
    // «кто пострадал» — по точке события: ближе к сопернику → соперник (наш удар), иначе — мы
    let victimRemote = false;
    const s = fx.snap;
    if (s && s.opponent && hasVec(s.opponent.position) && hasVec(ev && ev.position)) {
      fx.anchor('chest', _c0, true); fx.anchor('chest', _c1, false);
      const P = ev.position;
      victimRemote = Math.hypot(P.x - _c0.x, P.z - _c0.z) + 0.5 < Math.hypot(P.x - _c1.x, P.z - _c1.z);
    }
    fleshHit(ev, d, victimRemote);
    return victimRemote ? true : undefined; // старый onPlayerHit рисует только по нашему герою
  });
  fx.on('player_hit_remote', (ev, d) => { fleshHit(ev, d, true); return true; });

  // ------------------------------------------------------------ projectile_impact: дерево / земля / удар соперника
  fx.on('projectile_impact', (ev, d) => {
    const p = fx.evPos(ev, _p);
    if (!p) return;
    const res = d.result;
    if (hasVec(d.direction)) { _d.set(-d.direction.x, -d.direction.y, -d.direction.z); if (_d.lengthSq() < 1e-8) camDir(p, _d); else _d.normalize(); }
    else camDir(p, _d);
    _d.y += 0.4; _d.normalize();
    const gy = groundAt(p, 0);
    if (res === 'tree' || d.material === 'wood') hitWood(p, _d, 0.5, gy);
    else if (res === 'ground' || res === 'floor') hitDirt(p, d.owner === 'boss' ? 0.8 : 0.45, gy);
    const k = d.kind;
    if (fx.isRemote(d) && d.owner !== 'boss' && (!k || k === 'spark' || k === 'bolt' || k === 'slash')) {
      rivalImpact(p, _d, 0.4);
      kit.kick(_u.set(-_d.x, 0, -_d.z), 0.012);
      audio('boltImpact', p);
      return true; // старый удар — янтарный, у соперника он фиолетовый
    }
  });

  // ================================================================== 3) ЩИТ
  const SH_R = 1.0, SH_FWD = 0.85;
  function mkShield(side) {
    // [W4-УДАР] dmg — износ от ударов (гаснет), broken — сек до нового раскрытия после пролома, breakT — когда пролом
    const S = { side, h: null, open: 0, on: false, flash: 0, acc: 0, pos: new V3(), f: new V3(), r: new V3(), dmg: 0, broken: 0, breakT: -9 };
    S.st = { pos: S.pos, normal: S.f, radius: SH_R, open: 0, yaw: 0, intensity: 1, damage: 0 };
    return S;
  }
  const SH = [mkShield(0), mkShield(1)];
  if (fx.hex) fx.suppress('shield');
  function shieldFrame(S) {
    const remote = S.side === 1;
    fx.anchor('chest', S.pos, remote);
    fx.facing(S.f, remote);
    S.pos.addScaledVector(S.f, SH_FWD); S.pos.y += 0.05;
    S.r.set(-S.f.z, 0, S.f.x);
  }
  const emMote = { at: new V3(), vel: new V3(), count: 1, speed: [0, 0.1], life: [0.25, 0.45], size: [0.05, 0.01], ramp: 'gold', intensity: 2.4, sprite: 'spark', stretch: 0.02, drag: 1.5, rival: false };
  function shieldOpenFx(S) {
    const remote = S.side === 1, P = remote ? RIV : GOLD;
    shieldFrame(S);
    kit.flash(S.pos, { color: P.hot, size: [0.3, 1.9], dur: 0.22, intensity: 1.6, sprite: 'ring', pull: 0.1, rival: remote });
    kit.emit({ at: S.pos, shape: 'ring', normal: S.f, radius: 0.9, count: 18, tangent: 1.6, speed: [0, 0.2], life: [0.2, 0.35], size: [0.05, 0.01], ramp: remote ? 'rival' : 'gold', intensity: 2.8, sprite: 'spark', stretch: 0.02, drag: 2, rival: remote });
    distort(S.pos, 0.25);
    shock('haze', { pos: S.pos, radius: 0.9, height: 0.4, dur: 0.35, strength: 0.5 });
  }
  function shieldTick(S, who, dt, alive) {
    // [W4-УДАР] после пролома щит закрыт ~0,5 с (ячейки осыпаются при прежнем раскрытии), потом проломленный
    // меш освобождается, и щит раскрывается заново, если его всё ещё держат
    if (dt > 0 && S.broken > 0) {
      S.broken = Math.max(0, S.broken - dt);
      if (S.broken <= 0 && S.h && S.h.broken) { try { S.h.dispose(); } catch (e) { /* ignore */ } S.h = null; S.open = 0; }
    }
    const want = !!(who && who.shielding === true && alive) && S.broken <= 0;
    if (want && !S.on) shieldOpenFx(S);
    S.on = want;
    if (dt > 0) {
      const hold = S.broken > 0 && !!S.h && S.h.broken;
      S.open = want ? Math.min(1, S.open + dt / 0.14) : hold ? S.open : Math.max(0, S.open - dt / 0.2);
      S.flash = Math.max(0, S.flash - dt * 4);
      S.dmg = Math.max(0, S.dmg - dt * 0.22);
    }
    if (S.open <= 0 && !want) {
      if (S.h) { try { if (S.h.dispose) S.h.dispose(); } catch (e) { /* ignore */ } S.h = null; }
      return;
    }
    const remote = S.side === 1, P = remote ? RIV : GOLD;
    shieldFrame(S);
    const e = easeOut(S.open);
    if (fx.hex && (!S.h || S.h.alive === false)) {
      try { S.h = fx.hex.create({ kind: 'front', color: P.mid, hot: P.core, rival: remote ? 1 : 0 }); } catch (err) { S.h = null; }
    }
    if (S.h && typeof S.h.setState === 'function') {
      const st = S.st;
      st.radius = SH_R * (0.55 + 0.45 * Math.max(e, S.flash * 0.8));
      st.open = e; st.yaw = Math.atan2(S.f.x, S.f.z); st.intensity = 0.6 + 0.8 * S.flash;
      // [W4-УДАР] износ: удары + расход энергии (пустеющий щит весь в трещинах)
      const en = who && isNum(who.energy) && isNum(who.maxEnergy) && who.maxEnergy > 0 ? 1 - who.energy / who.maxEnergy : 0;
      st.damage = clamp(Math.max(S.dmg, en * 0.75), 0, 1);
      try { S.h.setState(st); } catch (err) { /* ignore */ }
    }
    // искры, бегущие по кромке (≤ ~35/с)
    if (S.open > 0.6 && dt > 0 && S.broken <= 0) {
      S.acc += dt * 34;
      const R = SH_R * (0.55 + 0.45 * e) * 0.97;
      while (S.acc >= 1) {
        S.acc -= 1;
        const a = Math.random() * TAU, ca = Math.cos(a), sa = Math.sin(a);
        emMote.at.set(S.pos.x + (S.r.x * ca) * R, S.pos.y + sa * R, S.pos.z + (S.r.z * ca) * R);
        const w = (Math.random() < 0.5 ? -1 : 1) * 0.7;
        emMote.vel.set(-S.r.x * sa * w, ca * w, -S.r.z * sa * w);
        emMote.ramp = remote ? 'rival' : 'gold'; emMote.rival = remote;
        kit.emit(emMote);
      }
    }
  }
  // блок: попадание в щит — трещины, искры, отдача
  const emCrack = { at: null, dir: new V3(), cone: 0.04, count: 2, speed: [3.5, 6], life: [0.08, 0.15], size: [0.05, 0.02], ramp: 'gold', intensity: 3.6, sprite: 'streak', stretch: 0.06, drag: 14, essential: true, rival: false };
  // [W4-УДАР] звон: искры бегут по кромке щита; пыль у ног — героя сдвинуло; пролом — осколки и вспышка
  const emChime = { at: new V3(), shape: 'ring', normal: new V3(), radius: 0.9, count: 22, tangent: 3.2, radial: 0.6, speed: [0, 0.2], life: [0.18, 0.32], size: [0.05, 0.01], ramp: 'gold', intensity: 3.0, sprite: 'spark', stretch: 0.02, drag: 2.5, essential: false, rival: false };
  const emSlide = { at: new V3(), radius: 0.15, dir: new V3(), cone: 0.7, count: 8, speed: [0.6, 1.6], life: [0.5, 0.9], size: [0.22, 0.7], ramp: 'dust', blend: 'alpha', alpha: 0.6, intensity: 1, sprite: 'smoke', drag: 2.8, gravity: -0.1, turb: 0.3, spin: [-0.6, 0.6], essential: false, rival: false };
  const emShard = { at: null, dir: new V3(), cone: 1.2, count: 18, speed: [2.5, 7], life: [0.5, 1.0], size: [0.09, 0.05], sizeVar: 0.5, ramp: 'gold', intensity: 2.8, sprite: 'shard', gravity: 7, drag: 0.9, spin: [-14, 14], ground: -1e4, essential: true, rival: false };
  const emShardDust = { at: null, radius: 0.4, count: 14, speed: [0.2, 0.9], life: [0.5, 0.9], size: [0.06, 0.01], ramp: 'gold', intensity: 2.6, sprite: 'flake', spin: [-3, 3], drag: 1.5, gravity: 1.2, essential: false, rival: false };
  const decSlide = { pos: new V3(), radius: 0.7, kind: 'scorch', life: 4, color: 0xe8a14a, hot: 0xffd28a, intensity: 0.8, rival: 0, tag: 'hit', cap: 4, merge: 0.7 };
  const shatO = { point: null, strength: 1, ground: 0 };
  const _sp = new V3();
  // пролом щита: why — 'pierce' (удар сквозь щит), 'drain' (блок исчерпал энергию), 'pvp', 'fizzle' (иссяк сам)
  function breakShield(S, at, strength, why) {
    if (kit.clock - S.breakT < 0.25) return;   // блок и shield_end одного удара — один пролом
    S.breakT = kit.clock;
    const remote = S.side === 1, P = remote ? RIV : GOLD, ramp = remote ? 'rival' : 'gold';
    shieldFrame(S);
    const p = at && hasVec(at) ? _sp.set(at.x, at.y, at.z) : _sp.copy(S.pos);
    const soft = why === 'fizzle';
    const k = soft ? 0.35 : clamp(strength, 0.4, 1);
    const feetY = fx.anchor('feet', _c1, remote).y;
    // сам щит: ячейки осыпаются, пластины разлетаются (на low пластин нет — больше частиц)
    let plates = false;
    if (S.h && typeof S.h.shatter === 'function' && S.open > 0.05) {
      shatO.point = p; shatO.strength = k; shatO.ground = feetY;
      try { S.h.shatter(shatO); plates = !lowQ(); } catch (e) { plates = false; }
    }
    S.broken = soft ? 0.35 : 0.55; S.flash = 1; S.dmg = 0;
    emShard.at = p; emShard.dir.copy(S.f); emShard.ramp = ramp; emShard.rival = remote; emShard.ground = feetY + 0.02;
    emShard.count = (plates ? 8 : 22) * (0.5 + 0.5 * k); emShard.speed[1] = 4 + 4 * k;
    emitB(emShard);
    emShardDust.at = p; emShardDust.ramp = ramp; emShardDust.rival = remote; emShardDust.count = 8 + 10 * k; emitB(emShardDust);
    if (!soft) {
      kit.flash(p, { color: P.core, size: [0.3, 1.6 + 0.6 * k], dur: 0.14, intensity: 4.4, sprite: 'star', pull: 0.25, rival: remote });
      kit.flash(p, { color: P.hot, size: [0.3, 2.4], dur: 0.3, intensity: 1.8, sprite: 'ring', pull: 0.2, rival: remote, curve: 0.5 });
      kit.light(p, { color: P.hot, intensity: 0.9, range: 7, dur: 0.35, attack: 0.03 });
      emitB({ at: p, dir: S.f, cone: 1.3, count: 18 + 16 * k, speed: [3, 8], life: [0.2, 0.5], size: [0.06, 0.012], ramp, intensity: 3.2, sprite: 'spark', stretch: 0.035, gravity: 5, drag: 1.8, rival: remote, essential: true });
      distort(p, 0.5);
      if (!remote) { pulse('punch', 0.45 * k, p); kit.shake(0.1 * k); }
      kit.hitstop(30 + 20 * k);
    }
  }
  fx.on('block', (ev, d) => {
    const remote = fx.isRemote(d);
    const S = SH[remote ? 1 : 0], P = remote ? RIV : GOLD, ramp = remote ? 'rival' : 'gold';
    shieldFrame(S);
    const R = SH_R * (0.55 + 0.45 * Math.max(easeOut(S.open), 0.8));
    const p = fx.evPos(ev, _p) || _p.copy(S.pos);
    // точка на плоскости щита, не дальше 0.85 R от центра
    _q.subVectors(p, S.pos);
    _q.addScaledVector(S.f, -_q.dot(S.f));
    const l = _q.length();
    if (l > 0.85 * R) _q.multiplyScalar(0.85 * R / l);
    p.copy(S.pos).add(_q);
    const strength = clamp(num(d.prevented, num(d.amount, 20)) / 30, 0.35, 1);
    S.flash = 1; if (S.open < 0.5) S.open = 0.5;
    S.dmg = Math.min(1, S.dmg + 0.12 + 0.16 * strength);   // [W4-УДАР] износ
    if (S.h && typeof S.h.hit === 'function') { try { S.h.hit({ point: { x: p.x, y: p.y, z: p.z }, strength }); } catch (e) { /* ignore */ } }
    kit.flash(p, { color: P.core, size: [0.14, 0.8], dur: 0.1, intensity: 4, sprite: 'star', pull: 0.2, rival: remote });
    kit.flash(p, { color: P.hot, size: [0.1, 1.3], dur: 0.26, intensity: 1.8, sprite: 'ring', pull: 0.15, rival: remote });
    // трещины: короткие штрихи в плоскости щита
    emCrack.at = p; emCrack.ramp = ramp; emCrack.rival = remote;
    const n = 7, a0 = Math.random() * TAU;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * TAU + (Math.random() - 0.5) * 0.5;
      emCrack.dir.set(S.r.x * Math.cos(a), Math.sin(a), S.r.z * Math.cos(a));
      kit.emit(emCrack);
    }
    // искры отскакивают от щита к атакующему
    kit.emit({ at: p, dir: S.f, cone: 1.1, count: 8 + 14 * strength, speed: [2.5, 6], life: [0.2, 0.45], size: [0.05, 0.01], ramp, intensity: 3, sprite: 'spark', stretch: 0.03, gravity: 5, drag: 2, rival: remote, essential: true });
    kit.emit({ at: p, radius: 0.1, count: 6, speed: [0.3, 1], life: [0.3, 0.6], size: [0.04, 0.01], ramp: remote ? 'rival' : 'time', intensity: 2.2, sprite: 'dot', drag: 2, rival: remote });
    // [W4-УДАР] звон по кромке, пыль у ног (героя сдвинуло ударом), след ног на земле
    emChime.at.copy(S.pos); emChime.normal.copy(S.f); emChime.radius = R * 0.95; emChime.ramp = ramp; emChime.rival = remote;
    emChime.count = 14 + 14 * strength; emitB(emChime);
    const fy = fx.anchor('feet', _c1, remote);
    emSlide.at.set(fy.x, groundAt(fy, fy.y) + 0.06, fy.z); emSlide.dir.set(-S.f.x, 0.35, -S.f.z); emSlide.count = 5 + 6 * strength; emitB(emSlide);
    if (fx.decals && !remote && strength > 0.5) {
      decSlide.pos.set(fy.x, emSlide.at.y - 0.06, fy.z); decSlide.cap = decalCap();
      try { fx.decals.spawn(decSlide); } catch (e) { /* ignore */ }
    }
    // блок исчерпал энергию — щит проломлен
    if (isNum(d.energyAfter) && d.energyAfter <= 0 && !d.ward && !d.bastion) breakShield(S, p, strength, 'drain');
    kit.hitstop(20);
    if (remote) {
      // старый onBlock рисует по НАШЕМУ щиту — для соперника рисуем сами
      kit.light(p, { color: P.mid, intensity: 0.5, range: 6, dur: 0.25 });
      kit.shake(0.04);
      audio('block', p);
      return true;
    }
    // свой: старый onBlock даёт вспышку, толчок 0.03 и тряску 0.08
  });

  // [W4-УДАР] щит иссяк сам (без удара) — тихое осыпание; PvP: соперник проломил наш щит
  fx.on('shield_end', (ev, d) => { if (d && d.reason === 'depleted') breakShield(SH[0], null, 0.3, 'fizzle'); }, (d) => !fx.isRemote(d));
  fx.on('shield_break', (ev, d) => { breakShield(SH[0], fx.evPos(ev, _q), 1, 'pvp'); }, (d) => !fx.isRemote(d));

  // ================================================================== 4) ПАРИРОВАНИЕ И ИДЕАЛЬНОЕ УКЛОНЕНИЕ
  fx.on('parry', (ev, d) => {
    if (!d || !d.success) return;
    const remote = fx.isRemote(d), rv = remote ? 1 : 0;
    const p = fx.evPos(ev, new V3()) || fx.anchor('handL', new V3(), remote);
    const PC = remote ? RIV : GOLD, PT = remote ? RIV : TIME;
    // плоскость серпа — лицом к камере, наклон 35°
    const cd = camDir(p, new V3());
    const cr = new V3().crossVectors(UP, cd); if (cr.lengthSq() < 1e-6) cr.set(1, 0, 0); cr.normalize();
    const cu = new V3().crossVectors(cd, cr).normalize();
    const tilt = remote ? -0.6 : 0.6, R = 0.52;
    const ax = new V3().copy(cr).multiplyScalar(Math.cos(tilt)).addScaledVector(cu, Math.sin(tilt));
    const ay = new V3().copy(cr).multiplyScalar(-Math.sin(tilt)).addScaledVector(cu, Math.cos(tilt));
    const c = new V3().copy(p).addScaledVector(ax, -R * 0.55);
    const N = 13, A = 1.35, pt = new V3(), tg = new V3();
    for (let i = 0; i < N; i++) {
      const u = (i / (N - 1)) * 2 - 1, th = u * A;
      const w = Math.pow(Math.cos(u * Math.PI * 0.5), 0.8);
      pt.copy(c).addScaledVector(ax, Math.cos(th) * R).addScaledVector(ay, Math.sin(th) * R);
      kit.flash(pt, { color: PC.hot, size: [0.12 + 0.3 * w, 0.06 + 0.2 * w], dur: 0.16, intensity: 2.6, sprite: 'glow', pull: 0.4, rival: remote, curve: 1 });
      kit.flash(pt, { color: PC.core, size: [0.05 + 0.13 * w, 0.02], dur: 0.11, intensity: 4.5, sprite: 'glow', pull: 0.45, rival: remote, curve: 1 });
      if (i % 3 === 1) {
        tg.copy(ax).multiplyScalar(-Math.sin(th)).addScaledVector(ay, Math.cos(th)).multiplyScalar(u < 0 ? -1 : 1);
        kit.emit({ at: pt, dir: tg, cone: 0.25, count: 3, speed: [3, 6], life: [0.12, 0.25], size: [0.05, 0.01], ramp: remote ? 'rival' : 'gold', intensity: 3.4, sprite: 'spark', stretch: 0.04, drag: 4, rival: remote, essential: true });
      }
    }
    kit.flash(p, { color: PC.core, size: [0.2, 1.1], dur: 0.1, intensity: 4.5, sprite: 'star', pull: 0.45, rival: remote });
    // «замедление времени»: кольца-рябь (второе — эхо), частицы по кольцу, искажение воздуха
    kit.flash(p, { color: PT.hot, size: [0.2, 1.4], dur: 0.4, intensity: 1.8, sprite: 'ring', pull: 0.3, rival: remote, curve: 0.6 });
    kit.flash(p, { color: PT.mid, size: [0.1, 1.0], dur: 0.45, intensity: 1.3, sprite: 'ring', pull: 0.3, rival: remote, curve: 0.7, delay: 0.1 });
    kit.emit({ at: p, shape: 'ring', normal: cd, radius: 0.25, radial: 4.2, drag: 3.5, count: 30, speed: [0, 0.2], life: [0.35, 0.55], size: [0.07, 0.015], ramp: remote ? 'rival' : 'time', intensity: 2.6, sprite: 'spark', stretch: 0.02, rival: remote, essential: true });
    kit.emit({ at: p, radius: 0.3, count: 10, speed: [0.1, 0.4], life: [0.6, 1.0], size: [0.09, 0.03], ramp: remote ? 'rival' : 'time', intensity: 2, sprite: 'flake', spin: [-1, 1], drag: 1, rival: remote });
    distort(p, 0.55);
    kit.light(p, { color: PT.hot, intensity: 0.8, range: 7, dur: 0.35, attack: 0.05 });
    kit.hitstop(38);
    if (remote) { kit.shake(0.06); audio('block', p); return true; } // старый рисует по нашей руке и нашим цветом
  });

  fx.on('perfect_dodge', (ev, d) => {
    const remote = fx.isRemote(d), rv = remote ? 1 : 0;
    const feet = fx.evPos(ev, new V3()) || fx.anchor('feet', new V3(), remote);
    feet.y = groundAt(feet, feet.y);
    const PT = remote ? RIV : TIME, ramp = remote ? 'rival' : 'time';
    const head = fx.anchor('head', _c0, remote);
    const H = clamp(head.y - feet.y, 1.2, 2.4);
    const right = fx.right(new V3(), remote);
    const mid = new V3(feet.x, feet.y + H * 0.5, feet.z);
    // остаточный образ: «призрак» тела из частиц на месте уклонения
    kit.emit({ at: mid, shape: 'box', box: { x: 0.2, y: H * 0.45, z: 0.1 }, count: 38, speed: [0.05, 0.3], life: [0.35, 0.6], size: [0.26, 0.1], ramp, intensity: 1.5, alpha: 0.7, sprite: 'glow', fadeIn: 0, drag: 1, turb: 0.3, rival: remote, essential: true });
    kit.emit({ at: { x: feet.x, y: feet.y + H - 0.12, z: feet.z }, radius: 0.12, count: 8, speed: [0.05, 0.2], life: [0.35, 0.55], size: [0.24, 0.08], ramp, intensity: 1.5, alpha: 0.7, sprite: 'glow', fadeIn: 0, rival: remote, essential: true });
    // смаз движения в стороны
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      kit.emit({ at: mid, shape: 'box', box: { x: 0.15, y: H * 0.4, z: 0.05 }, dir: { x: right.x * sgn, y: 0, z: right.z * sgn }, cone: 0.08, count: 8, speed: [3, 6], life: [0.12, 0.22], size: [0.06, 0.02], ramp, intensity: 3, sprite: 'streak', stretch: 0.05, drag: 6, rival: remote });
    }
    // холодное кольцо по земле + круг-«циферблат»
    const g = new V3(feet.x, feet.y + 0.06, feet.z);
    kit.emit({ at: g, shape: 'ring', radius: 0.4, radial: 6.5, drag: 4, count: 40, dir: UP, cone: 0.2, speed: [0, 0.4], life: [0.3, 0.5], size: [0.12, 0.03], ramp, intensity: 2.6, sprite: 'spark', stretch: 0.02, rival: remote, essential: true });
    kit.emit({ at: mid, radius: 0.5, count: 12, speed: [0.1, 0.5], life: [0.6, 1.0], size: [0.08, 0.03], ramp, intensity: 2, sprite: 'flake', spin: [-1.5, 1.5], drag: 1, rival: remote });
    if (fx.glyph) {
      try { fx.glyph.spawn({ pos: { x: feet.x, y: feet.y + 0.04, z: feet.z }, radius: 1.35, symbol: null, style: 'clock', color: PT.mid, hot: PT.core, intensity: 1.8, dur: 0.7, unfold: 0.12, fade: 0.35, spin: -3, rings: 2, ticks: 60, rival: rv }); } catch (e) { /* ignore */ }
    }
    shock('ring', { pos: g, r0: 0.3, r1: 3.2, dur: 0.45, color: PT.mid, hot: PT.core, intensity: 1.6, rival: rv });
    kit.flash(fx.anchor('chest', _c1, remote), { color: PT.core, size: [0.2, 0.9], dur: 0.14, intensity: 3, sprite: 'star', pull: 0.7, rival: remote });
    if (remote) return true; // старый рисует у нашего героя
  });

  // ================================================================== 5) ПОЯВЛЕНИЕ И ГИБЕЛЬ ГЕРОЯ
  const lastSpawn = [-1e9, -1e9];
  const dead = [false, false];
  const aliveT = [1, 1];
  // переиспользуемые описания частиц для акторов (поля меняются перед каждым emit)
  const emBeam = { at: null, shape: 'line', to: null, count: 4, speed: [0, 0.2], life: [0.3, 0.5], size: [0.42, 0.18], ramp: 'gold', intensity: 2.2, sprite: 'glow', fadeIn: 0, essential: true, rival: false };
  const emHead = { at: null, dir: DOWN, cone: 0.05, count: 2, speed: [14, 20], life: [0.05, 0.08], size: [0.2, 0.1], ramp: 'whiteHold', intensity: 4, sprite: 'streak', stretch: 0.05, essential: true, rival: false };
  const emAsm = { at: new V3(), shape: 'ring', radius: 0.75, count: 2, radial: -2.4, orbit: 3, center: new V3(), speed: [0, 0.1], life: [0.22, 0.34], size: [0.06, 0.015], ramp: 'gold', intensity: 3, sprite: 'spark', stretch: 0.015, essential: true, rival: false };
  const emTw = { at: new V3(), shape: 'box', box: { x: 0.2, y: 0.5, z: 0.12 }, count: 1, speed: [0, 0.1], life: [0.3, 0.45], size: [0.13, 0.02], ramp: 'gold', intensity: 3, sprite: 'star', rival: false };
  const emUp = { at: new V3(), shape: 'disk', radius: 0.3, count: 1, dir: UP, cone: 0.1, speed: [2.5, 4], life: [0.35, 0.6], size: [0.04, 0.01], ramp: 'gold', intensity: 3, sprite: 'spark', stretch: 0.03, drag: 0.5, rival: false };
  const glyphSet = { radius: 1, intensity: 1 };

  function spawnFx(side, feetIn) {
    const remote = side === 1, rv = remote ? 1 : 0;
    if (kit.clock - lastSpawn[side] < 0.9) return;
    lastSpawn[side] = kit.clock; dead[side] = false; aliveT[side] = 1;
    const feet = new V3();
    if (feetIn && hasVec(feetIn)) feet.set(feetIn.x, feetIn.y, feetIn.z); else fx.anchor('feet', feet, remote);
    feet.y = groundAt(feet, feet.y);
    let H = fx.anchor('head', _c0, remote).y - feet.y;
    if (!(H > 0.9 && H < 3)) H = 1.75;
    const P = remote ? RIV : GOLD, ramp = remote ? 'rival' : 'gold', emb = remote ? 'rival' : 'ember';
    const top = 9, T1 = 0.26;
    const hp = new V3(), prev = new V3(feet.x, feet.y + top, feet.z);
    kit.flash(prev, { color: P.hot, size: [0.6, 2.6], dur: 0.45, intensity: 1.8, sprite: 'glow', pull: 0, rival: remote });
    // 1) столб света падает сверху на ноги
    kit.actor({
      dur: T1,
      update(t, k) {
        hp.set(feet.x, feet.y + top * (1 - k * k), feet.z);
        emBeam.at = prev; emBeam.to = hp; emBeam.ramp = ramp; emBeam.rival = remote; kit.emit(emBeam);
        emHead.at = hp; emHead.rival = remote; kit.emit(emHead);
        prev.copy(hp);
      },
      end() { land(); },
    });
    function land() {
      const g = new V3(feet.x, feet.y + 0.06, feet.z);
      kit.flash(_c1.set(feet.x, feet.y + 0.2, feet.z), { color: P.core, size: [0.3, 1.5], dur: 0.18, intensity: 4, sprite: 'star', pull: 0.4, rival: remote });
      kit.flash(_c1.set(feet.x, feet.y + 0.5, feet.z), { color: P.hot, size: [0.6, 2.0], dur: 0.4, intensity: 1.6, sprite: 'glow', pull: 0.3, rival: remote });
      // столб держится и гаснет
      kit.emit({ at: g, shape: 'line', to: { x: feet.x, y: feet.y + 7, z: feet.z }, count: 30, dir: UP, speed: [0, 0.4], life: [0.4, 0.75], size: [0.5, 0.22], ramp, intensity: 1.8, alpha: 0.85, sprite: 'glow', fadeIn: 0, rival: remote, essential: true });
      kit.emit({ at: g, shape: 'line', to: { x: feet.x, y: feet.y + 5, z: feet.z }, count: 10, speed: [0, 0.2], life: [0.5, 0.8], size: [1.1, 0.8], ramp, intensity: 0.7, alpha: 0.45, sprite: 'glow', fadeIn: 0, rival: remote });
      // волна искр по земле
      kit.emit({ at: g, shape: 'ring', radius: 0.3, radial: 5.5, drag: 4, count: 36, dir: UP, cone: 0.2, speed: [0, 0.5], life: [0.3, 0.55], size: [0.1, 0.03], ramp, intensity: 2.8, sprite: 'spark', stretch: 0.02, rival: remote, essential: true });
      shock('ring', { pos: g, r0: 0.3, r1: 3.4, dur: 0.5, color: P.mid, hot: P.core, intensity: 1.6, rival: rv });
      kit.light(_c1.set(feet.x, feet.y + 1, feet.z), { color: P.hot, intensity: 1.3, range: 10, dur: 1.1, attack: 0.08 });
      // угольки поднимаются
      kit.emit({ at: g, shape: 'disk', radius: 1.3, count: 34, dir: UP, cone: 0.35, speed: [0.5, 1.6], life: [0.9, 1.5], size: [0.05, 0.01], ramp: emb, intensity: 2.6, sprite: 'ember', gravity: -0.5, drag: 0.6, turb: 0.5, delay: 0.8, rival: remote });
      // рунический круг раскрывается
      let gh = null;
      if (fx.glyph) {
        try { gh = fx.glyph.spawn({ pos: { x: feet.x, y: feet.y + 0.04, z: feet.z }, radius: 0.5, symbol: null, style: 'sigil', color: P.mid, hot: P.core, intensity: 2.2, dur: 1.5, unfold: 0.3, fade: 0.45, spin: 0.9, rings: 3, ticks: 40, rival: rv }); } catch (e) { gh = null; }
        if (gh && gh.flare) gh.flare(1);
      }
      // 2) «сборка» тела: искры закручиваются к оси и поднимаются от ног к голове
      kit.actor({
        dur: 0.85,
        update(t, k) {
          const e = easeOut(k), h = feet.y + 0.05 + (H + 0.1) * e;
          if (gh && gh.alive && gh.set) { glyphSet.radius = 0.5 + 1.3 * easeOut(Math.min(1, t / 0.5)); glyphSet.intensity = 2.2; gh.set(glyphSet); }
          emAsm.at.set(feet.x, h, feet.z); emAsm.center.copy(feet); emAsm.radius = 0.75 - 0.25 * k;
          emAsm.ramp = ramp; emAsm.rival = remote; kit.emit(emAsm);
          const hh = Math.max(0.05, (h - feet.y) * 0.5);
          emTw.at.set(feet.x, feet.y + hh, feet.z); emTw.box.y = hh; emTw.ramp = ramp; emTw.rival = remote; kit.emit(emTw);
          emUp.at.set(feet.x, feet.y + 0.05, feet.z); emUp.ramp = ramp; emUp.rival = remote; kit.emit(emUp);
        },
        end() {
          // собран: вспышка на груди, короткий выдох искр
          const ch = fx.anchor('chest', new V3(), remote);
          kit.flash(ch, { color: P.core, size: [0.3, 1.3], dur: 0.3, intensity: 2.4, sprite: 'glow', pull: 0.7, rival: remote });
          kit.flash(ch, { color: P.core, size: [0.12, 0.7], dur: 0.12, intensity: 3.6, sprite: 'star', pull: 0.75, rival: remote });
          kit.emit({ at: ch, shape: 'shell', radius: 0.35, radial: 1.8, count: 20, speed: [0, 0.4], life: [0.3, 0.6], size: [0.05, 0.01], ramp, intensity: 2.8, sprite: 'spark', stretch: 0.02, drag: 2, rival: remote });
          if (gh && gh.alive && gh.flare) gh.flare(0.8);
        },
      });
    }
    audio('cast', feet);
  }

  const emAsh = { at: new V3(), shape: 'box', box: { x: 0.22, y: 0.1, z: 0.14 }, count: 3, dir: UP, cone: 0.6, speed: [0.4, 1.2], life: [1.2, 2.0], size: [0.05, 0.035], sizeVar: 0.5, ramp: 'ash', blend: 'alpha', intensity: 1.3, sprite: 'debris', gravity: -0.4, drag: 0.7, turb: 0.7, spin: [-3, 3], essential: true };
  const emDEmb = { at: new V3(), shape: 'box', box: { x: 0.2, y: 0.1, z: 0.12 }, count: 1, dir: UP, cone: 0.5, speed: [0.8, 2], life: [0.7, 1.3], size: [0.05, 0.01], ramp: 'ember', intensity: 3, sprite: 'ember', gravity: -0.6, drag: 0.8, turb: 0.6, essential: true, rival: false };
  const emSmk = { at: new V3(), radius: 0.2, count: 1, dir: UP, cone: 0.5, speed: [0.3, 0.8], life: [1.2, 2.0], size: [0.35, 1.0], ramp: 'smoke', blend: 'alpha', alpha: 0.7, intensity: 1, sprite: 'smoke', gravity: -0.3, drag: 0.8, turb: 0.4, spin: [-0.6, 0.6] };
  const emSoul = { at: new V3(), count: 1, speed: [0, 0.15], life: [0.3, 0.45], size: [0.3, 0.05], ramp: 'time', intensity: 2.6, sprite: 'glow', fadeIn: 0, essential: true, rival: false };
  const emSoulSp = { at: new V3(), radius: 0.08, count: 1, speed: [0.1, 0.5], life: [0.4, 0.7], size: [0.04, 0.01], ramp: 'time', intensity: 2.6, sprite: 'spark', turb: 0.5, drag: 1, rival: false };
  const emWisp = { at: new V3(), count: 1, speed: [0, 0.01], life: [0.05, 0.06], size: [0.5, 0.5], ramp: 'whiteHold', intensity: 2.2, sprite: 'wisp', rot: 0, fadeIn: 0, essential: true, rival: false };

  function deathFx(side, at) {
    if (dead[side]) return;
    dead[side] = true; aliveT[side] = 0;
    const remote = side === 1, rv = remote ? 1 : 0;
    const feet = new V3();
    if (at && hasVec(at)) feet.set(at.x, at.y, at.z); else fx.anchor('feet', feet, remote);
    feet.y = groundAt(feet, feet.y);
    const chest = fx.anchor('chest', new V3(), remote);
    let H = fx.anchor('head', _c0, remote).y - feet.y;
    if (!(H > 0.9 && H < 3)) H = 1.75;
    const emb = remote ? 'rival' : 'ember', soul = remote ? 'rival' : 'time';
    const PS = remote ? RIV : TIME;
    // внутренний уголь вспыхивает
    kit.flash(chest, { color: remote ? RIV.hot : 0xffb070, size: [0.3, 1.2], dur: 0.32, intensity: 2.3, sprite: 'glow', pull: 0.7, rival: remote });
    kit.emit({ at: chest, radius: 0.25, count: 22, dir: UP, cone: 1.2, speed: [1, 3], life: [0.4, 0.9], size: [0.05, 0.01], ramp: emb, intensity: 3, sprite: 'spark', stretch: 0.02, gravity: -0.5, drag: 1.5, rival: remote, essential: true });
    kit.emit({ at: _c1.set(feet.x, feet.y + 0.3, feet.z), radius: 0.4, count: 6, dir: UP, cone: 1, speed: [0.2, 0.7], life: [1.4, 2.2], size: [0.6, 1.5], ramp: 'smoke', blend: 'alpha', alpha: 0.7, intensity: 1, sprite: 'smoke', gravity: -0.25, drag: 1, turb: 0.3, spin: [-0.5, 0.5] });
    kit.light(chest, { color: remote ? RIV.mid : 0xff7a30, intensity: 1.0, range: 7, dur: 1.6, attack: 0.1 });
    // 1) тело рассыпается сверху вниз: пепел (обычное смешивание) + угольки
    let fr = 0;
    kit.actor({
      dur: 1.2,
      update(t, k) {
        const y = feet.y + 0.1 + (H - 0.05) * (1 - k);
        emAsh.at.set(feet.x, y, feet.z); kit.emit(emAsh);
        emDEmb.at.set(feet.x, y, feet.z); emDEmb.ramp = emb; emDEmb.rival = remote; kit.emit(emDEmb);
        if ((fr++ & 3) === 0) { emSmk.at.set(feet.x, y, feet.z); kit.emit(emSmk); }
      },
    });
    // 2) тускнеющий круг на земле
    if (fx.glyph) {
      let gh = null;
      try { gh = fx.glyph.spawn({ pos: { x: feet.x, y: feet.y + 0.04, z: feet.z }, radius: 1.25, symbol: null, style: 'sigil', color: remote ? RIV.deep : FIRE.deep, hot: remote ? RIV.mid : FIRE.mid, intensity: 2.0, dur: 2.6, unfold: 0.25, fade: 1.2, spin: 0.25, rings: 2, ticks: 24, rival: rv }); } catch (e) { gh = null; }
      if (gh) {
        kit.actor({ dur: 2.2, update(t, k) { if (!gh.alive || !gh.set) return false; glyphSet.radius = 1.25 + 0.15 * k; glyphSet.intensity = 2.0 - 1.6 * k; gh.set(glyphSet); } });
      }
    }
    kit.emit({ at: _c1.set(feet.x, feet.y + 0.05, feet.z), shape: 'ring', radius: 1.2, count: 18, dir: UP, cone: 0.3, speed: [0.2, 0.6], life: [0.8, 1.4], size: [0.05, 0.01], ramp: emb, intensity: 2.4, sprite: 'ember', rgrow: -0.4, gravity: -0.3, drag: 0.5, delay: 0.6, rival: remote });
    // 3) душа уходит вверх
    const base = new V3().copy(chest);
    let tr = null;
    kit.after(0.5, () => {
      kit.flash(base, { color: PS.core, size: [0.15, 0.8], dur: 0.2, intensity: 3, sprite: 'star', pull: 0.7, rival: remote });
      if (fx.trails) { try { tr = fx.trails.create({ width: 0.12, life: 0.5, color: PS.mid, hot: PS.core, intensity: 2, taper: 1, rival: rv, style: 'ghost', maxPoints: 24, minDist: 0.06 }); } catch (e) { tr = null; } }
      let n = 0;
      kit.actor({
        dur: 1.6,
        update(t) {
          const y = 0.25 + 1.1 * t + 0.9 * t * t;
          const sw = 0.14 * Math.sin(t * 5.5) * Math.min(1, t * 2);
          const px = base.x + sw, py = base.y + y, pz = base.z + 0.08 * Math.cos(t * 4.3);
          emSoul.at.set(px, py, pz); emSoul.ramp = soul; emSoul.rival = remote; kit.emit(emSoul);
          emWisp.at.set(px, py + 0.1, pz); emWisp.rival = remote; emWisp.ramp = remote ? 'rival' : 'whiteHold'; kit.emit(emWisp);
          if ((n++ & 1) === 0) { emSoulSp.at.set(px, py, pz); emSoulSp.ramp = soul; emSoulSp.rival = remote; kit.emit(emSoulSp); }
          if (tr && tr.alive !== false && tr.push) tr.push(emSoul.at);
        },
        end() {
          if (tr && tr.stop) { try { tr.stop(); } catch (e) { /* ignore */ } }
          kit.flash(emSoul.at, { color: PS.hot, size: [0.3, 0.9], dur: 0.35, intensity: 1.8, sprite: 'glow', pull: 0, rival: remote });
        },
      });
    });
    if (!remote) kit.shake(0.12);
  }

  fx.on('hero_spawn', (ev, d) => { spawnFx(fx.isRemote(d) ? 1 : 0, ev && ev.position); return true; });
  fx.on('hero_death', (ev, d) => { deathFx(fx.isRemote(d) ? 1 : 0, ev && ev.position); return true; });
  fx.on('pvp_round', (ev, d) => { if (d && d.phase === 'fight') { spawnFx(0, null); spawnFx(1, null); } });
  fx.on('defeat', () => { deathFx(0, null); });
  fx.on('victory', () => { if (isPvp()) deathFx(1, null); });

  // Автопоявление в одиночном бою (новый бой: статус стал 'playing' или время боя пошло назад).
  // На dev-стенде (window.__stand) стенд сбрасывается между сценариями — там только по ?autospawn.
  function autoSpawnAllowed() {
    try {
      if (typeof window !== 'undefined' && window.__stand) return typeof location !== 'undefined' && /[?&]autospawn/.test(location.search || '');
    } catch (e) { /* ignore */ }
    return true;
  }

  const life = { init: false, status: null, time: null, plDead: false, opDead: null };
  fx.every((dt, snap) => {
    if (!snap) return;
    const pl = snap.player, op = snap.opponent, st = snap.status;
    const playing = st === 'playing' || st == null;
    const plDead = !!pl && pl.action === 'dead';
    const opDead = !!op && (op.action === 'dead' || (isNum(op.hp) && op.hp <= 0));
    // щиты
    shieldTick(SH[0], pl, dt, playing && !plDead);
    shieldTick(SH[1], op, dt, playing && !!op && !opDead);
    // гибель по переходам снимка (защёлка dead[] — не дважды)
    if (life.init) {
      if (plDead && !life.plDead) deathFx(0, null);
      if (st === 'defeat' && life.status !== 'defeat') deathFx(0, null);
      if (opDead && life.opDead === false) deathFx(1, null);
    }
    // снова жив ≥ 0.6 с — защёлка снимается
    if (pl && !plDead && playing && !(isNum(pl.hp) && pl.hp <= 0)) { aliveT[0] += dt; if (aliveT[0] > 0.6) dead[0] = false; } else aliveT[0] = 0;
    if (op && !opDead) { aliveT[1] += dt; if (aliveT[1] > 0.6) dead[1] = false; } else aliveT[1] = 0;
    // появление в одиночном бою
    if (snap.mode !== 'pvp' && !op && st === 'playing' && autoSpawnAllowed()) {
      if (!life.init) { if (isNum(snap.time) && snap.time < 0.5) spawnFx(0, null); }
      else if (life.status !== 'playing') spawnFx(0, null);
      else if (isNum(snap.time) && isNum(life.time) && snap.time + 0.25 < life.time) spawnFx(0, null);
    }
    life.init = true; life.status = st; life.time = isNum(snap.time) ? snap.time : null;
    life.plDead = plDead; life.opDead = op ? opDead : null;
  });

  // ---------------------------------------------------------------- [VFX] снаряды соперника (PvP) — холодный фиолетовый
  // Снаряды с remote:true (modules/pvp.js) рисуются здесь целиком: ядро, вытянутый штрих, лента-след; стрелы и
  // сгустки — в bowHand.js, иглы «Акуса» — в runesWild.js.
  fx.suppress('proj:remote');
  const rTr = new Map();
  let rTag = 0;
  const rCore = { at: new V3(), count: 1, speed: [0, 0], life: [0.05, 0.07], size: [0.34, 0.26], ramp: 'rival', intensity: 2.6, sprite: 'glow', essential: true, rival: true };
  const rStreak = { at: new V3(), dir: new V3(), cone: 0.01, count: 1, speed: [20, 24], life: [0.04, 0.06], size: [0.14, 0.08], ramp: 'rival', intensity: 3, sprite: 'streak', stretch: 0.03, essential: true, rival: true };
  const rSpark = { at: new V3(), count: 1, radius: 0.1, speed: [0.3, 1.2], life: [0.2, 0.4], size: [0.05, 0.01], ramp: 'rival', intensity: 2.6, sprite: 'spark', drag: 2, rival: true };
  fx.every((dt, snap) => {
    const list = snap && Array.isArray(snap.projectiles) ? snap.projectiles : null;
    rTag++;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const pr = list[i];
        if (!pr || !pr.remote || !pr.position || pr.kind === 'arrow' || pr.kind === 'hand_orb') continue;
        const id = String(pr.id);
        let r = rTr.get(id);
        if (!r) {
          let tr = null;
          if (fx.trails) { try { tr = fx.trails.create({ width: Math.max(0.12, (pr.radius || 0.2) * 0.9), life: 0.2, color: fx.E.rival.mid, hot: fx.E.rival.core, intensity: 2.2, style: 'energy', maxPoints: 16, rival: 1 }); } catch (e) { tr = null; } }
          r = { tr, seen: 0 }; rTr.set(id, r);
        }
        r.seen = rTag;
        const p = pr.position, v = pr.velocity;
        const big = Math.max(0.6, Math.min(2.5, (pr.radius || 0.2) / 0.2));
        rCore.at.set(p.x, p.y, p.z); rCore.size[0] = 0.34 * big; rCore.size[1] = 0.26 * big;
        if (dt > 0) kit.emit(rCore);
        if (v && dt > 0) { rStreak.at.set(p.x, p.y, p.z); rStreak.dir.set(v.x, v.y, v.z); kit.emit(rStreak); }
        if (dt > 0 && Math.random() < 0.5) { rSpark.at.set(p.x, p.y, p.z); kit.emit(rSpark); }
        if (r.tr) { try { r.tr.push(p); } catch (e) { /* ignore */ } }
      }
    }
    for (const [id, r] of rTr) if (r.seen !== rTag) { if (r.tr) { try { r.tr.stop(); } catch (e) { /* ignore */ } } rTr.delete(id); }
  });

  // ---------------------------------------------------------------- [VFX] рывок, оберег, бастион соперника (net/session.js)
  const _ro = new V3(), _rf = new V3();
  fx.on('player_dash', (ev, d) => {
    const P = fx.E.rival;
    fx.anchor('feet', _ro, true); fx.anchor('chest', _rf, true);
    kit.emit({ at: _rf, radius: 0.35, count: 26, speed: [1, 3], life: [0.2, 0.4], size: [0.1, 0.03], ramp: 'rival', intensity: 2.4, sprite: 'streak', stretch: 0.03, drag: 3, rival: true, essential: true });
    kit.emit({ at: { x: _ro.x, y: _ro.y + 0.05, z: _ro.z }, count: 10, radius: 0.3, speed: [0.5, 1.8], life: [0.5, 0.8], size: [0.2, 0.5], ramp: 'dust', alpha: 0.6, sprite: 'smoke', blend: 'alpha', drag: 2.5, gravity: -0.2 });
    kit.flash(_rf, { color: P.hot, size: [0.3, 1.1], dur: 0.2, intensity: 1.8, sprite: 'glow', pull: 0.6, rival: true });
    return true;
  }, (d) => fx.isRemote(d));
  fx.on('ward_start', (ev, d) => {
    const P = fx.E.rival;
    fx.anchor('chest', _rf, true);
    kit.flash(_rf, { color: P.hot, size: [0.4, 1.4], dur: 0.45, intensity: 1.8, sprite: 'ring', pull: 0.6, rival: true });
    kit.emit({ at: _rf, shape: 'shell', radius: 0.7, count: 24, speed: [0.1, 0.4], life: [0.6, 1], size: [0.06, 0.01], ramp: 'rival', intensity: 2.4, sprite: 'spark', rival: true });
    return true;
  }, (d) => fx.isRemote(d));
  fx.on('bastion_start', (ev, d) => {
    const P = fx.E.rival;
    fx.anchor('feet', _ro, true);
    if (fx.glyph) { try { fx.glyph.spawn({ pos: { x: _ro.x, y: _ro.y + 0.04, z: _ro.z }, radius: 1.6, symbol: 'gate', style: 'sigil', color: P.mid, hot: P.core, intensity: 1.6, dur: 1.4, rival: 1 }); } catch (e) { /* ignore */ } }
    kit.emit({ at: _ro, shape: 'ring', radius: 1.4, count: 36, dir: { x: 0, y: 1, z: 0 }, cone: 0.1, speed: [1.5, 3], life: [0.6, 1], size: [0.07, 0.01], ramp: 'rival', intensity: 2.4, sprite: 'spark', stretch: 0.03, rival: true });
    return true;
  }, (d) => fx.isRemote(d));
  for (const t of ['ward_end', 'bastion_end', 'shield_start', 'shield_end', 'mark_start', 'mark_end', 'slow_start', 'slow_end', 'vortex_end', 'regen_end', 'conjure_start', 'conjure_end', 'dodge', 'cruise_start', 'cruise_end']) {
    fx.on(t, () => true, (d) => fx.isRemote(d)); // щит/метки соперника — по snap.opponent; у своего героя не рисуем
  }
}
