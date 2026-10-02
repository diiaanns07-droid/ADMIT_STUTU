// ASHEN OATH — modules/fx/castFx.js. Владелец: №7 [VFX]. [W3-МАГИЯ]
// Ядро, ореол, искры и свет у снарядов и выбросов: выброс, сфера, снаряды «OK», руны.
// Всё — «добавки» поверх существующих слоёв (нова sigils, тело сферы/призмы и болт старого effects.js,
// иглы runesWild, отпечаток handMagic, сами руны): обработчики НИКОГДА не возвращают true —
// модуль стоит в CHOREO раньше остальных, true съел бы старые эффекты (и onThrow — передачу тела снаряду).
//  - выброс (burst): белое ядро-вспышка у груди (+ у кулака/обеих ладоней), ореол, веер искр по power, свет;
//  - сотворение (snap.player.conjure): пока тело между ладонями — ореол и искры, стягивающиеся к ядру
//    (по аккумулятору, без аллокаций), «готово» (charge → 1) — короткая звезда; бросок — ядро, ореол, конус искр;
//  - полёт своих сфер/призм (snap.projectiles kind 'sphere'|'prism'): ореол и шлейф искр по id (пул записей),
//    мягкий свет, следующий за снарядом (только у сфер/призм);
//  - снаряды «OK» (kind 'bolt') и «Искра» ('spark', кроме игл caret:*): яркое ядро и искры-ореол вдоль полёта
//    по аккумулятору; без света и без лент (у болта свой хвост, у искры — свой в sigils);
//  - руны (rune_cast): короткое ядро и искры у руки в цвете стихии руны; свет — только stella/fulgur/ignis.
// Попадание своего снаряда: в fx.shared.castHit пишется направление полёта (последняя скорость записи) —
// его читает hitFx.js (в реальном бою у projectile_impact/boss_hit нет direction).
// Снаряды соперника (owner 'opponent' / remote) рисует combatFx.js — здесь пропускаются.

import { clamp, isNum, hasVec } from './common.js';

