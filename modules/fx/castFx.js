// ASHEN OATH — modules/fx/castFx.js. Владелец: №7 [VFX]. [W3-МАГИЯ] [W4-ЗАКЛИНАНИЯ]
// Ядро, ореол, искры и свет у снарядов и выбросов, предвестники жестов: выброс, сфера, снаряды «OK», печати, руны.
// Всё — «добавки» поверх существующих слоёв (нова sigils, тело сферы/призмы старого effects.js, иглы runesWild,
// отпечаток handMagic, сами руны и печати): обработчики НИКОГДА не возвращают true —
// модуль стоит в CHOREO раньше остальных, true съел бы старые эффекты (и onThrow — передачу тела снаряду).
// [W4-ЗАКЛИНАНИЯ] читаемость: что вылетело, откуда и куда.
//  - цвет: общие заклинания окрашены стихией героя (fx.heroEl / heroPal); призма — 'reset', соперник — 'rival';
//  - предвестник (common.herald, 0,15 с у руки — жест связан с эффектом): первый «OK» потока (дальше — только белая
//    звёздочка у ствола), выброс (у обеих ладоней / у кулака), начало сотворения, бросок (крупнее), «Искра»,
//    рассечение, печати (у обеих ладоней), руны (в стихии руны, с её знаком). «Врата» и «Столп» рисуют sigilGate /
//    sigilPillar целиком (return true раньше castFx) — свой каст узнаём по записи fx.shared.sigil.release
//    (её ставит sigilCharge в том же обработчике sigil_cast);
//  - выброс (burst): белое ядро-вспышка у груди, ореол, веер искр к цели по power, свет;
//  - сотворение (snap.player.conjure): пока тело между ладонями — ореол и искры, стягивающиеся к ядру
//    (по аккумулятору, без аллокаций), «готово» (charge → 1) — короткая звезда; бросок — ореол и конус искр;
//  - «OK» (kind 'bolt'): старый болт (меш, ореол, лента) подавлен — рисует комета (common.createComet): белое ядро,
//    ореол героя, искры-хвост, слой стихии, лента; свет — один на поток (не чаще ~0,6 с, на low нет);
//    болт исчез без попадания (истёк, улетел) — короткое угасание (вспышка и искры);
//  - полёт своих сфер/призм: комета по радиусу снаряда (тело — старый слой), один свет за головой;
//  - «Искра» ('spark', кроме игл caret:*): яркое ядро и искры вдоль полёта по аккумулятору (без света и лент);
//  - сцены «без каши» (kit.scope): комета болта — в сцене 'bolt', сфера/призма — в сцене своего броска, искра — 'spark'.
// Попадание своего снаряда: в fx.shared.castHit пишется направление полёта (последняя скорость записи) —
// его читает hitFx.js (в реальном бою у projectile_impact/boss_hit нет direction).
// Снаряды соперника (owner 'opponent' / remote) рисует combatFx.js — здесь пропускаются.

import { clamp, isNum, hasVec, rampOf, herald, createComet } from './common.js';

