// ASHEN OATH — modules/fx/hitFx.js. Владелец: №7 [VFX]. [W3-МАГИЯ]
// Сочные попадания: всплеск, искры, трещины-свечение на броне Регента.
// «Добавка» поверх combatFx (камень, тряска, хит-стоп) и старого onBossHit — обработчики НЕ возвращают true.
//  - удар (boss_hit): белое ядро-вспышка в точке удара (подтянута к камере pull — не прячется в меше),
//    ореол стихии, кольцо-волна, веер искр по нормали (навстречу удару), мелкие раскалённые осколки;
//    сила — по amount (≥ 40: свет и лёгкая тряска; хит-стоп не трогаем — его дают gameFeel и combatFx);
//    печати «Врата бури»/«Столп небес» (source 'sigil', gate/pillar) — особенно мощно;
//  - снаряды: projectile_impact и boss_hit приходят в одном кадре → удар рисуется ОДИН раз: на projectile_impact
//    (направление — из записи снаряда castFx.js через fx.shared.castHit), а boss_hit того же кадра (kit.clock)
//    только «доводит» крупный удар по amount; в PvP boss_hit приходит позже по ответу соперника — тоже без повтора;
//  - время удара ≠ время урона: выброс, ignis/fulgur/vee, взмах — boss_hit в кадр каста, визуал позже → удар
//    откладывается до прихода визуала (в PvP — сразу);
//  - «трещины-свечение»: после сильных ударов по Регенту в точках удара несколько секунд тлеют угли и искры
//    (до 4 очагов, затухают), по fx.every без аллокаций. По сопернику (PvP) трещин нет.
// Удар, помеченный remote, — rival-палитрой. Тики горения ('burn'), лук и сгусток ладони (bowHand) — пропускаются.
//
// [W4-УДАР] Сила удара видна (по Регенту, не в PvP):
//  - слабый (< 20: болты, «Искра») — маленькая вспышка и искры, как было; трещины брони чуть теплеют;
//  - средний (20–30) — + вспышка трещин брони в точке удара (world.bossFx.crackAt, мост — fx.shared.bossFx);
//  - сильный (≥ 30) или крит (рассечение по открытому Регенту, заряженный выстрел) — + кольцо ударной волны
//    по земле под Регентом, пылевое кольцо, pulse('punch') (≥ 45 его уже даёт core/cinemaFeed.js — не дублируем),
//    след на земле: подпалина/трещины + «лужа света» стихии (декали с tag 'hit': не больше HIT_DECALS[q],
//    рядом свежая — ярче, а не новая); крит — ещё четырёхлучевой блик и белые искры;
//  - добивающий (hpAfter ≤ 0; урон добивания мал — сила не по amount) — большой: сфера-хлопок, два кольца,
//    сотня искр и осколков, накал трещин на всю броню, кратер и лужа света, punch 0,9. Дальше — сцена гибели
//    bossFinale.js (перегрев, осколки, засветка) — её не трогаем;
//  - заклинания, у которых уже есть своё кольцо и декали у цели (руны, «Врата бури», «Столп небес»,
//    «Небесный суд»), — без второго кольца и следа.
// Жёсткий пул частиц ударов (fx.shared.hitPool, им пользуется и combatFx.js): «ведро» частиц по качеству
// (HIT_POOL), всплеск сверх ведра урезается, а не вытесняет из кольцевого буфера kit другие эффекты.
// На low — урезанно: меньше частиц, без света (kit), без punch (postfx на low его не делает), без бликов.

import { clamp, isNum, hasVec } from './common.js';
import { ELEMENTS } from './glsl.js';