// руна → строка градиента стихии (именованные ramp kit)
const RUNE_RAMP = {
  ignis: 'fire', fulgur: 'storm', orbis: 'heal', stella: 'star', spira: 'wind',
  lemnis: 'eternal', caret: 'frost', vee: 'void', clepsydra: 'time', alpha: 'reset',
};
const RUNE_EL = {
  ignis: 'fire', fulgur: 'storm', orbis: 'heal', stella: 'star', spira: 'wind',
  lemnis: 'eternal', caret: 'frost', vee: 'void', clepsydra: 'time', alpha: 'reset',
};
const BIG_RUNE = { stella: 1, fulgur: 1, ignis: 1 };
const POOL_N = 24;

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const E = fx.E;
  const num = (v, d) => (isNum(v) ? v : d);
  const decor = () => (kit.Q && isNum(kit.Q.decor) ? kit.Q.decor : 0.8);
  const soft = () => { try { return fx.reduced() ? 0.6 : 1; } catch (e) { return 1; } };
  const EMPTY = [];

  // общее с hitFx: последнее попадание своего снаряда (kit.clock кадра, id, вид, направление полёта, точка)
  const castHit = { t: -1, id: '', kind: '', has: false, dir: new V3(0, 0, -1), pos: new V3(), speed: 0 };
  fx.shared.castHit = castHit;

  // временные векторы обработчиков (только синхронно внутри одного вызова)
  const _p = new V3(), _q = new V3(), _d = new V3(), _l = new V3(), _r = new V3(), _t = new V3();

  // ------------------------------------------------------------ предвыделенные опции (мутируются перед вызовом)
  const fCore = { ramp: 'whiteHold', size: [0.2, 1.0], dur: 0.14, intensity: 4, sprite: 'star', pull: 0.45, rival: false, delay: 0, fadeIn: 0.04, curve: 0.45 };
  const fHalo = { ramp: 'gold', size: [0.4, 1.4], dur: 0.3, intensity: 2.0, sprite: 'glow', pull: 0.45, rival: false, delay: 0, fadeIn: 0.04, curve: 0.45 };
  const eFan = { at: null, dir: null, cone: 0.6, count: 20, speed: [3, 8], life: [0.18, 0.4], size: [0.06, 0.01], ramp: 'gold', intensity: 3.2, sprite: 'spark', stretch: 0.03, drag: 3, gravity: 1.5, rival: false, essential: false };
  const eShell = { at: null, shape: 'shell', radius: 0.5, count: 12, radial: -2, speed: [0, 0.15], life: [0.18, 0.26], size: [0.035, 0.07], ramp: 'gold', intensity: 2.8, sprite: 'spark', stretch: 0.03, fadeIn: 0.3, rival: false, essential: true };

  // ============================================================ ВЫБРОС (burst)
  // Нову целиком рисует sigils.js (звезда, сфера, кольца, свет); здесь — белое ядро «изнутри» и веер искр.
  fx.on('burst', (ev, d) => {
    const R = fx.isRemote(d);
    const pw = clamp(num(d.power, 0.6), 0, 1);
    const both = !!d.both;
    const sf = soft();
    const p = fx.evPos(ev, _p);
    fx.anchor('feet', _t, R);
    if (!p || p.y < _t.y + 0.3) fx.anchor('chest', _p, R);
    const ramp = R ? 'rival' : 'gold';
    // белое ядро-вспышка и ореол у груди
    fCore.ramp = 'whiteHold'; fCore.size[0] = 0.25; fCore.size[1] = (1.0 + 0.8 * pw) * sf; fCore.dur = 0.16; fCore.intensity = 4.2; fCore.sprite = 'star'; fCore.pull = 0.7; fCore.rival = R; fCore.delay = 0;
    kit.flash(_p, fCore);
    fHalo.ramp = ramp; fHalo.size[0] = 0.5; fHalo.size[1] = (1.6 + 1.0 * pw) * sf; fHalo.dur = 0.34 + 0.12 * pw; fHalo.intensity = 2.0; fHalo.sprite = 'glow'; fHalo.pull = 0.7; fHalo.rival = R; fHalo.delay = 0;
    kit.flash(_p, fHalo);
    // у кулака (или у обеих ладоней) — маленькие белые ядра
    fx.anchor('handR', _r, R);
    fCore.size[0] = 0.12; fCore.size[1] = 0.55 * sf; fCore.dur = 0.12; fCore.intensity = 3.6; fCore.pull = 0.4;
    kit.flash(_r, fCore);
    if (both) { fx.anchor('handL', _l, R); kit.flash(_l, fCore); }
    // веер искр к цели (по power), и белые искры во все стороны
    fx.target(_q, R);
    _d.subVectors(_q, _p); if (_d.lengthSq() < 1e-6) _d.set(0, 0, -1); _d.normalize();
    eFan.at = _p; eFan.dir = _d; eFan.cone = 0.55; eFan.count = (18 + 30 * pw) * (both ? 1.25 : 1); eFan.speed[0] = 5; eFan.speed[1] = 10 + 8 * pw;
    eFan.life[0] = 0.16; eFan.life[1] = 0.38; eFan.size[0] = 0.07; eFan.ramp = ramp; eFan.intensity = 3.4; eFan.gravity = 1.5; eFan.drag = 3; eFan.rival = R; eFan.essential = false;
    kit.emit(eFan);
    eFan.dir = null; eFan.cone = Math.PI; eFan.count = 10 + 14 * pw; eFan.speed[0] = 2; eFan.speed[1] = 5; eFan.ramp = R ? 'rival' : 'white'; eFan.size[0] = 0.05;
    kit.emit(eFan);
    eFan.dir = null;
    // свет ядра (на low kit.light → null); sigils даёт свой золотой — этот белый, короче
    kit.light(_p, { color: R ? E.rival.core : 0xfff4e0, intensity: 0.6 + 0.6 * pw, range: 9, dur: 0.3, attack: 0.04 });
  });

  // ============================================================ СОТВОРЕНИЕ сферы / призмы (по снимку)
  const conj = { on: false, kind: '', ready: false, accHalo: 0, accSpark: 0 };
  const eHalo = { at: new V3(), count: 1, speed: [0, 0.08], life: [0.12, 0.18], size: [0.5, 0.35], sizeVar: 0.15, ramp: 'gold', intensity: 1.6, sprite: 'glow', fadeIn: 0.3, essential: true, rival: false };
  const eDraw = { at: new V3(), shape: 'shell', radius: 0.6, count: 1, radial: -2.6, speed: [0, 0.1], life: [0.2, 0.26], size: [0.03, 0.06], ramp: 'gold', intensity: 2.8, sprite: 'spark', stretch: 0.03, fadeIn: 0.25, curve: 1, essential: true, rival: false };
  const fReady = { ramp: 'whiteHold', size: [0.15, 1.1], dur: 0.2, intensity: 4, sprite: 'star', pull: 0.4, rival: false };
  function conjCenter(pl, out) {
    if (hasVec(pl.conjurePoint)) return out.set(pl.conjurePoint.x, pl.conjurePoint.y, pl.conjurePoint.z);
    fx.anchor('handL', _l, false); fx.anchor('handR', _r, false);
    return out.set((_l.x + _r.x) * 0.5, (_l.y + _r.y) * 0.5, (_l.z + _r.z) * 0.5);
  }
  function conjTick(dt, snap) {
    const pl = snap && snap.player;
    const c = pl && pl.conjure && typeof pl.conjure === 'object' ? pl.conjure : null;
    if (!c || pl.action === 'dead') { conj.on = false; conj.ready = false; conj.accHalo = 0; conj.accSpark = 0; return; }
    const prism = c.kind === 'prism';
    const ch = clamp(num(c.charge, 0), 0, 1), sz = clamp(num(c.size, 0), 0, 1);
    const ramp = prism ? 'reset' : 'gold';
    if (!conj.on || conj.kind !== c.kind) { conj.on = true; conj.kind = prism ? 'prism' : 'orb'; conj.ready = false; }
    conjCenter(pl, eHalo.at);
    if (!conj.ready && ch >= 0.995) {
      conj.ready = true;
      fReady.size[1] = (0.8 + 0.6 * sz) * soft();
      kit.flash(eHalo.at, fReady);
      eShell.at = eHalo.at; eShell.radius = 0.7 + 0.4 * sz; eShell.radial = -3.2; eShell.count = 14 * decor(); eShell.ramp = ramp; eShell.rival = false;
      kit.emit(eShell);
    }
    if (!(dt > 0)) return;
    const k = 0.35 + 0.65 * ch;
    // ореол: мягкие glow-частицы на месте ядра (по аккумулятору, ~22/с)
    conj.accHalo += dt * 22;
    let n = Math.floor(conj.accHalo);
    if (n > 0) {
      conj.accHalo -= n; if (n > 3) n = 3;
      eHalo.count = n; eHalo.ramp = ramp; eHalo.size[0] = (0.35 + 0.45 * sz) * k; eHalo.size[1] = eHalo.size[0] * 0.7; eHalo.intensity = 1.2 + 1.2 * ch;
      kit.emit(eHalo);
    }
    // искры стягиваются к ядру (~(14..40)/с × decor)
    conj.accSpark += dt * (14 + 26 * ch) * decor();
    n = Math.floor(conj.accSpark);
    if (n > 0) {
      conj.accSpark -= n; if (n > 4) n = 4;
      eDraw.at.copy(eHalo.at); eDraw.count = n; eDraw.ramp = ramp; eDraw.radius = 0.45 + 0.35 * sz; eDraw.radial = -eDraw.radius / 0.22;
      eDraw.intensity = 2.2 + 0.8 * ch;
      kit.emit(eDraw);
    }
  }

  // ------------------------------------------------------------ бросок сферы / призмы (onThrow старого слоя обязателен)
  fx.on('player_cast', (ev, d) => {
    const R = fx.isRemote(d);
    const prism = d.kind === 'prism';
    const pw = clamp(num(d.power, 0.6), 0, 1), sz = clamp(num(d.size, 0.5), 0, 1);
    const sf = soft();
    const p = fx.evPos(ev, _p) || (fx.snap && fx.snap.player && hasVec(fx.snap.player.conjurePoint) ? _p.copy(fx.snap.player.conjurePoint) : fx.anchor('chest', _p, R));
    const ramp = R ? 'rival' : (prism ? 'reset' : 'gold');
    if (hasVec(d.velocity)) _d.set(d.velocity.x, d.velocity.y, d.velocity.z); else { fx.target(_q, R); _d.subVectors(_q, p); }
    if (_d.lengthSq() < 1e-6) _d.set(0, 0, -1);
    _d.normalize();
    fCore.ramp = 'whiteHold'; fCore.size[0] = 0.2; fCore.size[1] = (0.9 + 0.6 * sz) * sf; fCore.dur = 0.13; fCore.intensity = 4; fCore.sprite = 'star'; fCore.pull = 0.45; fCore.rival = R; fCore.delay = 0;
    kit.flash(p, fCore);
    fHalo.ramp = ramp; fHalo.size[0] = 0.35; fHalo.size[1] = (1.2 + 0.8 * sz) * sf; fHalo.dur = 0.26; fHalo.intensity = 1.9; fHalo.sprite = 'glow'; fHalo.pull = 0.45; fHalo.rival = R; fHalo.delay = 0;
    kit.flash(p, fHalo);
    eFan.at = p; eFan.dir = _d; eFan.cone = 0.42; eFan.count = 14 + 20 * pw; eFan.speed[0] = 4; eFan.speed[1] = 9 + 6 * pw; eFan.life[0] = 0.14; eFan.life[1] = 0.32;
    eFan.size[0] = 0.06; eFan.ramp = ramp; eFan.intensity = 3.2; eFan.gravity = 1; eFan.drag = 3.5; eFan.rival = R; eFan.essential = false;
    kit.emit(eFan);
    eFan.dir = null;
    // свет броска даёт свет полёта (запись снаряда) — здесь не берём второй слот
  }, (d) => d.ability === 'throw');

  // ------------------------------------------------------------ каст «OK»: маленькая белая звезда у руки (поверх янтаря)
  fx.on('player_cast', (ev, d) => {
    const R = fx.isRemote(d);
    const p = fx.evPos(ev, _p) || fx.anchor('handR', _p, R);
    fCore.ramp = 'whiteHold'; fCore.size[0] = 0.08; fCore.size[1] = 0.42 * soft(); fCore.dur = 0.08; fCore.intensity = 3.6; fCore.sprite = 'star'; fCore.pull = 0.35; fCore.rival = R; fCore.delay = 0;
    kit.flash(p, fCore);
  }, (d) => d.ability === 'bolt');

  // ============================================================ ПОЛЁТ своих снарядов: записи по id (пул)
  // r.cls: 1 — сфера/призма (ореол, шлейф искр, свет), 2 — «OK»-болт, 3 — «Искра».
  const recs = new Map();
  const pool = [];
  function makeRec() {
    const r = { id: '', cls: 0, prism: false, pos: new V3(), prev: new V3(), vel: new V3(), lp: new V3(), rad: 0.3, pw: 0.6, age: 0, tag: 0, accA: 0, accB: 0, follow: null };
    r.follow = () => r.lp;          // замыкание создаётся один раз на запись пула
    return r;
  }
  for (let i = 0; i < POOL_N; i++) pool.push(makeRec());
  let tag = 0;
  const kLight = { color: 0xffe2a8, intensity: 0.5, range: 7, dur: 0.9, attack: 0.12, follow: null };
  function recGet(key, pr, cls) {
    const r = pool.pop() || makeRec();
    r.id = key; r.cls = cls; r.prism = pr.kind === 'prism'; r.age = 0; r.accA = 0; r.accB = 0;
    r.pos.set(pr.position.x, pr.position.y, pr.position.z); r.prev.copy(r.pos); r.lp.copy(r.pos);
    if (hasVec(pr.velocity)) r.vel.set(pr.velocity.x, pr.velocity.y, pr.velocity.z); else r.vel.set(0, 0, 0);
    r.rad = clamp(num(pr.radius, 0.3), 0.1, 1);
    r.pw = clamp(num(pr.power, 0.6), 0, 1);
    if (cls === 1) {
      // мягкий свет, идущий за сферой/призмой (на low → null; на medium слот отдаётся более сильным вспышкам)
      kLight.color = r.prism ? 0xdfe8ff : 0xffe2a8; kLight.intensity = 0.45 + 0.35 * r.pw; kLight.follow = r.follow;
      kit.light(r.pos, kLight);
      kLight.follow = null;
    }
    return r;
  }
  function recEnd(r) { r.cls = 0; if (pool.length < POOL_N * 2) pool.push(r); }
  function sweep(r, key) { if (r.tag !== tag) { recs.delete(key); recEnd(r); } }

  // опции полёта
  const eOrbHalo = { at: null, count: 1, speed: [0, 0.1], life: [0.1, 0.16], size: [0.8, 0.5], sizeVar: 0.15, ramp: 'gold', intensity: 1.6, sprite: 'glow', fadeIn: 0.2, essential: true, rival: false };
  const eOrbTrail = { at: null, radius: 0.2, count: 1, dir: null, cone: 0.9, speed: [0.3, 1.4], life: [0.25, 0.5], size: [0.06, 0.01], ramp: 'gold', intensity: 2.8, sprite: 'spark', stretch: 0.02, drag: 2.2, gravity: 1.2, essential: true, rival: false };
  const eBoltCore = { at: null, count: 1, speed: [0, 0.05], life: [0.05, 0.07], size: [0.34, 0.22], sizeVar: 0.1, ramp: 'whiteHold', intensity: 3, sprite: 'glow', fadeIn: 0.05, essential: true, rival: false };
  const eBoltSpark = { at: null, radius: 0.08, count: 1, dir: null, cone: 1.2, speed: [0.4, 1.6], life: [0.12, 0.26], size: [0.045, 0.008], ramp: 'gold', intensity: 3, sprite: 'spark', stretch: 0.02, drag: 2.5, gravity: 1.5, essential: true, rival: false };
  const _back = new V3();

  function flyTick(r, dt) {
    const dec = decor();
    // назад по полёту — искры осыпаются за снарядом
    _back.copy(r.vel); if (_back.lengthSq() > 1e-6) _back.normalize().multiplyScalar(-1); else _back.set(0, 1, 0);
    if (r.cls === 1) {
      const ramp = r.prism ? 'reset' : 'gold';
      r.accA += dt * 30;                                  // ореол ~30/с (держит «тело» ярче старого меша)
      let n = Math.floor(r.accA);
      if (n > 0) {
        r.accA -= n; if (n > 3) n = 3;
        eOrbHalo.at = r.pos; eOrbHalo.count = n; eOrbHalo.ramp = ramp; eOrbHalo.size[0] = 0.9 + 1.4 * r.rad; eOrbHalo.size[1] = eOrbHalo.size[0] * 0.6;
        eOrbHalo.intensity = 1.3 + 0.8 * r.pw;
        kit.emit(eOrbHalo);
      }
      r.accB += dt * (40 + 50 * r.pw) * dec;               // шлейф искр
      n = Math.floor(r.accB);
      if (n > 0) {
        r.accB -= n; if (n > 6) n = 6;
        eOrbTrail.at = r.pos; eOrbTrail.dir = _back; eOrbTrail.count = n; eOrbTrail.ramp = n & 1 ? ramp : 'white'; eOrbTrail.radius = r.rad * 0.7;
        kit.emit(eOrbTrail);
      }
    } else {
      const spark = r.cls === 3;
      r.accA += dt * (spark ? 40 : 34);                    // яркое ядро
      let n = Math.floor(r.accA);
      if (n > 0) {
        r.accA -= n; if (n > 2) n = 2;
        eBoltCore.at = r.pos; eBoltCore.count = n; eBoltCore.size[0] = spark ? 0.26 : 0.36; eBoltCore.size[1] = eBoltCore.size[0] * 0.6;
        kit.emit(eBoltCore);
      }
      r.accB += dt * (spark ? 22 : 30) * dec;              // искры-ореол
      n = Math.floor(r.accB);
      if (n > 0) {
        r.accB -= n; if (n > 3) n = 3;
        eBoltSpark.at = r.pos; eBoltSpark.dir = _back; eBoltSpark.count = n; eBoltSpark.ramp = spark ? 'storm' : 'gold';
        kit.emit(eBoltSpark);
      }
    }
  }

  function projTick(dt, snap) {
    tag++;
    const list = snap && Array.isArray(snap.projectiles) ? snap.projectiles : EMPTY;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      if (!pr || pr.owner !== 'player' || pr.remote || pr.id == null || !hasVec(pr.position)) continue;
      const kind = pr.kind;
      const cls = kind === 'sphere' || kind === 'prism' ? 1 : kind === 'bolt' ? 2 : kind === 'spark' ? 3 : 0;
      if (!cls) continue;
      const key = typeof pr.id === 'string' ? pr.id : String(pr.id);
      if (cls === 3 && key.startsWith('caret:')) continue;   // иглы «Акус» — runesWild.js
      let r = recs.get(key);
      if (!r) { r = recGet(key, pr, cls); recs.set(key, r); }
      r.tag = tag;
      r.prev.copy(r.pos);
      r.pos.set(pr.position.x, pr.position.y, pr.position.z);
      r.lp.copy(r.pos);
      if (hasVec(pr.velocity)) r.vel.set(pr.velocity.x, pr.velocity.y, pr.velocity.z);
      else if (dt > 0) r.vel.subVectors(r.pos, r.prev).multiplyScalar(1 / dt);
      if (!(dt > 0)) continue;
      r.age += dt;
      flyTick(r, dt);
    }
    recs.forEach(sweep);
  }

  // попадание своего снаряда: запись ещё жива (события раньше fx.every) → направление полёта для hitFx
  fx.on('projectile_impact', (ev, d) => {
    const key = d.projectileId == null ? '' : (typeof d.projectileId === 'string' ? d.projectileId : String(d.projectileId));
    const r = key ? recs.get(key) : undefined;
    castHit.t = kit.clock; castHit.id = key; castHit.kind = typeof d.kind === 'string' ? d.kind : '';
    castHit.has = false;
    const p = fx.evPos(ev, _p);
    if (p) castHit.pos.copy(p); else if (r) castHit.pos.copy(r.pos);
    if (r && r.vel.lengthSq() > 1e-6) { castHit.speed = r.vel.length(); castHit.dir.copy(r.vel).multiplyScalar(1 / castHit.speed); castHit.has = true; }
    else if (hasVec(d.direction)) { castHit.dir.set(d.direction.x, d.direction.y, d.direction.z); if (castHit.dir.lengthSq() > 1e-6) { castHit.dir.normalize(); castHit.has = true; } }
    if (!castHit.has) {
      // нет записи (стенд/тест) — от героя к точке
      fx.anchor('chest', _q, false);
      castHit.dir.subVectors(castHit.pos, _q); if (castHit.dir.lengthSq() < 1e-6) castHit.dir.set(0, 0, -1); castHit.dir.normalize();
      castHit.speed = 0;
    }
    if (r) { recs.delete(key); recEnd(r); }
  }, (d) => d.owner === 'player' && !fx.isRemote(d));

  // ============================================================ РУНЫ (rune_cast): ядро и искры в цвете стихии
  fx.on('rune_cast', (ev, d) => {
    const rune = typeof d.rune === 'string' ? d.rune : '';
    const R = fx.isRemote(d);
    const ramp = R ? 'rival' : (RUNE_RAMP[rune] || 'gold');
    const big = BIG_RUNE[rune] === 1;
    const sf = soft();
    // точка каста — рука, которой писали руну (немного к груди)
    fx.anchor('handR', _r, R); fx.anchor('chest', _q, R);
    _p.lerpVectors(_q, _r, 0.7);
    fCore.ramp = 'whiteHold'; fCore.size[0] = 0.14; fCore.size[1] = (big ? 1.1 : 0.7) * sf; fCore.dur = big ? 0.16 : 0.12; fCore.intensity = 4; fCore.sprite = 'star'; fCore.pull = 0.45; fCore.rival = R; fCore.delay = 0;
    kit.flash(_p, fCore);
    fHalo.ramp = ramp; fHalo.size[0] = 0.3; fHalo.size[1] = (big ? 1.5 : 1.0) * sf; fHalo.dur = big ? 0.32 : 0.24; fHalo.intensity = 2; fHalo.sprite = 'glow'; fHalo.pull = 0.45; fHalo.rival = R; fHalo.delay = 0;
    kit.flash(_p, fHalo);
    eFan.at = _p; eFan.dir = null; eFan.cone = Math.PI; eFan.count = big ? 26 : 14; eFan.speed[0] = 1.5; eFan.speed[1] = big ? 6 : 4; eFan.life[0] = 0.18; eFan.life[1] = 0.42;
    eFan.size[0] = 0.055; eFan.ramp = ramp; eFan.intensity = 3; eFan.gravity = 0.8; eFan.drag = 3; eFan.rival = R; eFan.essential = false;
    kit.emit(eFan);
    if (big) {
      const P = R ? E.rival : (E[RUNE_EL[rune]] || E.gold);
      kit.light(_p, { color: P.hot, intensity: 0.7, range: 7, dur: 0.28, attack: 0.08 });
    }
  });

  // ============================================================ по снимку
  fx.every((dt, snap) => {
    conjTick(dt, snap);
    projTick(dt, snap);
  });

  fx.onClear(() => {
    recs.forEach(recEnd); recs.clear();
    conj.on = false; conj.ready = false; conj.accHalo = 0; conj.accSpark = 0;
    castHit.t = -1; castHit.id = ''; castHit.has = false;
  });
  fx.onDispose(() => { recs.clear(); pool.length = 0; });
}