// руна → стихия (палитра fx.E и градиент kit)
const RUNE_EL = {
  ignis: 'fire', fulgur: 'storm', orbis: 'heal', stella: 'star', spira: 'wind',
  lemnis: 'eternal', caret: 'frost', vee: 'void', clepsydra: 'time', alpha: 'reset',
};
const POOL_N = 24;
const BOLT_STREAM = 0.6;   // пауза между «OK», после которой выстрел — начало нового потока (предвестник)
const BOLT_LIGHT = 0.6;    // свет болтов — не чаще (единственный слот medium не занимаем потоком)
const BOLT_RATE = 0.4;     // хвост и слой стихии кометы болта реже (в воздухе 2–5 болтов), голова — каждый кадр
const THROW_WIN = 0.4;     // запись сферы без своего броска берёт сцену броска не старше
const REM = Object.freeze({ remote: true });

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const num = (v, d) => (isNum(v) ? v : d);
  const decor = () => (kit.Q && isNum(kit.Q.decor) ? kit.Q.decor : 0.8);
  const soft = () => { try { return fx.reduced() ? 0.6 : 1; } catch (e) { return 1; } };
  const EMPTY = [];
  // [W4-ЗАКЛИНАНИЯ] стихия героя (соперник — 'rival')
  const elOf = (R) => fx.heroEl(R ? REM : null);

  // общее с hitFx: последнее попадание своего снаряда (kit.clock кадра, id, вид, направление полёта, точка)
  const castHit = { t: -1, id: '', kind: '', has: false, dir: new V3(0, 0, -1), pos: new V3(), speed: 0 };
  fx.shared.castHit = castHit;

  // временные векторы обработчиков (только синхронно внутри одного вызова)
  const _p = new V3(), _q = new V3(), _d = new V3(), _t = new V3();
  const _h = new V3(), _hl = new V3(), _hd = new V3(), _hq = new V3();

  // ------------------------------------------------------------ предвыделенные опции (мутируются перед вызовом)
  const fCore = { ramp: 'whiteHold', size: [0.2, 1.0], dur: 0.14, intensity: 4, sprite: 'star', pull: 0.45, rival: false, delay: 0, fadeIn: 0.04, curve: 0.45 };
  const fHalo = { ramp: 'gold', size: [0.4, 1.4], dur: 0.3, intensity: 2.0, sprite: 'glow', pull: 0.45, rival: false, delay: 0, fadeIn: 0.04, curve: 0.45 };
  const eFan = { at: null, dir: null, cone: 0.6, count: 20, speed: [3, 8], life: [0.18, 0.4], size: [0.06, 0.01], ramp: 'gold', intensity: 3.2, sprite: 'spark', stretch: 0.03, drag: 3, gravity: 1.5, rival: false, essential: false };
  const eShell = { at: null, shape: 'shell', radius: 0.5, count: 12, radial: -2, speed: [0, 0.15], life: [0.18, 0.26], size: [0.035, 0.07], ramp: 'gold', intensity: 2.8, sprite: 'spark', stretch: 0.03, fadeIn: 0.3, rival: false, essential: true };
  const kBurst = { color: 0xfff4e0, intensity: 0.6, range: 9, dur: 0.3, attack: 0.04 };

  // ============================================================ [W4-ЗАКЛИНАНИЯ] ПРЕДВЕСТНИК
  const hO = { symbol: undefined, scale: 1, dir: null, glyph: true };
  function hrd(at, el, R, scale, dir, symbol, glyph) {
    hO.symbol = symbol; hO.scale = scale; hO.dir = dir; hO.glyph = glyph !== false;
    herald(fx, at, el, R, hO);
    hO.dir = null; hO.symbol = undefined;
  }
  /** Единичное направление from → цель заклинателя (в out). */
  function aimFrom(from, R, out) {
    fx.target(_hq, R);
    out.subVectors(_hq, from);
    if (out.lengthSq() < 1e-6) out.set(0, 0, -1);
    return out.normalize();
  }
  /** У правой руки (both — у обеих; сомкнутые ладони — один крупнее между ними). Знак glyph — один (пул знаков). */
  function heraldHands(el, R, both) {
    fx.anchor('handR', _h, R);
    if (both) {
      fx.anchor('handL', _hl, R);
      if (_hl.distanceToSquared(_h) < 0.16) { _h.lerp(_hl, 0.5); hrd(_h, el, R, 1.2, aimFrom(_h, R, _hd), undefined, true); return; }
      hrd(_hl, el, R, 1, aimFrom(_hl, R, _hd), undefined, false);
    }
    hrd(_h, el, R, 1, aimFrom(_h, R, _hd), undefined, true);
  }

  // ============================================================ ВЫБРОС (burst)
  // Нову целиком рисует sigils.js (звезда, сфера, кольца, свет); здесь — предвестник у ладоней, белое ядро «изнутри»
  // и веер искр.
  fx.on('burst', (ev, d) => {
    const R = fx.isRemote(d);
    const pw = clamp(num(d.power, 0.6), 0, 1);
    const both = !!d.both;
    const sf = soft();
    const el = elOf(R), ramp = rampOf(el, R);
    const p = fx.evPos(ev, _p);
    fx.anchor('feet', _t, R);
    if (!p || p.y < _t.y + 0.3) fx.anchor('chest', _p, R);
    // предвестник у кулака / обеих ладоней (вместо прежних маленьких белых ядер)
    heraldHands(el, R, both);
    // белое ядро-вспышка и ореол у груди
    fCore.ramp = 'whiteHold'; fCore.size[0] = 0.25; fCore.size[1] = (1.0 + 0.8 * pw) * sf; fCore.dur = 0.16; fCore.intensity = 4.2; fCore.sprite = 'star'; fCore.pull = 0.7; fCore.rival = R; fCore.delay = 0;
    kit.flash(_p, fCore);
    fHalo.ramp = ramp; fHalo.size[0] = 0.5; fHalo.size[1] = (1.6 + 1.0 * pw) * sf; fHalo.dur = 0.34 + 0.12 * pw; fHalo.intensity = 2.0; fHalo.sprite = 'glow'; fHalo.pull = 0.7; fHalo.rival = R; fHalo.delay = 0;
    kit.flash(_p, fHalo);
    // веер искр к цели (по power), и белые искры во все стороны (меньше прежнего — искры дал предвестник)
    fx.target(_q, R);
    _d.subVectors(_q, _p); if (_d.lengthSq() < 1e-6) _d.set(0, 0, -1); _d.normalize();
    eFan.at = _p; eFan.dir = _d; eFan.cone = 0.55; eFan.count = 18 + 30 * pw; eFan.speed[0] = 5; eFan.speed[1] = 10 + 8 * pw;
    eFan.life[0] = 0.16; eFan.life[1] = 0.38; eFan.size[0] = 0.07; eFan.ramp = ramp; eFan.intensity = 3.4; eFan.gravity = 1.5; eFan.drag = 3; eFan.rival = R; eFan.essential = false;
    kit.emit(eFan);
    eFan.dir = null; eFan.cone = Math.PI; eFan.count = both ? 4 + 6 * pw : 6 + 8 * pw; eFan.speed[0] = 2; eFan.speed[1] = 5; eFan.ramp = R ? 'rival' : 'white'; eFan.size[0] = 0.05;
    kit.emit(eFan);
    eFan.dir = null; eFan.at = null;
    // свет ядра (на low kit.light → null); sigils даёт свой — этот светлее и короче
    kBurst.color = fx.heroPal(d).core; kBurst.intensity = 0.6 + 0.6 * pw;
    kit.light(_p, kBurst);
  });

  // ============================================================ СОТВОРЕНИЕ сферы / призмы (по снимку)
  const conj = { on: false, kind: '', ready: false, accHalo: 0, accSpark: 0 };
  const eHalo = { at: new V3(), count: 1, speed: [0, 0.08], life: [0.12, 0.18], size: [0.5, 0.35], sizeVar: 0.15, ramp: 'gold', intensity: 1.6, sprite: 'glow', fadeIn: 0.3, essential: true, rival: false };
  const eDraw = { at: new V3(), shape: 'shell', radius: 0.6, count: 1, radial: -2.6, speed: [0, 0.1], life: [0.2, 0.26], size: [0.03, 0.06], ramp: 'gold', intensity: 2.8, sprite: 'spark', stretch: 0.03, fadeIn: 0.25, curve: 1, essential: true, rival: false };
  const fReady = { ramp: 'whiteHold', size: [0.15, 1.1], dur: 0.2, intensity: 4, sprite: 'star', pull: 0.4, rival: false };
  function conjCenter(pl, out) {
    if (hasVec(pl.conjurePoint)) return out.set(pl.conjurePoint.x, pl.conjurePoint.y, pl.conjurePoint.z);
    fx.anchor('handL', _hl, false); fx.anchor('handR', _h, false);
    return out.set((_hl.x + _h.x) * 0.5, (_hl.y + _h.y) * 0.5, (_hl.z + _h.z) * 0.5);
  }
  function conjTick(dt, snap) {
    const pl = snap && snap.player;
    const c = pl && pl.conjure && typeof pl.conjure === 'object' ? pl.conjure : null;
    if (!c || pl.action === 'dead') { conj.on = false; conj.ready = false; conj.accHalo = 0; conj.accSpark = 0; return; }
    const prism = c.kind === 'prism';
    const ch = clamp(num(c.charge, 0), 0, 1), sz = clamp(num(c.size, 0), 0, 1);
    const el = prism ? 'reset' : elOf(false);
    const ramp = rampOf(el, false);
    conjCenter(pl, eHalo.at);
    if (!conj.on) {
      // [W4-ЗАКЛИНАНИЯ] начало сотворения — предвестник в центре (своя сцена: по снимку сцены нет)
      const prev = kit.currentScope;
      kit.scope('');
      hrd(eHalo.at, el, false, 1, null, undefined, true);
      kit.enterScope(prev);
    }
    if (!conj.on || conj.kind !== (prism ? 'prism' : 'orb')) { conj.on = true; conj.kind = prism ? 'prism' : 'orb'; conj.ready = false; }
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
  // сцена броска: запись снаряда появится в снимке (обычно в этом же кадре) — её комета живёт в сцене броска
  const thr = [];
  for (let i = 0; i < 4; i++) thr.push({ id: '', scope: null, t: -1e9 });
  let thrI = 0;
  function rememberThrow(id, s) {
    const e = thr[thrI]; thrI = (thrI + 1) % thr.length;
    e.id = id == null ? '' : String(id); e.scope = s; e.t = kit.clock;
  }
  function takeThrowScope(key) {
    let best = null;
    for (let i = 0; i < thr.length; i++) {
      const e = thr[i];
      if (!e.scope) continue;
      const age = kit.clock - e.t;
      if (e.id && e.id === key && age <= THROW_WIN + 0.25) { best = e; break; }
      if (age <= THROW_WIN && (!best || e.t > best.t)) best = e;
    }
    if (!best) return null;
    const s = best.scope; best.scope = null; best.id = '';
    return s;
  }
  fx.on('player_cast', (ev, d) => {
    const R = fx.isRemote(d);
    const prism = d.kind === 'prism';
    const pw = clamp(num(d.power, 0.6), 0, 1), sz = clamp(num(d.size, 0.5), 0, 1);
    const sf = soft();
    const p = fx.evPos(ev, _p) || (fx.snap && fx.snap.player && hasVec(fx.snap.player.conjurePoint) ? _p.copy(fx.snap.player.conjurePoint) : fx.anchor('chest', _p, R));
    const el = R ? 'rival' : (prism ? 'reset' : elOf(false));
    const ramp = rampOf(el, R);
    if (hasVec(d.velocity)) _d.set(d.velocity.x, d.velocity.y, d.velocity.z); else { fx.target(_q, R); _d.subVectors(_q, p); }
    if (_d.lengthSq() < 1e-6) _d.set(0, 0, -1);
    _d.normalize();
    // [W4-ЗАКЛИНАНИЯ] предвестник броска (крупнее; его белая звезда — ядро броска), ореол, конус искр по полёту
    hrd(p, el, R, 1.2, _d, undefined, true);
    fHalo.ramp = ramp; fHalo.size[0] = 0.35; fHalo.size[1] = (1.2 + 0.8 * sz) * sf; fHalo.dur = 0.26; fHalo.intensity = 1.9; fHalo.sprite = 'glow'; fHalo.pull = 0.45; fHalo.rival = R; fHalo.delay = 0;
    kit.flash(p, fHalo);
    eFan.at = p; eFan.dir = _d; eFan.cone = 0.42; eFan.count = 8 + 12 * pw; eFan.speed[0] = 4; eFan.speed[1] = 9 + 6 * pw; eFan.life[0] = 0.14; eFan.life[1] = 0.32;
    eFan.size[0] = 0.06; eFan.ramp = ramp; eFan.intensity = 3.2; eFan.gravity = 1; eFan.drag = 3.5; eFan.rival = R; eFan.essential = false;
    kit.emit(eFan);
    eFan.dir = null; eFan.at = null;
    if (!R) rememberThrow(d.projectileId, kit.currentScope);
    // свет броска даёт свет полёта (комета снаряда) — здесь не берём второй слот
  }, (d) => d.ability === 'throw');

  // ------------------------------------------------------------ каст «OK»: предвестник в начале потока, дальше — звёздочка
  const boltT = [-1e9, -1e9];   // последний «OK» своего героя / соперника
  fx.on('player_cast', (ev, d) => {
    const R = fx.isRemote(d), i = R ? 1 : 0;
    const first = kit.clock - boltT[i] > BOLT_STREAM;
    boltT[i] = kit.clock;
    if (first) {
      fx.anchor('handR', _h, R);
      hrd(_h, elOf(R), R, 1, aimFrom(_h, R, _hd), undefined, true);
      return;
    }
    // белая звёздочка у ствола (поверх янтаря старого слоя)
    const p = fx.evPos(ev, _p) || fx.anchor('handR', _p, R);
    fCore.ramp = 'whiteHold'; fCore.size[0] = 0.08; fCore.size[1] = 0.42 * soft(); fCore.dur = 0.08; fCore.intensity = 3.6; fCore.sprite = 'star'; fCore.pull = 0.35; fCore.rival = R; fCore.delay = 0;
    kit.flash(p, fCore);
  }, (d) => d.ability === 'bolt');

  // ------------------------------------------------------------ [W4-ЗАКЛИНАНИЯ] «Искра», рассечение — предвестник у руки
  fx.on('player_cast', (ev, d) => {
    const R = fx.isRemote(d);
    fx.anchor('handR', _h, R);
    if (hasVec(d.velocity)) { _hd.set(d.velocity.x, d.velocity.y, d.velocity.z); if (_hd.lengthSq() > 1e-6) _hd.normalize(); else aimFrom(_h, R, _hd); }
    else aimFrom(_h, R, _hd);
    hrd(_h, elOf(R), R, 1, _hd, undefined, true);
  }, (d) => d.ability === 'spark');
  fx.on('player_slash', (ev, d) => {
    const R = fx.isRemote(d);
    fx.anchor('handR', _h, R);
    hrd(_h, elOf(R), R, 1, aimFrom(_h, R, _hd), undefined, true);
  });

  // ------------------------------------------------------------ [W4-ЗАКЛИНАНИЯ] печати — предвестник у обеих ладоней
  const sigT = [-1e9, -1e9];   // кадр последнего предвестника печати (свой / соперник): без двойного за кадр
  function sigilHerald(R) {
    const i = R ? 1 : 0;
    if (sigT[i] === kit.clock) return;
    sigT[i] = kit.clock;
    heraldHands(elOf(R), R, true);
  }
  fx.on('sigil_cast', (ev, d) => { sigilHerald(fx.isRemote(d)); });
  // «Врата» / «Столп»: sigilGate / sigilPillar рисуют событие целиком (return true) и стоят в CHOREO раньше — сюда
  // их sigil_cast не доходит. Свой каст: sigilCharge (первый в CHOREO) в том же обработчике пишет
  // fx.shared.sigil.release = 'gate' | 'pillar' — следим за записью (значение и чтение не меняются).
  (function watchRelease() {
    const S = fx.shared.sigil;
    if (!S || typeof S !== 'object') return;
    const desc = Object.getOwnPropertyDescriptor(S, 'release');
    if (!desc || !desc.configurable || !('value' in desc)) return;
    let v = desc.value;
    try {
      Object.defineProperty(S, 'release', {
        configurable: true, enumerable: true,
        get() { return v; },
        set(x) {
          v = x;
          if (x === 'gate' || x === 'pillar') { try { sigilHerald(false); } catch (e) { /* предвестник не мешает печати */ } }
        },
      });
    } catch (e) { /* без предвестника врат/столпа */ }
  })();

  // ============================================================ ПОЛЁТ своих снарядов: записи по id (пул)
  // r.cls: 1 — сфера/призма (комета, свет), 2 — «OK»-болт (комета вместо старого болта), 3 — «Искра».
  fx.suppress('proj:bolt');   // [W4-ЗАКЛИНАНИЯ] старый болт effects.js (ядро-меш, ореол-спрайт, лента) не рисуется
  const comets = createComet(fx);
  const recs = new Map();
  const pool = [];
  function makeRec() {
    return { id: '', cls: 0, prism: false, pos: new V3(), prev: new V3(), vel: new V3(), rad: 0.3, pw: 0.6, age: 0, tag: 0, accA: 0, accB: 0, comet: null, scope: null };
  }
  for (let i = 0; i < POOL_N; i++) pool.push(makeRec());
  let tag = 0, playing = false, boltLightT = -1e9;
  // опции комет (мутируются перед start)
  const cBolt = { size: 0.45, remote: false, light: false, lightK: 0.8, dur: 0.35, trail: true, trailWidth: 0.5, trailLife: 0.15, scope: null };
  const cOrb = { size: 0.4, remote: false, light: true, lightK: 1, dur: 0.8, trail: true, trailWidth: undefined, trailLife: 0.3, scope: null };
  function sceneScope(key) {
    // сцена без смены текущей (запись рождается в fx.every — вне событий)
    const prev = kit.currentScope;
    const s = kit.scope(key, undefined, false);
    kit.enterScope(prev);
    return s;
  }
  function recGet(key, pr, cls) {
    const r = pool.pop() || makeRec();
    r.id = key; r.cls = cls; r.prism = pr.kind === 'prism'; r.age = 0; r.accA = 0; r.accB = 0; r.comet = null; r.scope = null;
    r.pos.set(pr.position.x, pr.position.y, pr.position.z); r.prev.copy(r.pos);
    if (hasVec(pr.velocity)) r.vel.set(pr.velocity.x, pr.velocity.y, pr.velocity.z); else r.vel.set(0, 0, 0);
    r.rad = clamp(num(pr.radius, 0.3), 0.1, 1);
    r.pw = clamp(num(pr.power, 0.6), 0, 1);
    if (cls === 1) {
      // сфера/призма: комета по радиусу, один мягкий свет за головой (на low → нет; на medium слот уступает вспышкам)
      r.scope = takeThrowScope(key) || sceneScope('');
      cOrb.size = Math.min(0.8, r.rad * 1.3); cOrb.lightK = (0.45 + 0.35 * r.pw) / 0.55; cOrb.scope = r.scope;
      r.comet = comets.start(r.pos, r.prism ? 'reset' : elOf(false), cOrb);
      cOrb.scope = null;
    } else if (cls === 2) {
      // «OK»: сцена потока 'bolt'; свет — первому болту потока, дальше не чаще BOLT_LIGHT
      r.scope = sceneScope('bolt');
      cBolt.light = kit.clock - boltLightT >= BOLT_LIGHT;
      if (cBolt.light) boltLightT = kit.clock;
      cBolt.scope = r.scope;
      r.comet = comets.start(r.pos, elOf(false), cBolt);
      cBolt.scope = null;
    } else r.scope = sceneScope('spark');
    return r;
  }
  function recEnd(r) {
    if (r.comet) { r.comet.end(); r.comet = null; }
    r.cls = 0; r.scope = null;
    if (pool.length < POOL_N * 2) pool.push(r);
  }

  // угасание болта, исчезнувшего без попадания (старый слой больше не рисует своё)
  const fFizz = { ramp: 'gold', size: [0.45, 0.8], dur: 0.18, intensity: 1.6, sprite: 'glow', pull: 0.3, rival: false, delay: 0, fadeIn: 0.04, curve: 0.45 };
  const eFizz = { at: null, count: 6, speed: [0.3, 1.2], life: [0.22, 0.35], size: [0.05, 0.01], ramp: 'gold', intensity: 2.6, sprite: 'spark', drag: 3, gravity: 0.6, rival: false, essential: true };
  // попадания этого кадра (без projectileId запись не найти — угасание рядом с попаданием не рисуем)
  const imp = [new V3(), new V3(), new V3(), new V3()];
  let impN = 0, impT = -1;
  function nearImpact(p) {
    if (impT !== kit.clock) return false;
    for (let i = 0; i < impN; i++) if (imp[i].distanceToSquared(p) < 4) return true;
    return false;
  }
  function fizzle(r) {
    const prev = kit.enterScope(r.scope);
    const ramp = rampOf(elOf(false), false);
    fFizz.ramp = ramp; kit.flash(r.pos, fFizz);
    eFizz.at = r.pos; eFizz.ramp = ramp; kit.emit(eFizz); eFizz.at = null;
    kit.enterScope(prev);
  }
  function sweep(r, key) {
    if (r.tag === tag) return;
    recs.delete(key);
    if (r.cls === 2 && playing && !nearImpact(r.pos)) fizzle(r);
    recEnd(r);
  }

  // «Искра»: ядро и искры-ореол по аккумулятору
  const eBoltCore = { at: null, count: 1, speed: [0, 0.05], life: [0.05, 0.07], size: [0.26, 0.16], sizeVar: 0.1, ramp: 'whiteHold', intensity: 3, sprite: 'glow', fadeIn: 0.05, essential: true, rival: false };
  const eBoltSpark = { at: null, radius: 0.08, count: 1, dir: null, cone: 1.2, speed: [0.4, 1.6], life: [0.12, 0.26], size: [0.045, 0.008], ramp: 'gold', intensity: 3, sprite: 'spark', stretch: 0.02, drag: 2.5, gravity: 1.5, essential: true, rival: false };
  const _back = new V3();

  function flyTick(r, dt) {
    if (r.comet) {
      // комета: голова каждый кадр, слои хвоста болта — реже (dt × BOLT_RATE копит только их аккумуляторы)
      r.comet.step(r.pos, r.vel, r.cls === 2 ? dt * BOLT_RATE : dt);
      return;
    }
    if (r.cls !== 3) return;
    const prev = kit.enterScope(r.scope);
    if (r.scope) kit.touchScope(r.scope, 0.2);
    _back.copy(r.vel); if (_back.lengthSq() > 1e-6) _back.normalize().multiplyScalar(-1); else _back.set(0, 1, 0);
    r.accA += dt * 40;                                   // яркое ядро
    let n = Math.floor(r.accA);
    if (n > 0) {
      r.accA -= n; if (n > 2) n = 2;
      eBoltCore.at = r.pos; eBoltCore.count = n;
      kit.emit(eBoltCore);
    }
    r.accB += dt * 22 * decor();                         // искры-ореол в цвете героя
    n = Math.floor(r.accB);
    if (n > 0) {
      r.accB -= n; if (n > 3) n = 3;
      eBoltSpark.at = r.pos; eBoltSpark.dir = _back; eBoltSpark.count = n; eBoltSpark.ramp = rampOf(elOf(false), false);
      kit.emit(eBoltSpark);
    }
    eBoltCore.at = null; eBoltSpark.at = null; eBoltSpark.dir = null;
    kit.enterScope(prev);
  }

  function projTick(dt, snap) {
    tag++;
    playing = !!(snap && snap.status === 'playing');
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
    // точка попадания этого кадра — для угасания болтов без projectileId
    if (impT !== kit.clock) { impT = kit.clock; impN = 0; }
    if ((p || r) && impN < imp.length) imp[impN++].copy(castHit.pos);
    if (r) {
      if (r.comet) { r.comet.end(castHit.pos); r.comet = null; }   // лента дотягивается до точки удара
      recs.delete(key); recEnd(r);
    }
  }, (d) => d.owner === 'player' && !fx.isRemote(d));

  // ============================================================ РУНЫ (rune_cast): предвестник у руки в стихии руны
  // [W4-ЗАКЛИНАНИЯ] вместо прежних ядра/ореола/веера: вспышка, кольцо и знак руны у руки (0,15 с), искры — к цели
  // (руна на себя — во все стороны). Свет рун — у самих рун; руну в воздухе рисует handMagic.
  fx.on('rune_cast', (ev, d) => {
    const rune = typeof d.rune === 'string' ? d.rune : '';
    const R = fx.isRemote(d);
    const el = R ? 'rival' : (RUNE_EL[rune] || elOf(false));
    fx.anchor('handR', _h, R);
    fx.anchor('chest', _q, R);
    const to = hasVec(d.to) ? d.to : null;
    let dir = _hd;
    if (to && Math.hypot(to.x - _q.x, to.z - _q.z) > 0.8) {
      _hd.set(to.x - _h.x, to.y - _h.y, to.z - _h.z);
      if (_hd.lengthSq() > 1e-6) _hd.normalize(); else dir = null;
    } else if (to) dir = null;                            // руна на себя (лечение, ветер, оберег)
    else aimFrom(_h, R, _hd);
    hrd(_h, el, R, 1, dir, rune || undefined, true);
  });

  // ============================================================ по снимку
  fx.every((dt, snap) => {
    conjTick(dt, snap);
    projTick(dt, snap);
  });

  fx.onClear(() => {
    recs.forEach(recEnd); recs.clear();
    comets.clear();
    conj.on = false; conj.ready = false; conj.accHalo = 0; conj.accSpark = 0;
    castHit.t = -1; castHit.id = ''; castHit.has = false;
    for (let i = 0; i < thr.length; i++) { thr[i].scope = null; thr[i].id = ''; thr[i].t = -1e9; }
    boltT[0] = boltT[1] = -1e9; sigT[0] = sigT[1] = -1e9; boltLightT = -1e9; impN = 0; impT = -1;
  });
  fx.onDispose(() => {
    recs.forEach(recEnd); recs.clear(); pool.length = 0;
    comets.clear();
    for (let i = 0; i < thr.length; i++) thr[i].scope = null;
  });
}