const RUNE_RAMP = {
  ignis: 'fire', fulgur: 'storm', orbis: 'heal', stella: 'star', spira: 'wind',
  lemnis: 'eternal', caret: 'frost', vee: 'void', clepsydra: 'time', alpha: 'reset',
};
const SKIP_SRC = { burn: 1, arrow: 1, hand_orb: 1, chain: 1 };
const N_CRACK = 4;
// [W4-УДАР] пороги силы и бюджеты по качеству
export const HIT_TIER = Object.freeze({ mid: 20, strong: 30, cine: 45 });
export const HIT_POOL = Object.freeze({
  low: Object.freeze({ max: 140, rate: 220, k: 0.6 }),
  medium: Object.freeze({ max: 520, rate: 700, k: 0.85 }),
  high: Object.freeze({ max: 1000, rate: 1300, k: 1 }),
});
export const HIT_DECALS = Object.freeze({ low: 2, medium: 5, high: 8 });
// своё кольцо и декали у цели уже рисует хореография заклинания
const OWN_GROUND = { rune: 1, ultimate: 1, throw: 1 };   // сфера/призма: кольцо и декаль — sigils.js
// рывок экрана уже дан в кадр каста (main.js PUNCH: выброс, руна, печать; «Небесный суд» — свой)
const OWN_PUNCH = { burst: 1, rune: 1, sigil: 1, ultimate: 1 };
const RAMP_HEX = {
  gold: ELEMENTS.gold.hot, whiteHold: 0xfff0d0, fire: ELEMENTS.fire.hot, storm: ELEMENTS.storm.hot, heal: ELEMENTS.heal.hot,
  star: ELEMENTS.star.hot, wind: ELEMENTS.wind.hot, eternal: ELEMENTS.eternal.hot, frost: ELEMENTS.frost.hot,
  void: ELEMENTS.void.hot, time: ELEMENTS.time.hot, reset: ELEMENTS.reset.hot, rival: ELEMENTS.rival.hot,
};
const RAMP_EL = {
  gold: ELEMENTS.gold, whiteHold: ELEMENTS.gold, fire: ELEMENTS.fire, storm: ELEMENTS.storm, heal: ELEMENTS.heal, star: ELEMENTS.star,
  wind: ELEMENTS.wind, eternal: ELEMENTS.eternal, frost: ELEMENTS.frost, void: ELEMENTS.void, time: ELEMENTS.time, reset: ELEMENTS.reset,
};

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const E = fx.E;
  const num = (v, d) => (isNum(v) ? v : d);
  const decor = () => (kit.Q && isNum(kit.Q.decor) ? kit.Q.decor : 0.8);
  const soft = () => { try { return fx.reduced() ? 0.6 : 1; } catch (e) { return 1; } };
  const low = () => !!(kit.Q && kit.Q.name === 'low');
  const qName = () => (kit.Q && HIT_POOL[kit.Q.name] ? kit.Q.name : 'medium');

  // ============================================================ [W4-УДАР] жёсткий пул частиц ударов
  // «Ведро» частиц: доливается rate/с до max; выброс берёт сколько есть (остальное отбрасывается).
  const hitPool = {
    tokens: HIT_POOL.medium.max, spent: 0, cut: 0,
    refill(dt) { const B = HIT_POOL[qName()]; this.tokens = Math.min(B.max, this.tokens + B.rate * dt); },
    /** kit.emit через бюджет: count масштабируется по качеству и остатку ведра. */
    emit(o) {
      if (!o) return 0;
      const B = HIT_POOL[qName()];
      const c0 = num(o.count, 10);
      const want = c0 * B.k * (o.essential ? 1 : decor());
      if (!(want > 0)) return 0;
      const got = Math.min(want, Math.max(0, this.tokens));
      if (got < want) this.cut += want - got;
      if (got < 0.5) return 0;
      this.tokens -= got; this.spent += got;
      o.count = c0 * B.k * (got / want);
      let n = 0;
      try { n = kit.emit(o); } finally { o.count = c0; }
      return n;
    },
    stats() { return { tokens: Math.round(this.tokens), spent: Math.round(this.spent), cut: Math.round(this.cut) }; },
  };
  fx.shared.hitPool = hitPool;
  const emitB = (o) => hitPool.emit(o);

  // мост к визуалу Регента (main.js кладёт world.bossFx в fx.shared.bossFx): трещины брони у точки удара
  function crackArmor(p, heat, ramp, radius) {
    const bf = fx.shared.bossFx;
    if (!bf || typeof bf.crackAt !== 'function') return;
    try { bf.crackAt(p, heat, RAMP_HEX[ramp] || ELEMENTS.gold.hot, radius); } catch (e) { /* ignore */ }
  }
  // импульс экрана postfx (core/postfx.js pulse — модульный, без ссылки на postfx; на low/reducedMotion — сам гасит)
  let pulseFn = null;
  try { import('../../core/postfx.js').then((m) => { if (m && typeof m.pulse === 'function') pulseFn = m.pulse; }).catch(() => {}); } catch (e) { /* нет динамического импорта */ }
  const pulse = (kind, k, pos, o) => { if (!pulseFn) return false; try { return pulseFn(kind, k, pos, o); } catch (e) { return false; } };
  fx.shared.hitPulse = pulse;

  // временные векторы обработчиков (только синхронно внутри одного вызова)
  const _p = new V3(), _n = new V3(), _c = new V3(), _cam = new V3(), _q = new V3();

  // ------------------------------------------------------------ предвыделенные опции
  const fStar = { ramp: 'whiteHold', size: [0.2, 1.0], dur: 0.1, intensity: 4.2, sprite: 'star', pull: 0.7, rival: false, delay: 0, rot: undefined };
  const fGlow = { ramp: 'gold', size: [0.4, 1.4], dur: 0.24, intensity: 2.2, sprite: 'glow', pull: 0.7, rival: false, delay: 0, rot: undefined };
  const fRing = { ramp: 'gold', size: [0.3, 1.8], dur: 0.3, intensity: 1.8, sprite: 'ring', pull: 0.75, rival: false, delay: 0, curve: 0.5 };
  const eSpark = { at: null, dir: null, cone: 0.8, count: 20, speed: [4, 10], life: [0.16, 0.42], size: [0.06, 0.01], ramp: 'gold', intensity: 3.3, sprite: 'spark', stretch: 0.032, gravity: 6, drag: 1.8, ground: -1e4, rival: false, essential: false };
  const eShard = { at: null, dir: null, cone: 1.0, count: 6, speed: [2.5, 6], life: [0.3, 0.7], size: [0.07, 0.03], sizeVar: 0.5, ramp: 'ember', intensity: 2.6, sprite: 'shard', gravity: 9, drag: 0.8, spin: [-12, 12], ground: -1e4, rival: false, essential: false };
  const kLight = { color: 0xfff0d8, intensity: 0.8, range: 9, dur: 0.26, attack: 0.05 };

  // направление разлёта: навстречу удару (−dir полёта), с подъёмом и к камере
  function sprayNormal(out, p, dir) {
    kit.cameraPos(_cam);
    _q.set(_cam.x - p.x, 0, _cam.z - p.z);
    if (_q.lengthSq() > 1e-6) _q.normalize(); else _q.set(0, 0, 1);
    if (dir && dir.lengthSq() > 1e-6) out.copy(dir).multiplyScalar(-1); else out.copy(_q);
    out.y = Math.max(out.y, 0) + 0.45;
    out.addScaledVector(_q, 0.35);
    if (out.lengthSq() < 1e-6) out.set(0, 1, 0);
    return out.normalize();
  }
  function gyAt(p) {
    const b = fx.snap && fx.snap.boss;
    return fx.groundY(p.x, p.z, b && b.position && isNum(b.position.y) ? b.position.y : 0);
  }

  // ============================================================ ТРЕЩИНЫ-СВЕЧЕНИЕ на броне Регента
  // очаг: смещение от позиции Регента (точка на броне), тепло 0..1, своя строка градиента
  const cracks = [];
  for (let i = 0; i < N_CRACK; i++) cracks.push({ ox: 0, oy: 0, oz: 0, heat: 0, fade: 3, ramp: 'ember', acc: 0, accF: 0 });
  let crackNext = 0;
  function addCrack(p, heat, ramp, fade) {
    const b = fx.snap && fx.snap.boss;
    if (!b || !hasVec(b.position)) return;
    let ox = p.x - b.position.x, oy = p.y - b.position.y, oz = p.z - b.position.z;
    // точка в центре (удар по bossAim) → вынести на броню, к камере со случайным сдвигом по окружности
    const hr = Math.sqrt(ox * ox + oz * oz);
    if (hr < 1.0) {
      kit.cameraPos(_cam);
      let a = Math.atan2(_cam.z - b.position.z, _cam.x - b.position.x) + (Math.random() - 0.5) * 1.6;
      if (!isNum(a)) a = 0;
      ox = Math.cos(a) * 1.25; oz = Math.sin(a) * 1.25; oy = clamp(oy + (Math.random() - 0.5) * 1.2, 0.8, 4.2);
    } else { ox *= 1.25 / hr; oz *= 1.25 / hr; oy = clamp(oy, 0.5, 4.6); }   // чуть внутрь — угли из-под брони
    // похожий очаг рядом — подогреть его, иначе занять самый холодный/старый
    let slot = null;
    for (let i = 0; i < N_CRACK; i++) {
      const c = cracks[i];
      if (c.heat > 0.05) { const dx = c.ox - ox, dy = c.oy - oy, dz = c.oz - oz; if (dx * dx + dy * dy + dz * dz < 0.5) { slot = c; break; } }
    }
    if (!slot) {
      slot = cracks[crackNext]; let best = slot.heat;
      for (let i = 0; i < N_CRACK; i++) if (cracks[i].heat < best) { best = cracks[i].heat; slot = cracks[i]; }
      crackNext = (crackNext + 1) % N_CRACK;
      slot.ox = ox; slot.oy = oy; slot.oz = oz; slot.acc = 0; slot.accF = 0;
    }
    slot.heat = Math.min(1, Math.max(slot.heat, 0) + heat);
    slot.fade = fade; slot.ramp = ramp;
  }
  const eEmber = { at: new V3(), radius: 0.22, count: 1, dir: { x: 0, y: 1, z: 0 }, cone: 0.7, speed: [0.3, 1.1], life: [0.5, 1.1], size: [0.06, 0.01], ramp: 'ember', intensity: 2.6, sprite: 'ember', turb: 0.5, gravity: -0.5, drag: 1, essential: true, rival: false };
  const eCrackSpark = { at: null, radius: 0.15, count: 1, cone: Math.PI, speed: [0.8, 2.4], life: [0.12, 0.3], size: [0.04, 0.008], ramp: 'fire', intensity: 3, sprite: 'spark', stretch: 0.02, gravity: 4, drag: 1.5, essential: true, rival: false };
  const fPulse = { ramp: 'ember', size: [0.3, 0.6], dur: 0.18, intensity: 1.6, sprite: 'glow', pull: 0.5, rival: false, fadeIn: 0.4, curve: 1 };
  function crackTick(dt, snap) {
    const b = snap && snap.boss;
    const ok = b && hasVec(b.position) && !(snap.mode === 'pvp') && b.action !== 'dead';
    for (let i = 0; i < N_CRACK; i++) {
      const c = cracks[i];
      if (c.heat <= 0) continue;
      if (!ok) { c.heat = 0; continue; }
      if (!(dt > 0)) continue;
      c.heat -= dt / c.fade;
      if (c.heat <= 0) { c.heat = 0; continue; }
      const h = c.heat * c.heat;                      // затухает быстрее к концу
      eEmber.at.set(b.position.x + c.ox, b.position.y + c.oy, b.position.z + c.oz);
      c.acc += dt * (4 + 26 * h) * decor();
      let n = Math.floor(c.acc);
      if (n > 0) {
        c.acc -= n; if (n > 3) n = 3;
        eEmber.count = n; eEmber.ramp = c.ramp; eEmber.intensity = 1.8 + 1.2 * h;
        kit.emit(eEmber);
        if (h > 0.25 && Math.random() < 0.35) { eCrackSpark.at = eEmber.at; eCrackSpark.count = 1; eCrackSpark.ramp = c.ramp === 'gold' ? 'gold' : 'fire'; kit.emit(eCrackSpark); }
      }
      // редкое тлеющее «дыхание» трещины (не на low)
      c.accF += dt * 2.2;
      if (c.accF >= 1) {
        c.accF -= 1;
        if (!low() && h > 0.08) { fPulse.ramp = c.ramp; fPulse.size[0] = 0.25 + 0.2 * h; fPulse.size[1] = 0.5 + 0.6 * h; fPulse.intensity = 0.8 + 1.2 * h; kit.flash(eEmber.at, fPulse); }
      }
    }
  }

  // ============================================================ УДАР
  // s 0..1 (сила), ramp, R (rival), mul (множитель слоя), sigil ('gate'|'pillar'|''), onBoss (по Регенту — трещины)
  function juicy(p, dir, s, ramp, R, mul, sigil, onBoss) {
    const sf = soft();
    const m = mul;
    const gy = gyAt(p);
    sprayNormal(_n, p, dir);
    // белое ядро-вспышка
    fStar.ramp = 'whiteHold'; fStar.size[0] = 0.15 + 0.15 * s; fStar.size[1] = (0.6 + 1.3 * s) * m * sf; fStar.dur = 0.08 + 0.06 * s; fStar.intensity = 4.4; fStar.sprite = 'star'; fStar.pull = 0.75; fStar.rival = R; fStar.delay = 0;
    kit.flash(p, fStar);
    // ореол стихии
    fGlow.ramp = ramp; fGlow.size[0] = 0.3; fGlow.size[1] = (0.9 + 1.6 * s) * m * sf; fGlow.dur = 0.18 + 0.14 * s; fGlow.intensity = 2.1; fGlow.pull = 0.7; fGlow.rival = R; fGlow.delay = 0;
    kit.flash(p, fGlow);
    // кольцо-волна (билборд)
    if (s > 0.05 || m > 1) {
      fRing.ramp = ramp; fRing.size[0] = 0.25; fRing.size[1] = (1.1 + 2.4 * s) * m * sf; fRing.dur = 0.22 + 0.16 * s; fRing.intensity = 1.6 + 0.6 * s; fRing.pull = 0.75; fRing.rival = R; fRing.delay = 0.02;
      kit.flash(p, fRing);
    }
    // веер искр по нормали (белые + стихии)
    eSpark.at = p; eSpark.dir = _n; eSpark.cone = 0.85; eSpark.count = (8 + 34 * s) * m; eSpark.speed[0] = 4; eSpark.speed[1] = 8 + 8 * s;
    eSpark.life[0] = 0.16; eSpark.life[1] = 0.36 + 0.14 * s; eSpark.size[0] = 0.055 + 0.02 * s; eSpark.ramp = ramp; eSpark.intensity = 3.4; eSpark.gravity = 6; eSpark.ground = gy + 0.02; eSpark.rival = R;
    emitB(eSpark);
    eSpark.cone = 0.5; eSpark.count = (4 + 12 * s) * m; eSpark.speed[0] = 7; eSpark.speed[1] = 12 + 8 * s; eSpark.ramp = R ? 'rival' : 'white'; eSpark.size[0] = 0.045;
    emitB(eSpark);
    // мелкие раскалённые осколки
    if (s > 0.15 || m > 1) {
      eShard.at = p; eShard.dir = _n; eShard.count = (2 + 8 * s) * m; eShard.speed[1] = 4.5 + 3 * s; eShard.ramp = R ? 'rival' : (ramp === 'storm' || ramp === 'reset' ? 'storm' : 'ember'); eShard.ground = gy + 0.03; eShard.rival = R;
      emitB(eShard);
    }
    // печати: свою вспышку, кольцо и свет удара рисуют sigilGate/sigilPillar (по таймеру) — здесь только
    // осколки, искры и трещины, иначе удар засвечивается в белое
    if (sigil === 'gate' || sigil === 'pillar') {
      const pil = sigil === 'pillar';
      if (pil) {
        // вертикальный штрих света сквозь точку удара
        fGlow.ramp = 'gold'; fGlow.sprite = 'streak'; fGlow.size[0] = 1.2; fGlow.size[1] = 3.4 * sf; fGlow.dur = 0.32; fGlow.intensity = 1.6; fGlow.delay = 0;
        fGlow.rot = Math.PI / 2;
        kit.flash(p, fGlow);
        fGlow.sprite = 'glow'; fGlow.rot = undefined;
      } else {
        eSpark.dir = _n; eSpark.cone = 1.1; eSpark.count = 30; eSpark.speed[0] = 6; eSpark.speed[1] = 16; eSpark.ramp = R ? 'rival' : 'storm'; eSpark.size[0] = 0.07; eSpark.life[1] = 0.5;
        emitB(eSpark);
      }
      eShard.dir = _n; eShard.count = 14; eShard.speed[1] = 9; eShard.ramp = R ? 'rival' : (pil ? 'gold' : 'fire');
      emitB(eShard);
    }
    eSpark.dir = null; eShard.dir = null;
    if (onBoss && (s >= 0.45 || sigil === 'gate' || sigil === 'pillar')) {
      addCrack(p, sigil ? 1 : 0.35 + 0.6 * s, R ? 'rival' : (sigil === 'pillar' ? 'gold' : 'ember'), sigil ? 4.5 : 2.6 + 1.6 * s);
    }
  }
  // крупный удар (≥ 40): свет и лёгкая тряска
  function heavy(p, amount, R, sigil) {
    const s = clamp((amount - 40) / 80, 0, 1);
    kLight.color = R ? E.rival.hot : (sigil === 'pillar' ? 0xffe6b0 : sigil === 'gate' ? 0xffc890 : 0xfff0d8);
    kLight.intensity = 0.7 + 0.6 * s + (sigil ? 0.3 : 0); kLight.range = 9 + 4 * s; kLight.dur = 0.24 + 0.14 * s;
    kit.light(p, kLight);
    kit.shake((sigil ? 0.07 : 0.03) + 0.04 * s);
  }
  const strength = (amount) => clamp((amount - 6) / 74, 0, 1);    // 6 (болт) → 0, 80+ → 1

  // ============================================================ [W4-УДАР] сила удара: кольцо, punch, след, крит, добивание
  const _g = new V3(), _h = new V3();
  const ringO = { pos: _g, normal: undefined, r0: 0.3, r1: 3, dur: 0.45, color: 0, hot: 0, intensity: 1.8, thickness: 0.18, dustAmount: 1.2, distort: 0.7, wall: undefined, rival: 0 };
  const sphO = { pos: _h, r0: 0.3, r1: 3, dur: 0.4, color: 0, hot: 0, intensity: 1.2, distort: 0.8, rival: 0 };
  // второе (отложенное) кольцо добивания — свой объект: общий ringO/_g за 80 мс может занять другой удар
  const ringFin = { pos: new V3(), r0: 0.2, r1: 5, dur: 0.5, color: 0, hot: 0, intensity: 1.1, thickness: 0.24, dustAmount: 2, distort: 0.7, wall: undefined, rival: 0 };
  const ringFinGo = () => { if (fx.shock) { try { fx.shock.ring(ringFin); } catch (e) { /* ignore */ } } };
  const decO = { pos: _g, radius: 1, kind: 'scorch', life: 6, color: 0, hot: 0, intensity: 1.4, rival: 0, tag: 'hit', cap: 4, merge: 0.6, rot: undefined };
  const eDust = { at: _g, shape: 'ring', radius: 0.4, normal: undefined, dir: { x: 0, y: 1, z: 0 }, cone: 0.5, radial: 3.2, count: 10, speed: [0.2, 0.7], life: [0.7, 1.2], size: [0.35, 1.0], ramp: 'dust', blend: 'alpha', alpha: 0.7, intensity: 1, sprite: 'smoke', drag: 2.4, gravity: -0.1, turb: 0.3, spin: [-0.6, 0.6], essential: false, rival: false };
  const eRubble = { at: _g, shape: 'disk', radius: 0.6, dir: { x: 0, y: 1, z: 0 }, cone: 0.6, count: 8, speed: [2, 4.5], life: [0.5, 0.9], size: [0.07, 0.05], sizeVar: 0.5, ramp: 'stone', blend: 'alpha', intensity: 1.0, sprite: 'debris', gravity: 9.8, drag: 0.5, spin: [-9, 9], ground: 0, essential: false, rival: false };
  const fGlint = { ramp: 'whiteHold', size: [0.1, 2.6], dur: 0.16, intensity: 4.4, sprite: 'streak', pull: 0.8, rival: false, delay: 0, rot: 0, curve: 0.35 };
  const eFin = { at: null, count: 90, speed: [5, 16], life: [0.4, 1.1], size: [0.08, 0.015], ramp: 'gold', intensity: 3.4, sprite: 'spark', stretch: 0.04, gravity: 6, drag: 1.2, ground: 0, essential: true, rival: false };
  const eFinEmb = { at: null, radius: 1.2, count: 40, dir: { x: 0, y: 1, z: 0 }, cone: 0.9, speed: [0.4, 1.8], life: [1.2, 2.4], size: [0.06, 0.01], ramp: 'ember', intensity: 2.6, sprite: 'ember', turb: 0.6, gravity: -0.4, drag: 0.8, delay: 0.25, essential: false, rival: false };
  const kFin = { color: 0xffe6b8, intensity: 1.0, range: 16, dur: 0.8, attack: 0.03 };
  let ringT = -1;   // кольцо по земле — не чаще раза в 0,3 с (очереди, тики «Дельты»)
  // точка на земле у Регента со стороны удара: из центра (bossAim) — к герою на 1,2 м
  function groundSpot(out, p, dir) {
    const b = fx.snap && fx.snap.boss;
    const bx = b && hasVec(b.position) ? b.position.x : p.x, bz = b && hasVec(b.position) ? b.position.z : p.z;
    let ox = p.x - bx, oz = p.z - bz;
    const hr = Math.sqrt(ox * ox + oz * oz);
    if (hr < 0.8) {
      // назад по направлению удара (к атакующему); нет направления — к камере
      if (dir && (dir.x * dir.x + dir.z * dir.z) > 1e-4) { const l = Math.sqrt(dir.x * dir.x + dir.z * dir.z); ox = -dir.x / l; oz = -dir.z / l; }
      else { kit.cameraPos(_cam); ox = _cam.x - bx; oz = _cam.z - bz; const l = Math.sqrt(ox * ox + oz * oz) || 1; ox /= l; oz /= l; }
      ox *= 1.2; oz *= 1.2;
    } else { ox *= 1.6 / hr; oz *= 1.6 / hr; }
    out.set(bx + ox, 0, bz + oz);
    out.y = fx.groundY(out.x, out.z, b && b.position && isNum(b.position.y) ? b.position.y : 0) + 0.04;
    return out;
  }
  function palOf(ramp, R) { return R ? ELEMENTS.rival : (RAMP_EL[ramp] || ELEMENTS.gold); }
  // tier: 0 — слабый, 1 — средний, 2 — сильный/крит; crit, fin — флаги; src — источник урона
  function impact(p, dir, amount, ramp, R, src, sigil, crit, fin, onBoss, ground) {
    if (!onBoss) return;   // PvP (удар по сопернику) — как было
    const P = palOf(ramp, R), rv = R ? 1 : 0;
    const lo = low(), sf = soft();
    const strong = fin || crit || amount >= HIT_TIER.strong;
    const tier = fin ? 3 : strong ? 2 : amount >= HIT_TIER.mid ? 1 : 0;
    // 1) трещины брони у точки удара
    const heat = fin ? 3 : crit ? 1.5 : tier === 2 ? 0.8 + 0.6 * clamp((amount - 30) / 70, 0, 1) : tier === 1 ? 0.6 : 0.3;
    crackArmor(p, heat, ramp, fin ? 2.2 : crit ? 1.15 : tier === 2 ? 1.0 : tier === 1 ? 0.8 : 0.6);
    if (tier < 2) return;
    const own = ground === false || OWN_GROUND[src] === 1 || sigil === 'gate' || sigil === 'pillar';
    // 2) крит: четырёхлучевой блик и белые искры
    if (crit && !lo) {
      fGlint.rival = R; fGlint.ramp = R ? 'rival' : 'whiteHold';
      fGlint.size[1] = 2.6 * sf; fGlint.rot = 0.12; kit.flash(p, fGlint);
      fGlint.size[1] = 1.7 * sf; fGlint.rot = 0.12 + Math.PI / 2; kit.flash(p, fGlint);
      fRing.ramp = R ? 'rival' : 'white'; fRing.size[0] = 0.2; fRing.size[1] = 2.2 * sf; fRing.dur = 0.22; fRing.intensity = 2.4; fRing.pull = 0.8; fRing.rival = R; fRing.delay = 0;
      kit.flash(p, fRing);
    }
    // 3) экранный рывок: 30–45 и крит — наш; ≥ 45 его уже дал cinemaFeed (в момент урона), выбросу, руне и печати —
    //    main.js в кадр каста (второй, слабее и позже, читался бы как «двойной» удар)
    if (fin) pulse('punch', 0.9, p);
    else if (OWN_PUNCH[src] !== 1 && amount < HIT_TIER.cine) pulse('punch', clamp(0.22 + (amount - 30) / 60 + (crit ? 0.2 : 0), 0.2, 0.6), p);
    if (own && !fin) return;
    // 4) кольцо ударной волны и пыль по земле под Регентом
    groundSpot(_g, p, dir);
    const k = fin ? 1 : clamp((amount - 30) / 90, 0, 1);
    if (fin || kit.clock - ringT > 0.3) {
      ringT = kit.clock;
      if (fx.shock) {
        ringO.r0 = 0.3; ringO.r1 = (fin ? 9 : 2.4 + 2.6 * k + (crit ? 0.8 : 0)) * sf; ringO.dur = fin ? 0.7 : 0.38 + 0.14 * k;
        ringO.color = P.mid; ringO.hot = fin ? P.hot : P.core; ringO.intensity = fin ? 1.3 : 1.4 + 0.5 * k; ringO.thickness = fin ? 0.3 : 0.16;
        ringO.dustAmount = fin ? 2 : 1 + 0.6 * k; ringO.distort = lo ? 0 : 0.7; ringO.wall = lo ? 0 : undefined; ringO.rival = rv;
        try { fx.shock.ring(ringO); } catch (e) { /* ignore */ }
        if (fin) {
          ringFin.pos.copy(_g); ringFin.r1 = 5 * sf; ringFin.color = ringO.color; ringFin.hot = ringO.hot; ringFin.distort = ringO.distort; ringFin.wall = ringO.wall; ringFin.rival = rv;
          kit.after(0.08, ringFinGo);
          if (!lo) { _h.copy(p); sphO.r1 = 4.2 * sf; sphO.intensity = 0.8; sphO.color = P.hot; sphO.hot = P.core; sphO.rival = rv; try { fx.shock.sphere(sphO); } catch (e) { /* ignore */ } }
        }
      }
      eDust.radius = fin ? 1.2 : 0.5; eDust.radial = (fin ? 6 : 2.6 + 2 * k); eDust.count = fin ? 26 : 8 + 8 * k; eDust.size[1] = fin ? 1.6 : 0.9 + 0.5 * k;
      emitB(eDust);
      eRubble.count = fin ? 22 : 5 + 6 * k; eRubble.speed[1] = fin ? 7 : 4 + 2 * k; eRubble.ground = _g.y; eRubble.radius = fin ? 1.2 : 0.6;
      emitB(eRubble);
    }
    // 5) след на земле: подпалина (тяжёлые — трещины) и «лужа света» стихии; группа 'hit' ограничена и сливается
    if (fx.decals) {
      const q = qName(), cap = HIT_DECALS[q];
      decO.cap = cap; decO.rival = rv; decO.color = P.mid; decO.hot = P.core; decO.rot = undefined;
      // добивание — широкие светящиеся трещины (у «кратера» раскалённый центр слепит в bloom и мокром полу)
      decO.kind = fin || amount >= HIT_TIER.cine || crit ? 'crack' : 'scorch';
      decO.radius = fin ? 3.0 : 0.9 + 0.8 * k; decO.life = fin ? 10 : 5 + 2 * k; decO.intensity = fin ? 1.2 : 1.0 + 0.4 * k; decO.merge = 0.6;
      try { fx.decals.spawn(decO); } catch (e) { /* ignore */ }
      if (!lo || fin) {
        decO.kind = 'pool'; decO.radius = fin ? 3.2 : 1.2 + 0.9 * k; decO.life = fin ? 6 : 2.6 + 1.2 * k; decO.intensity = fin ? 0.8 : 0.7 + 0.35 * k; decO.merge = 0.8;
        decO.color = P.mid; decO.hot = P.hot;
        try { fx.decals.spawn(decO); } catch (e) { /* ignore */ }
      }
    }
    // 6) добивающий: сотня искр, раскалённые осколки, угли, большой свет
    if (fin) {
      eFin.at = p; eFin.ramp = R ? 'rival' : ramp === 'whiteHold' ? 'gold' : ramp; eFin.ground = _g.y; eFin.rival = R;
      eFin.count = 90; emitB(eFin);
      eFin.count = 24; eFin.ramp = R ? 'rival' : 'white'; emitB(eFin);
      eShard.at = p; eShard.dir = null; eShard.cone = Math.PI; eShard.count = 26; eShard.speed[0] = 3; eShard.speed[1] = 9; eShard.ramp = R ? 'rival' : 'ember'; eShard.ground = _g.y; eShard.rival = R;
      emitB(eShard); eShard.cone = 1.0; eShard.speed[0] = 2.5;
      eFinEmb.at = p; eFinEmb.rival = R; emitB(eFinEmb);
      fStar.ramp = 'whiteHold'; fStar.size[0] = 0.4; fStar.size[1] = 2.4 * sf; fStar.dur = 0.16; fStar.intensity = 3.6; fStar.sprite = 'star'; fStar.pull = 0.9; fStar.rival = R; fStar.delay = 0;
      kit.flash(p, fStar);
      fGlow.ramp = R ? 'rival' : ramp; fGlow.size[0] = 0.8; fGlow.size[1] = 4 * sf; fGlow.dur = 0.45; fGlow.intensity = 1.6; fGlow.pull = 0.9; fGlow.rival = R; fGlow.delay = 0;
      kit.flash(p, fGlow);
      kFin.color = R ? ELEMENTS.rival.hot : 0xffe6b8; kit.light(p, kFin);
      kit.shake(0.25); kit.hitstop(90);
    }
  }

  // ------------------------------------------------------------ projectile_impact своих снарядов: рисуем здесь
  const last = { t: -1, id: '', drawn: false, big: false, skip: false, kind: '', ramp: 'gold', dir: new V3() };
  const _dir = new V3();
  fx.on('projectile_impact', (ev, d) => {
    const key = d.projectileId == null ? '' : (typeof d.projectileId === 'string' ? d.projectileId : String(d.projectileId));
    last.t = kit.clock; last.id = key; last.drawn = false; last.big = false; last.kind = typeof d.kind === 'string' ? d.kind : '';
    // иглы «Акус» (runesWild), отражённые сферы — свой рисунок у них; boss_hit этого кадра тоже не дублируем
    last.skip = key.startsWith('caret:') || d.kind === 'orb';
    if (last.skip) return;
    const p = fx.evPos(ev, _p);
    if (!p) return;
    const ch = fx.shared.castHit;
    if (ch && ch.t === kit.clock && ch.id === key) _dir.copy(ch.dir);
    else if (hasVec(d.direction)) _dir.set(d.direction.x, d.direction.y, d.direction.z);
    else { fx.anchor('chest', _c, false); _dir.subVectors(p, _c); }
    if (_dir.lengthSq() > 1e-6) _dir.normalize(); else _dir.set(0, 0, -1);
    const kind = d.kind;
    const throwK = kind === 'sphere' || kind === 'prism';
    const amount = throwK ? num(d.damage, 25 + 85 * clamp(num(d.power, 0.6), 0, 1) * 0.8) : kind === 'spark' ? 14 : 8;
    const ramp = throwK ? (kind === 'prism' ? 'reset' : 'gold') : kind === 'spark' ? 'storm' : 'gold';
    const onBoss = d.result === 'boss' && !(fx.snap && fx.snap.mode === 'pvp');
    // «Искра» уже даёт сочный удар в sigils.js — слой мягче
    juicy(p, _dir, strength(amount), ramp, false, kind === 'spark' ? 0.6 : throwK ? 1.15 : 1, '', onBoss);
    if (amount >= 40) { heavy(p, amount, false, ''); last.big = true; }
    last.drawn = true; last.ramp = ramp; last.dir.copy(_dir);   // [W4-УДАР] сила удара — на boss_hit этого кадра (точный урон)
  }, (d) => d.owner === 'player' && !fx.isRemote(d) && (d.result === 'boss' || d.result === 'opponent'));

  // ------------------------------------------------------------ rune_cast: какая руна била в этом кадре (для boss_hit без d.rune)
  const lastRune = { t: -1, rune: '', dist: 8 };
  fx.on('rune_cast', (ev, d) => {
    lastRune.t = kit.clock; lastRune.rune = typeof d.rune === 'string' ? d.rune : '';
    fx.anchor('chest', _c, false); fx.target(_q, false);
    lastRune.dist = _c.distanceTo(_q);
  }, (d) => !fx.isRemote(d));

  // ------------------------------------------------------------ boss_hit
  function deferHit(delay, p, dir, s, ramp, R, mul, sigil, onBoss, amount, src, crit, fin) {
    const P = new V3().copy(p), D = dir ? new V3().copy(dir) : null;   // событие — аллокация допустима
    kit.after(delay, () => {
      juicy(P, D, s, ramp, R, mul, sigil, onBoss);
      if (amount >= 40 && !sigil) heavy(P, amount, R, sigil);
      impact(P, D, amount, ramp, R, src, sigil, crit, fin, onBoss, true);
    });
  }
  fx.on('boss_hit', (ev, d) => {
    const src = typeof d.source === 'string' ? d.source : '';
    if (d.dot || src === 'burn') return;
    const R = fx.isRemote(d);
    const amount = num(d.amount, 12);
    const pvp = !!d.pvp || d.target === 'opponent' || !!(fx.snap && fx.snap.mode === 'pvp');
    const onBoss = !pvp && !R;
    // [W4-УДАР] добивание (урон добивающего обрезан остатком HP — сила не по amount) и крит
    const fin = onBoss && isNum(d.hpAfter) && d.hpAfter <= 0;
    const crit = !!(d.recoverBonus || d.charged);
    // лук, сгусток ладони, цепь: удар рисует bowHand — здесь только трещины брони, рывок экрана и добивание
    if (SKIP_SRC[src] === 1) {
      if (!onBoss) return;
      const p = fx.evPos(ev, _p) || fx.target(_p, R);
      fx.anchor('chest', _c, R);
      _dir.subVectors(p, _c); if (_dir.lengthSq() > 1e-6) _dir.normalize(); else _dir.set(0, 0, -1);
      impact(p, _dir, src === 'chain' ? Math.min(amount, HIT_TIER.mid - 1) : amount, R ? 'rival' : 'gold', R, src, '', crit, fin, onBoss, false);
      return;
    }
    // снаряды: удар уже нарисован на projectile_impact этого кадра — только «доводим» крупный
    if (src === 'bolt' || src === 'throw') {
      if (last.t === kit.clock && (last.drawn || last.skip)) {
        const p = fx.evPos(ev, _p);
        if (last.drawn && amount >= 40 && !last.big) { if (p) heavy(p, amount, R, ''); }
        // отражённая сфера (свой рисунок у неё) — как крит, но без следа на земле; иглы «Акус» — без кольца
        if (p) impact(p, last.drawn ? last.dir : null, amount, last.drawn ? last.ramp : 'gold', R, src, '', crit || last.kind === 'orb', fin, onBoss, last.drawn);
        return;
      }
      if (pvp && !R) return;                        // PvP: ack приходит позже, удар рисовал projectile_impact
    }
    const p = fx.evPos(ev, _p) || fx.target(_p, R);
    const sigil = src === 'sigil' && (d.sigil === 'gate' || d.sigil === 'pillar') ? d.sigil : '';
    const s = fin ? Math.max(0.55, strength(amount)) : strength(amount);   // добивание: базовый слой средний, главное — impact()
    // направление: от героя (или соперника) к точке
    fx.anchor('chest', _c, R);
    _dir.subVectors(p, _c); if (_dir.lengthSq() > 1e-6) _dir.normalize(); else _dir.set(0, 0, -1);
    let ramp = R ? 'rival' : 'gold', mul = 1, delay = 0;
    if (src === 'burst') { mul = 1.2; delay = 0.15; }
    else if (src === 'slash') { ramp = R ? 'rival' : 'whiteHold'; delay = 0.07; }
    else if (src === 'rune') {
      const rune = typeof d.rune === 'string' ? d.rune : (lastRune.t === kit.clock ? lastRune.rune : '');
      if (!R) ramp = RUNE_RAMP[rune] || 'gold';
      if (rune === 'ignis') delay = 0.18 + Math.min(0.3, 0.1 + lastRune.dist / 26);
      else if (rune === 'fulgur') delay = 0.1;
      else if (rune === 'vee') delay = 0.31;
      mul = rune === 'stella' ? 0.8 : 1.05;
    } else if (src === 'sigil') {
      if (sigil === 'gate') { ramp = R ? 'rival' : 'fire'; mul = 0.8; }
      else if (sigil === 'pillar') { ramp = R ? 'rival' : 'gold'; mul = 0.8; }
      else if (d.sigil === 'delta') ramp = R ? 'rival' : 'void';
      else ramp = R ? 'rival' : 'storm';
    }
    if (pvp) delay = 0;
    if (delay > 0) { deferHit(delay, p, _dir, s, ramp, R, mul, sigil, onBoss, amount, src, crit, fin); return; }
    juicy(p, _dir, s, ramp, R, mul, sigil, onBoss);
    if (amount >= 40 && !sigil) heavy(p, amount, R, sigil);
    impact(p, _dir, amount, ramp, R, src, sigil, crit, fin, onBoss, true);
  });

  fx.every((dt, snap) => { crackTick(dt, snap); if (dt > 0) hitPool.refill(dt); });

  fx.onClear(() => {
    for (let i = 0; i < N_CRACK; i++) { cracks[i].heat = 0; cracks[i].acc = 0; cracks[i].accF = 0; }
    last.t = -1; last.drawn = false; last.skip = false; lastRune.t = -1;
    ringT = -1; hitPool.tokens = HIT_POOL[qName()].max;
  });
}
