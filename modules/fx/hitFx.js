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

import { clamp, isNum, hasVec } from './common.js';

const RUNE_RAMP = {
  ignis: 'fire', fulgur: 'storm', orbis: 'heal', stella: 'star', spira: 'wind',
  lemnis: 'eternal', caret: 'frost', vee: 'void', clepsydra: 'time', alpha: 'reset',
};
const SKIP_SRC = { burn: 1, arrow: 1, hand_orb: 1, chain: 1 };
const N_CRACK = 4;

export function register(fx) {
  const V3 = fx.THREE.Vector3;
  const kit = fx.kit;
  const E = fx.E;
  const num = (v, d) => (isNum(v) ? v : d);
  const decor = () => (kit.Q && isNum(kit.Q.decor) ? kit.Q.decor : 0.8);
  const soft = () => { try { return fx.reduced() ? 0.6 : 1; } catch (e) { return 1; } };
  const low = () => !!(kit.Q && kit.Q.name === 'low');

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
    kit.emit(eSpark);
    eSpark.cone = 0.5; eSpark.count = (4 + 12 * s) * m; eSpark.speed[0] = 7; eSpark.speed[1] = 12 + 8 * s; eSpark.ramp = R ? 'rival' : 'white'; eSpark.size[0] = 0.045;
    kit.emit(eSpark);
    // мелкие раскалённые осколки
    if (s > 0.15 || m > 1) {
      eShard.at = p; eShard.dir = _n; eShard.count = (2 + 8 * s) * m; eShard.speed[1] = 4.5 + 3 * s; eShard.ramp = R ? 'rival' : (ramp === 'storm' || ramp === 'reset' ? 'storm' : 'ember'); eShard.ground = gy + 0.03; eShard.rival = R;
      kit.emit(eShard);
    }
    // печати: особенно мощно
    if (sigil === 'gate' || sigil === 'pillar') {
      const pil = sigil === 'pillar';
      fStar.ramp = 'whiteHold'; fStar.size[0] = 0.5; fStar.size[1] = 3.2 * sf; fStar.dur = 0.2; fStar.intensity = 4.6; fStar.pull = 0.9; fStar.delay = 0.03;
      kit.flash(p, fStar);
      fRing.ramp = pil ? 'gold' : 'fire'; fRing.size[0] = 0.4; fRing.size[1] = 4.2 * sf; fRing.dur = 0.45; fRing.intensity = 2.2; fRing.delay = 0.08;
      kit.flash(p, fRing);
      if (pil) {
        // вертикальный штрих света сквозь точку удара
        fGlow.ramp = 'gold'; fGlow.sprite = 'streak'; fGlow.size[0] = 1.2; fGlow.size[1] = 3.4 * sf; fGlow.dur = 0.32; fGlow.intensity = 1.6; fGlow.delay = 0;
        fGlow.rot = Math.PI / 2;
        kit.flash(p, fGlow);
        fGlow.sprite = 'glow'; fGlow.rot = undefined;
      } else {
        eSpark.dir = _n; eSpark.cone = 1.1; eSpark.count = 30; eSpark.speed[0] = 6; eSpark.speed[1] = 16; eSpark.ramp = R ? 'rival' : 'storm'; eSpark.size[0] = 0.07; eSpark.life[1] = 0.5;
        kit.emit(eSpark);
      }
      eShard.dir = _n; eShard.count = 14; eShard.speed[1] = 9; eShard.ramp = R ? 'rival' : (pil ? 'gold' : 'fire');
      kit.emit(eShard);
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

  // ------------------------------------------------------------ projectile_impact своих снарядов: рисуем здесь
  const last = { t: -1, id: '', drawn: false, big: false, skip: false };
  const _dir = new V3();
  fx.on('projectile_impact', (ev, d) => {
    const key = d.projectileId == null ? '' : (typeof d.projectileId === 'string' ? d.projectileId : String(d.projectileId));
    last.t = kit.clock; last.id = key; last.drawn = false; last.big = false;
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
    last.drawn = true;
  }, (d) => d.owner === 'player' && !fx.isRemote(d) && (d.result === 'boss' || d.result === 'opponent'));

  // ------------------------------------------------------------ rune_cast: какая руна била в этом кадре (для boss_hit без d.rune)
  const lastRune = { t: -1, rune: '', dist: 8 };
  fx.on('rune_cast', (ev, d) => {
    lastRune.t = kit.clock; lastRune.rune = typeof d.rune === 'string' ? d.rune : '';
    fx.anchor('chest', _c, false); fx.target(_q, false);
    lastRune.dist = _c.distanceTo(_q);
  }, (d) => !fx.isRemote(d));

  // ------------------------------------------------------------ boss_hit
  function deferHit(delay, p, dir, s, ramp, R, mul, sigil, onBoss, amount) {
    const P = new V3().copy(p), D = dir ? new V3().copy(dir) : null;   // событие — аллокация допустима
    kit.after(delay, () => {
      juicy(P, D, s, ramp, R, mul, sigil, onBoss);
      if (amount >= 40) heavy(P, amount, R, sigil);
    });
  }
  fx.on('boss_hit', (ev, d) => {
    const src = typeof d.source === 'string' ? d.source : '';
    if (SKIP_SRC[src] === 1 || d.dot) return;
    const R = fx.isRemote(d);
    const amount = num(d.amount, 12);
    const pvp = !!d.pvp || d.target === 'opponent' || !!(fx.snap && fx.snap.mode === 'pvp');
    // снаряды: удар уже нарисован на projectile_impact этого кадра — только «доводим» крупный
    if (src === 'bolt' || src === 'throw') {
      if (last.t === kit.clock && (last.drawn || last.skip)) {
        if (last.drawn && amount >= 40 && !last.big) { const p = fx.evPos(ev, _p); if (p) heavy(p, amount, R, ''); }
        return;
      }
      if (pvp && !R) return;                        // PvP: ack приходит позже, удар рисовал projectile_impact
    }
    const p = fx.evPos(ev, _p) || fx.target(_p, R);
    const onBoss = !pvp && !R;
    const sigil = src === 'sigil' && (d.sigil === 'gate' || d.sigil === 'pillar') ? d.sigil : '';
    const s = strength(amount);
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
      if (sigil === 'gate') { ramp = R ? 'rival' : 'fire'; mul = 1.5; }
      else if (sigil === 'pillar') { ramp = R ? 'rival' : 'gold'; mul = 1.5; }
      else if (d.sigil === 'delta') ramp = R ? 'rival' : 'void';
      else ramp = R ? 'rival' : 'storm';
    }
    if (pvp) delay = 0;
    if (delay > 0) { deferHit(delay, p, _dir, s, ramp, R, mul, sigil, onBoss, amount); return; }
    juicy(p, _dir, s, ramp, R, mul, sigil, onBoss);
    if (amount >= 40 || sigil) heavy(p, amount, R, sigil);
  });

  fx.every((dt, snap) => { crackTick(dt, snap); });

  fx.onClear(() => {
    for (let i = 0; i < N_CRACK; i++) { cracks[i].heat = 0; cracks[i].acc = 0; cracks[i].accF = 0; }
    last.t = -1; last.drawn = false; last.skip = false; lastRune.t = -1;
  });
}
