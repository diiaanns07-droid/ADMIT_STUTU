// ASHEN OATH — боевой трекинг-HUD поверх 3D-сцены (2D canvas). Владелец: №1.
// «Tracking edit»: захват цели на страже, метки атак с таймером, комбо, выноски урона,
// руна, нарисованная пальцем, прямо на экране, замедление времени, интро.
// Ничего не импортирует, свой rAF не запускает: main.js вызывает frame() каждый кадр.
//
// frame(f): f = { dtReal, timeScale, screen, snapshot, events, input, project(p)->{x,y,behind},
//   viewport:{w,h}, intro:{active,t,duration}, settings:{reducedMotion}, resumeLeftMs,
//   pois:[{id,x,y,z}] — [ASHEN_V2] незажжённые угли клятвы (метка над алтарём или стрелка у края),
//   coach:{hint:{code,gesture,text,side}|null, accuracy, good, mistakes} — [ТВИСТ «ОШИБКА»] подсказка к
//   почти-правильному жесту (карточка внизу по центру) и точность жестов за бой }

const MONO = '"Consolas","Cascadia Mono",monospace';
const SERIF = '"Palatino Linotype","Book Antiqua",Georgia,serif';
const GOLD = '#c9a45c', GOLD_HI = '#e3c792', STEEL = '#dfe8f5', BLUE = '#9fc4ff', EMBER = '#ff6a3c', DIM = '#8d97a6';
const PLATE = 'rgba(5,7,11,0.62)';
const GLYPHS = '0123456789ABCDEFXZ#%+=/<>';
const RUNE_NAME = { ignis: 'ИГНИС', fulgur: 'ФУЛЬГУР', orbis: 'ОРБИС', stella: 'СТЕЛЛА', spira: 'СПИРА', lemnis: 'ЛЕМНИСКА', caret: 'АКУС', vee: 'МЕССИС', clepsydra: 'КЛЕПСИДРА', alpha: 'АЛЬФА' };
const RUNE_SUB = { ignis: 'огненное копьё', fulgur: 'страж оглушён', orbis: 'лечение и оберег', stella: 'звездопад', spira: 'вихрь гасит сферы', lemnis: 'вечность: лечение', caret: 'залп игл', vee: 'жатва', clepsydra: 'время Регента замедлено', alpha: 'откаты сброшены' };
const KIND = { slam: 'SLAM', orb: 'ORB', nova: 'NOVA' };
// [ASHEN_V3] двуручные печати
const SIGIL_NAME = { clap: 'ГРОМОВОЙ ХЛОПОК', gate: 'ВРАТА · БАСТИОН', frame: 'МЕТКА ЦЕЛИ', delta: 'ДЕЛЬТА · ЛУЧ', cor: 'КОР · СЕРДЦЕ' };

const isObj = (v) => v !== null && typeof v === 'object';
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createBattleHud({ canvas } = {}) {
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return { frame() {}, reset() {}, dispose() {} };
  let W = 0, H = 0, dpr = 1, disposed = false, drawn = false;
  let t = 0;
  const lock = { x0: 0, y0: 0, x1: 0, y1: 0, ok: false, hitFlash: 0 };
  const callouts = [];       // {text, x, y, vy, t, dur, color, size, font, scramble}
  const MAX_CALLOUTS = 18;
  let flash = { t: 1, dur: 0.25, color: 'rgba(227,199,146,', a: 0.3 };
  let hurt = { t: 1, dur: 0.35 };
  let dashFx = { t: 1, dir: 1 };
  let combo = { n: 0, shown: 0, pop: 0, lost: 0, lostN: 0 };
  let rune = { name: '', sub: '', t: 9, trail: null };
  let fizzleT = 9;
  let coach = { hint: null, t: 9 };   // [ТВИСТ «ОШИБКА»] текущая карточка подсказки
  const COACH_DUR = 4.2;
  let lastScreen = '';
  let playingSince = -1;

  function resize(vw, vh) {
    const d = clamp(num(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 1), 1, 2);
    const bw = Math.round(vw * d), bh = Math.round(vh * d);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    W = vw; H = vh; dpr = d;
  }
  function clearAll() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawn = false;
  }
  function scramble(text, age, rm, speed = 0.45) {
    if (rm || age >= speed) return text;
    const k = age / speed;
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      out += (i / text.length < k || ch === ' ') ? ch : GLYPHS[(Math.floor(age * 60) + i * 7) % GLYPHS.length];
    }
    return out;
  }
  function brackets(x0, y0, x1, y1, len) {
    const lx = Math.min(len, (x1 - x0) * 0.4), ly = Math.min(len, (y1 - y0) * 0.4);
    ctx.beginPath();
    ctx.moveTo(x0, y0 + ly); ctx.lineTo(x0, y0); ctx.lineTo(x0 + lx, y0);
    ctx.moveTo(x1 - lx, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + ly);
    ctx.moveTo(x1, y1 - ly); ctx.lineTo(x1, y1); ctx.lineTo(x1 - lx, y1);
    ctx.moveTo(x0 + lx, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - ly);
    ctx.stroke();
  }
  function tag(text, x, y, color, font = `11px ${MONO}`, align = 'left') {
    ctx.font = font;
    const w = ctx.measureText(text).width;
    const px = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    ctx.fillStyle = PLATE;
    ctx.fillRect(px - 4, y - 2, w + 8, 16);
    ctx.fillStyle = color;
    ctx.fillText(text, px, y);
    return w;
  }
  function addCallout(text, x, y, color, size = 13, opts = {}) {
    if (callouts.length >= MAX_CALLOUTS) callouts.shift();
    callouts.push({ text, x, y, vy: opts.vy ?? -26, t: 0, dur: opts.dur ?? 0.9, color, size, serif: !!opts.serif, scramble: !!opts.scramble });
  }
  function vignette(color, a, inner = 0.55) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * inner * 0.5, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, color + '0)');
    g.addColorStop(1, color + a + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function handleEvents(events, proj, snap, rm) {
    if (!Array.isArray(events)) return;
    for (const e of events) {
      if (!isObj(e)) continue;
      const d = isObj(e.data) ? e.data : {};
      const at = isObj(e.position) ? proj(e.position) : null;
      switch (e.type) {
        case 'boss_hit': {
          lock.hitFlash = 1;
          const big = d.source === 'burst' || d.source === 'rune';
          const p = at && !at.behind ? at : { x: W / 2, y: H * 0.35 };
          addCallout(`-${Math.round(num(d.amount, 0))}`, p.x + (Math.random() - 0.5) * 30, p.y - 10, big ? GOLD_HI : GOLD, big ? 22 : 13);
          if (num(d.combo, 0) > combo.n) { combo.n = d.combo; combo.pop = 1; }
          break;
        }
        case 'combo_break': combo.lost = 1; combo.lostN = num(d.combo, combo.n); combo.n = 0; break;
        case 'player_hit': {
          hurt.t = 0;
          const p = at && !at.behind ? at : { x: W * 0.4, y: H * 0.6 };
          addCallout(`-${Math.round(num(d.amount, 0))}`, p.x, p.y - 20, EMBER, 16);
          break;
        }
        case 'block': {
          const p = at && !at.behind ? at : { x: W * 0.4, y: H * 0.6 };
          addCallout(d.ward ? 'ОБЕРЕГ' : 'BLOCK', p.x, p.y - 30, d.ward ? GOLD_HI : BLUE, 14, { scramble: true });
          break;
        }
        case 'dodge': if (!d.perfect) { const p = at && !at.behind ? at : { x: W * 0.4, y: H * 0.62 }; addCallout('DODGE', p.x, p.y - 30, STEEL, 13, { scramble: true }); } break;
        case 'perfect_dodge': addCallout('PERFECT DODGE', W / 2, H * 0.3, STEEL, 30, { vy: 0, dur: 1.2, serif: false, scramble: true }); break;
        case 'player_dash': dashFx = { t: 0, dir: num(d.direction, 1) >= 0 ? 1 : -1 }; break;
        case 'sigil_cast': {   // [ASHEN_V3] печать двумя руками
          const k = d.sigil;
          flash = { t: 0, dur: 0.3, color: k === 'clap' ? 'rgba(159,196,255,' : 'rgba(227,199,146,', a: k === 'clap' ? 0.3 : 0.2 };
          let sub = '';
          if (k === 'clap') sub = d.stunned ? 'РЕГЕНТ ОГЛУШЁН' : d.cleared ? `ОРБОВ ПОГАШЕНО: ${d.cleared}` : 'ВОЛНА';
          else if (k === 'gate') sub = `−${Math.round(num(d.reduction, 0.6) * 100)}% УРОНА · ${num(d.duration, 5)} с`;
          else if (k === 'frame') sub = `+${Math.round(num(d.bonus, 0.3) * 100)}% УРОНА · ${num(d.duration, 8)} с`;
          else if (k === 'delta') sub = `${num(d.ticks, 4)} УДАРА ЛУЧА${d.cleared ? ` · ОРБОВ ПОГАШЕНО: ${d.cleared}` : ''}`;
          else if (k === 'cor') sub = `+${num(d.heal, 45)} HP · ОБЕРЕГ`;
          addCallout(SIGIL_NAME[k] || String(k || ''), W / 2, H * 0.36, k === 'clap' ? BLUE : GOLD_HI, 24, { vy: -8, dur: 1.4, serif: true });
          if (sub) addCallout(sub, W / 2, H * 0.36 + 32, k === 'clap' ? BLUE : GOLD, 13, { vy: -8, dur: 1.4, scramble: true });
          break;
        }
        case 'encounter_start':   // [ASHEN_V2] вход в арену или удар издали
          flash = { t: 0, dur: 0.35, color: 'rgba(255,106,60,', a: 0.22 };
          addCallout(d.reason === 'aggro' ? 'РЕГЕНТ ПРОБУДИЛСЯ' : 'БОЙ', W / 2, H * 0.34, EMBER, 22, { vy: 0, dur: 1.4, scramble: true });
          break;
        case 'encounter_end':
          addCallout('РЕГЕНТ ЗАБЫЛ ВАС', W / 2, H * 0.34, DIM, 16, { vy: 0, dur: 1.6, scramble: true });
          break;
        case 'cruise_start': addCallout('АВТОБЕГ', W / 2, H * 0.72, EMBER, 14, { vy: -6, dur: 1.2, scramble: true }); break;
        case 'ember_lit':   // [ASHEN_V2] уголь клятвы зажжён
          flash = { t: 0, dur: 0.45, color: 'rgba(255,170,90,', a: 0.3 };
          addCallout(`УГОЛЬ КЛЯТВЫ  +${num(d.points, 3)}`, W / 2, H * 0.3, GOLD_HI, 26, { vy: -8, dur: 2.4, serif: true, scramble: false });
          if (num(d.total, 0) > 0) addCallout(`${num(d.lit, 0)} / ${num(d.total, 0)}`, W / 2, H * 0.3 + 34, EMBER, 13, { vy: -8, dur: 2.4, scramble: true });
          break;
        case 'burst': flash = { t: 0, dur: 0.28, color: 'rgba(227,199,146,', a: 0.32 }; addCallout(`ВЫБРОС ×${(0.5 + num(d.power, 0.5)).toFixed(1)}`, W / 2, H * 0.42, GOLD_HI, 20, { vy: -10, dur: 1, scramble: true }); break;
        case 'rune_cast':
          rune = { name: RUNE_NAME[d.rune] || String(d.rune || ''), sub: RUNE_SUB[d.rune] || '', t: 0, trail: rune.trail };
          flash = { t: 0, dur: 0.3, color: d.rune === 'fulgur' ? 'rgba(159,196,255,' : 'rgba(227,199,146,', a: 0.28 };
          break;
        case 'boss_stunned': lock.hitFlash = 1.5; break;
        case 'ability_denied': {
          const txt = d.reason === 'energy' ? 'НЕТ ЭНЕРГИИ' : d.reason === 'cooldown' ? (d.ability === 'rune' ? 'РУНА ПЕРЕЗАРЯЖАЕТСЯ' : 'ПЕРЕЗАРЯДКА') : '';
          if (txt && d.ability !== 'shield') addCallout(txt, W / 2, H * 0.68, DIM, 12, { vy: -8, dur: 0.8 });
          break;
        }
        default: break;
      }
    }
  }

  function drawLock(snap, proj, rm, dtR, intro) {
    const b = snap.boss;
    const pts = [[0, 0, 0], [0, 5.6, 0], [1.7, 2.7, 0], [-1.7, 2.7, 0], [0, 2.7, 1.7], [0, 2.7, -1.7]];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ok = true;
    for (const [dx, dy, dz] of pts) {
      const p = proj({ x: b.position.x + dx, y: b.position.y + dy, z: b.position.z + dz });
      if (!p || p.behind) { ok = false; break; }
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    if (!ok) { lock.ok = false; return; }
    const k = lock.ok && !rm ? 1 - Math.exp(-dtR * 14) : 1;
    lock.x0 += (x0 - lock.x0) * k; lock.x1 += (x1 - lock.x1) * k; lock.y0 += (y0 - lock.y0) * k; lock.y1 += (y1 - lock.y1) * k;
    lock.ok = true;
    const tel = snap.telegraphs && snap.telegraphs[0];
    let col = STEEL, state = '';
    if (b.stunned) { col = BLUE; state = `ОГЛУШЁН ${num(b.stunRemaining, 0).toFixed(1)}s`; }
    else if (b.action === 'windup' && tel) { col = tel.blockable ? BLUE : EMBER; state = `${KIND[tel.kind] || tel.kind} ▸ ${num(tel.remaining, 0).toFixed(1)}s`; }
    else if (b.action === 'recover') { col = GOLD_HI; state = 'OPEN ▸ STRIKE'; }
    else if (b.action === 'dead') { col = DIM; state = 'TARGET DOWN'; }
    const pad = 10 + (b.action === 'windup' && !rm ? Math.sin(t * 18) * 2 : 0);
    const hf = lock.hitFlash;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = hf > 0.05 ? '#ffffff' : col;
    ctx.globalAlpha = intro ? 0.9 : 0.8;
    brackets(lock.x0 - pad, lock.y0 - pad, lock.x1 + pad, lock.y1 + pad, 18);
    // прицел на ядре
    const core = proj({ x: b.position.x, y: b.position.y + 3.1, z: b.position.z });
    if (core && !core.behind) {
      ctx.beginPath();
      ctx.moveTo(core.x - 9, core.y); ctx.lineTo(core.x - 4, core.y); ctx.moveTo(core.x + 4, core.y); ctx.lineTo(core.x + 9, core.y);
      ctx.moveTo(core.x, core.y - 9); ctx.lineTo(core.x, core.y - 4); ctx.moveTo(core.x, core.y + 4); ctx.lineTo(core.x, core.y + 9);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (intro) return;
    const p = snap.player.position;
    const dist = Math.hypot(p.x - b.position.x, p.z - b.position.z);
    const lx = lock.x1 + pad + 8, ly = Math.max(96, lock.y0 - pad);
    const engaged = !snap.player.encounter || snap.player.encounter === 'engaged';
    tag(engaged ? 'REGENT // LOCK' : 'REGENT // ВПЕРЕДИ', lx, ly, engaged ? col : DIM, `600 11px ${MONO}`);
    tag(`d:${dist.toFixed(1)}m  HP ${Math.round((b.hp / b.maxHp) * 100)}%`, lx, ly + 18, DIM);
    if (state) tag(state, lx, ly + 36, col, `600 12px ${MONO}`);
    if (b.marked) tag(`◈ МЕТКА +30% · ${num(b.markRemaining, 0).toFixed(1)}s`, lx, ly + (state ? 54 : 36), GOLD_HI, `600 11px ${MONO}`);
    lock.hitFlash = Math.max(0, lock.hitFlash - dtR * 5);
  }

  // [ASHEN_V2] угли клятвы: ромб и расстояние над алтарём; вне кадра — стрелка у края экрана.
  function drawPois(snap, proj, pois) {
    if (!Array.isArray(pois) || !pois.length) return;
    const p = snap.player.position;
    const explore = snap.player.encounter === 'explore';
    const base = ctx.globalAlpha;
    let nearest = null, nd = Infinity;
    for (const q of pois) if (isObj(q) && Number.isFinite(q.x)) { const dd = Math.hypot(q.x - p.x, q.z - p.z); if (dd < nd) { nd = dd; nearest = q; } }
    // ближайшие 8 (углей на большой карте 10): ближний всегда с меткой
    const near8 = pois.filter((q) => isObj(q) && Number.isFinite(q.x) && Number.isFinite(q.z))
      .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z)).slice(0, 8);
    for (const q of near8) {
      if (!isObj(q) || !Number.isFinite(q.x) || !Number.isFinite(q.z)) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      const qy = num(q.y, 0);
      const s = proj({ x: q.x, y: qy + 2.3, z: q.z });
      ctx.globalAlpha = base * (explore ? 0.95 : 0.45);
      if (s && !s.behind && s.x > 40 && s.x < W - 40 && s.y > 90 && s.y < H - 70) {
        const r = 6 + 2 * Math.sin(t * 3 + q.x);
        ctx.strokeStyle = EMBER; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x + r, s.y); ctx.lineTo(s.x, s.y + r); ctx.lineTo(s.x - r, s.y); ctx.closePath(); ctx.stroke();
        if (q === nearest) tag(`УГОЛЬ · ${Math.round(d)} м`, s.x, s.y + 12, EMBER, `600 11px ${MONO}`, 'center');
      } else if (explore && q === nearest) {
        const c = proj({ x: q.x, y: qy + 1, z: q.z });
        if (!c) continue;
        let dx = c.x - W / 2, dy = c.y - H / 2;
        if (c.behind) { dx = -dx; dy = -dy; }
        if (Math.abs(dx) + Math.abs(dy) < 1e-3) continue;
        const ang = Math.atan2(dy, dx), mx = W / 2 - 46, my = H / 2 - 100;
        const k = Math.min(mx / Math.max(1e-6, Math.abs(Math.cos(ang))), my / Math.max(1e-6, Math.abs(Math.sin(ang))));
        const ex = W / 2 + Math.cos(ang) * k, ey = H / 2 + Math.sin(ang) * k;
        ctx.save(); ctx.translate(ex, ey); ctx.rotate(ang);
        ctx.fillStyle = EMBER; ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-6, -7); ctx.lineTo(-2, 0); ctx.lineTo(-6, 7); ctx.closePath(); ctx.fill();
        ctx.restore();
        tag(`${Math.round(d)} м`, ex - Math.cos(ang) * 26, ey - Math.sin(ang) * 22 - 7, EMBER, `600 10px ${MONO}`, 'center');
      }
    }
    ctx.globalAlpha = base;
  }

  // [ASHEN_V4] Крупный индикатор левого джойстика внизу по центру: игрок смотрит на героя, а не на
  // крошечное превью камеры. Кольца: мёртвая зона, граница бега; точка — где рука относительно центра;
  // стрелка — куда идёт герой. Без хватки — подсказка «поднимите и замрите» с прогрессом.
  const stickFx = { dashT: 9, dashX: 0, dashY: 0, alpha: 0 };
  function drawStickHud(input, snap, dtR, rm) {
    const st = input && isObj(input.stick) ? input.stick : null;
    const want = input ? 1 : 0;
    stickFx.alpha += (want - stickFx.alpha) * (1 - Math.exp(-dtR * 8));
    if (stickFx.alpha < 0.02) return;
    const dd = input && isObj(input.dashDir) ? input.dashDir : null;
    if (dd && (num(dd.x, 0) || num(dd.z, 0))) { stickFx.dashT = 0; stickFx.dashX = num(dd.x, 0); stickFx.dashY = -num(dd.z, 0); }
    stickFx.dashT += dtR;
    if (st && st.mode === 'steer') { drawSteerHud(st, snap, rm); return; }
    const R = clamp(Math.min(W, H) * 0.075, 40, 66);
    const cx = W / 2, cy = H - R - 26;
    const A = stickFx.alpha;
    const base = ctx.globalAlpha;
    const engaged = !!(st && st.engaged);
    const running = engaged && st.gait === 'run', walking = engaged && st.gait === 'walk';
    const sprint = snap && snap.player && num(snap.player.sprint, 0) > 0.5;
    // подложка
    ctx.globalAlpha = base * A * 0.55;
    ctx.fillStyle = PLATE;
    ctx.beginPath(); ctx.arc(cx, cy, R + 8, 0, Math.PI * 2); ctx.fill();
    // зоны: шаг (внутри кольца бега) и бег (снаружи)
    const rRun = R * 0.72;
    const S = st && num(st.deadzone, 0) > 0 ? st.deadzone / 0.4 : 0;
    const dzPx = st && S > 0 && num(st.runOn, 0) > 0 ? rRun * (st.deadzone / st.runOn) : R * 0.24;
    ctx.globalAlpha = base * A * (running ? 0.9 : 0.45);
    ctx.strokeStyle = sprint ? EMBER : GOLD; ctx.lineWidth = running ? 2 : 1.2;
    ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.arc(cx, cy, rRun, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = base * A * 0.35; ctx.strokeStyle = STEEL; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = base * A * 0.5; ctx.fillStyle = 'rgba(201,164,92,0.18)';
    ctx.beginPath(); ctx.arc(cx, cy, dzPx, 0, Math.PI * 2); ctx.fill();
    // рука относительно центра
    let label = '', col = DIM;
    if (!st || !st.hand) { label = 'ЛЕВАЯ РУКА НЕ ВИДНА'; col = DIM; }
    else if (!engaged) {
      if (st.rest) { label = 'РУКА ОПУЩЕНА · ПОДНИМИТЕ И ЗАМРИТЕ'; col = DIM; }
      else if (st.grabbing) {
        label = 'ЗАМРИТЕ…'; col = GOLD_HI;
        const k = clamp(num(st.grabProgress, 0.5), 0, 1);
        ctx.globalAlpha = base * A; ctx.strokeStyle = GOLD_HI; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, R + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k); ctx.stroke();
      } else { label = 'ПОДНИМИТЕ ЛЕВУЮ РУКУ И ЗАМРИТЕ'; col = GOLD; }
    } else {
      const aspect = num(st.aspect, 4 / 3);
      if (st.anchor && S > 0) {
        const ox = (st.hand.x - st.anchor.x) * aspect / S, oy = (st.hand.y - st.anchor.y) / S;
        const k = rRun / Math.max(1e-3, st.runOn / S);
        let px = ox * k, py = oy * k;
        const l = Math.hypot(px, py); if (l > R) { px *= R / l; py *= R / l; }
        ctx.globalAlpha = base * A * 0.5; ctx.strokeStyle = STEEL; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + px, cy + py); ctx.stroke();
        ctx.globalAlpha = base * A; ctx.fillStyle = running ? GOLD_HI : walking ? BLUE : STEEL;
        ctx.beginPath(); ctx.arc(cx + px, cy + py, 5.5, 0, Math.PI * 2); ctx.fill();
      }
      const mx = num(st.x, 0), mz = num(st.z, 0), m = Math.min(1, Math.hypot(mx, mz));
      if (m > 0.01) {
        // шаг (0.2…0.6) заполняет пространство до кольца бега, бег — до края
        const ux = mx / m, uy = -mz / m, L = running ? R : dzPx + (rRun - dzPx) * clamp(m / 0.6, 0.35, 1);
        ctx.globalAlpha = base * A * 0.95; ctx.strokeStyle = running ? (sprint ? EMBER : GOLD_HI) : BLUE; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(cx + ux * dzPx * 0.6, cy + uy * dzPx * 0.6); ctx.lineTo(cx + ux * L, cy + uy * L); ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        const ex = cx + ux * L, ey = cy + uy * L;
        ctx.beginPath(); ctx.moveTo(ex + ux * 8, ey + uy * 8); ctx.lineTo(ex - uy * 6, ey + ux * 6); ctx.lineTo(ex + uy * 6, ey - ux * 6); ctx.closePath(); ctx.fill();
      }
      label = sprint ? 'СПРИНТ' : running ? 'БЕГ' : walking ? 'ШАГ' : 'СТОИТ';
      col = sprint ? EMBER : running ? GOLD_HI : walking ? BLUE : STEEL;
      if (st.source === 'wrist') label += ' · ПО ЗАПЯСТЬЮ';
    }
    if (snap && snap.player && snap.player.cruise) { label = 'АВТОБЕГ · ПОДНИМИТЕ РУКУ — СТОП'; col = EMBER; }
    // вспышка рывка
    if (stickFx.dashT < 0.45) {
      const k = 1 - stickFx.dashT / 0.45, l = Math.hypot(stickFx.dashX, stickFx.dashY) || 1;
      const ux = stickFx.dashX / l, uy = stickFx.dashY / l, a0 = Math.atan2(uy, ux);
      ctx.globalAlpha = base * A * k; ctx.strokeStyle = EMBER; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(cx, cy, R + 6 + (1 - k) * 14, a0 - 0.55, a0 + 0.55); ctx.stroke();
      label = 'РЫВОК'; col = EMBER;
    }
    ctx.globalAlpha = base * A;
    tag(label, cx, cy + R + 10, col, `600 11px ${MONO}`, 'center');
    ctx.globalAlpha = base;
  }

  // [V5] Схема «Руль» (core/steerStick.js): дуга-руль сверху — сколько герой поворачивает (серая
  // полоса в середине — мёртвая зона, точка — где сейчас рука), столбик в центре — высота левой руки
  // и ступени «ШАГ» / «БЕГ»; ниже — что делает герой и что сделать, чтобы пойти. Занимает то же место,
  // что индикатор джойстика: низ экрана по центру, ниже карточки «ОШИБКА».
  function drawSteerHud(st, snap, rm) {
    const base = ctx.globalAlpha, A = stickFx.alpha;
    const R = clamp(Math.min(W, H) * 0.075, 40, 66);
    const cx = W / 2, cy = H - 58 - R * 0.3;
    const engaged = !!st.engaged;
    const turn = engaged ? clamp(num(st.turn, num(st.x, 0)), -1, 1) : 0;
    const fwd = engaged ? clamp(num(st.fwd, num(st.z, 0)), 0, 1) : 0;
    const P = snap && snap.player;
    const sprint = engaged && P && num(P.sprint, 0) > 0.5;
    const arena = !!(P && P.encounter === 'engaged');
    const running = engaged && st.gait === 'run';
    const col = sprint ? EMBER : running ? GOLD_HI : BLUE;
    const lv = isObj(st.levels) ? st.levels : { walkOn: -0.55, walkOff: -0.72, runOn: 0.05, runOff: -0.12 };
    const tz = isObj(st.turnZone) ? st.turnZone : { dzOn: 0.2, dzOff: 0.13, full: 0.62 };
    const SPAN = 1.15, TOP = -Math.PI / 2;           // полный поворот — ±66° по дуге
    const pulse = rm ? 0.75 : 0.55 + 0.45 * Math.abs(Math.sin(t * 3.2));
    // подложка: полукруг над столбиком
    ctx.globalAlpha = base * A * 0.55; ctx.fillStyle = PLATE;
    ctx.beginPath(); ctx.arc(cx, cy, R + 12, Math.PI, 0); ctx.lineTo(cx + R + 12, cy + R * 0.3 + 4); ctx.lineTo(cx - R - 12, cy + R * 0.3 + 4); ctx.closePath(); ctx.fill();
    // дуга-руль: дорожка, мёртвая зона, заливка поворота, ручка
    ctx.lineCap = 'round';
    ctx.globalAlpha = base * A * 0.35; ctx.strokeStyle = STEEL; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(cx, cy, R, TOP - SPAN, TOP + SPAN); ctx.stroke();
    const dzA = SPAN * clamp(num(tz.dzOn, 0.2) / Math.max(0.05, num(tz.full, 0.62)), 0, 0.8);
    ctx.globalAlpha = base * A * 0.55; ctx.strokeStyle = 'rgba(201,164,92,0.55)'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(cx, cy, R, TOP - dzA, TOP + dzA); ctx.stroke();
    if (Math.abs(turn) > 0.01) {
      ctx.globalAlpha = base * A * 0.95; ctx.strokeStyle = col; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(cx, cy, R, Math.min(TOP, TOP + turn * SPAN), Math.max(TOP, TOP + turn * SPAN)); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    const ka = TOP + turn * SPAN;
    ctx.globalAlpha = base * A; ctx.fillStyle = engaged ? col : DIM;
    ctx.beginPath(); ctx.arc(cx + Math.cos(ka) * R, cy + Math.sin(ka) * R, engaged ? 6.5 : 5, 0, Math.PI * 2); ctx.fill();
    if (Number.isFinite(st.lateral) && st.hand) {
      // где сейчас рука по горизонтали (сырая, до мёртвой зоны и сглаживания)
      const ha = TOP + clamp(st.lateral / Math.max(0.05, num(tz.full, 0.62)), -1.25, 1.25) * SPAN;
      ctx.globalAlpha = base * A * 0.8; ctx.fillStyle = STEEL;
      ctx.beginPath(); ctx.arc(cx + Math.cos(ha) * (R - 11), cy + Math.sin(ha) * (R - 11), 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = base * A * 0.8; ctx.fillStyle = DIM; ctx.font = `600 12px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const ea = SPAN + 0.2;
    ctx.fillText('←', cx + Math.cos(TOP - ea) * (R + 2), cy + Math.sin(TOP - ea) * (R + 2));
    ctx.fillText('→', cx + Math.cos(TOP + ea) * (R + 2), cy + Math.sin(TOP + ea) * (R + 2));
    // столбик высоты руки: ниже «ШАГ» — стоп, выше «БЕГ» — бег
    const bw = 10, x0 = cx - bw / 2, yb = cy + R * 0.3 - 4, yt = cy - R * 0.66;
    const vMin = num(lv.walkOff, -0.72) - 0.6, vMax = num(lv.runOn, 0.05) + 0.45;
    const yOf = (v) => yb - (clamp(v, vMin, vMax) - vMin) / (vMax - vMin) * (yb - yt);
    const yWalk = yOf(num(lv.walkOn, -0.55)), yRun = yOf(num(lv.runOn, 0.05));
    ctx.globalAlpha = base * A * 0.8; ctx.fillStyle = 'rgba(5,7,11,0.85)'; ctx.fillRect(x0, yt, bw, yb - yt);
    ctx.globalAlpha = base * A * 0.3; ctx.fillStyle = BLUE; ctx.fillRect(x0, yRun, bw, yWalk - yRun);
    ctx.fillStyle = GOLD; ctx.fillRect(x0, yt, bw, yRun - yt);
    const level = Number.isFinite(st.level) ? st.level : null;
    if (engaged) {
      const yl = level !== null ? yOf(level) : running ? yOf(num(lv.runOn, 0.05) + 0.2) : yOf(num(lv.walkOn, -0.55) + (num(lv.runOn, 0.05) - num(lv.walkOn, -0.55)) * clamp((fwd - 0.3) / 0.3, 0, 1));
      ctx.globalAlpha = base * A * 0.9; ctx.fillStyle = fwd > 0 ? col : STEEL;
      ctx.fillRect(x0 + 2, yl, bw - 4, yb - yl);
    }
    ctx.globalAlpha = base * A * 0.5; ctx.strokeStyle = STEEL; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, yt + 0.5, bw - 1, yb - yt - 1);
    // пороги: «ШАГ» пульсирует, пока рука ниже него
    const wantUp = !engaged && !!st.hand && !st.busy;
    ctx.globalAlpha = base * A * (wantUp ? pulse : 0.8); ctx.strokeStyle = wantUp ? GOLD_HI : STEEL; ctx.lineWidth = wantUp ? 2 : 1.2;
    ctx.beginPath(); ctx.moveTo(x0 - 5, yWalk); ctx.lineTo(x0 + bw + 5, yWalk); ctx.stroke();
    ctx.globalAlpha = base * A * 0.8; ctx.strokeStyle = GOLD; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x0 - 5, yRun); ctx.lineTo(x0 + bw + 5, yRun); ctx.stroke();
    ctx.font = `600 9px ${MONO}`; ctx.textAlign = 'left';
    ctx.globalAlpha = base * A * 0.85; ctx.fillStyle = wantUp ? GOLD_HI : STEEL; ctx.fillText('ШАГ', x0 + bw + 8, yWalk);
    ctx.fillStyle = GOLD; ctx.fillText('БЕГ', x0 + bw + 8, yRun);
    // метка руки на столбике (треугольник слева)
    if (level !== null && st.hand) {
      const yh = yOf(level);
      ctx.globalAlpha = base * A; ctx.fillStyle = engaged ? STEEL : GOLD_HI;
      ctx.beginPath(); ctx.moveTo(x0 - 2, yh); ctx.lineTo(x0 - 10, yh - 5); ctx.lineTo(x0 - 10, yh + 5); ctx.closePath(); ctx.fill();
      if (wantUp && yh > yWalk + 8) {
        // стрелка «выше» от метки руки к порогу «ШАГ»
        const ya = rm ? 0 : (t * 14) % 6;
        ctx.globalAlpha = base * A * pulse; ctx.strokeStyle = GOLD_HI; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(x0 - 14, yh - 8 - ya + 4); ctx.lineTo(x0 - 10, yh - 12 - ya); ctx.lineTo(x0 - 6, yh - 8 - ya + 4); ctx.stroke();
      }
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    // подписи: что делает герой / что сделать
    let l1 = '', c1 = STEEL, l2 = '', c2 = GOLD;
    const pace = sprint ? 'СПРИНТ' : running ? 'БЕГ' : 'ШАГ';
    if (!st.hand) { l1 = 'СТОП'; c1 = DIM; l2 = 'ПОДНИМИТЕ ЛЕВУЮ РУКУ, ЧТОБЫ ИДТИ'; }
    else if (st.busy || st.hold === 'cast') { l1 = 'ЧАРЫ · ГЕРОЙ СТОИТ'; c1 = STEEL; }
    else if (!engaged) { l1 = 'СТОП — РУКА ОПУЩЕНА'; c1 = STEEL; l2 = 'ПОДНИМИТЕ ЛЕВУЮ РУКУ, ЧТОБЫ ИДТИ'; }
    else if (st.hold === 'shield') { l1 = Math.abs(turn) > 0.05 ? `ЩИТ · ПОВОРОТ ${turn < 0 ? '←' : '→'}` : 'ЩИТ · ГЕРОЙ СТОИТ'; c1 = BLUE; }
    else if (Math.abs(turn) > 0.05) { l1 = `${arena ? 'ОБХОД' : 'ПОВОРОТ'} ${turn < 0 ? '←' : '→'} · ${pace}`; c1 = col; }
    else { l1 = `${arena ? 'К РЕГЕНТУ' : 'ВПЕРЁД'} · ${pace}`; c1 = col; }
    if (engaged && st.source === 'wrist') l1 += ' · ПО ЗАПЯСТЬЮ';
    // вспышка рывка — дуга в сторону дёрга
    if (stickFx.dashT < 0.45) {
      const k = 1 - stickFx.dashT / 0.45, a0 = Math.atan2(stickFx.dashY, stickFx.dashX);
      ctx.globalAlpha = base * A * k; ctx.strokeStyle = EMBER; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(cx, cy, R + 8 + (1 - k) * 14, a0 - 0.55, a0 + 0.55); ctx.stroke();
      l1 = 'РЫВОК'; c1 = EMBER;
    }
    const ly = cy + R * 0.3 + 10;
    ctx.globalAlpha = base * A;
    tag(l1, cx, ly, c1, `600 12px ${MONO}`, 'center');
    if (l2) { ctx.globalAlpha = base * A * (rm ? 0.9 : 0.65 + 0.35 * pulse); tag(l2, cx, ly + 19, c2, `600 11px ${MONO}`, 'center'); }
    ctx.globalAlpha = base;
  }

  function drawTelegraphs(snap, proj) {
    const list = Array.isArray(snap.telegraphs) ? snap.telegraphs : [];
    let yNudge = 0;
    for (const tl of list.slice(0, 4)) {
      const c = isObj(tl.center) ? tl.center : tl.kind === 'nova' ? tl.origin : tl.target;
      if (!isObj(c)) continue;
      const p = proj({ x: c.x, y: tl.kind === 'nova' ? 0.2 : 0.1, z: c.z });
      if (!p || p.behind) continue;
      const hint = tl.blockable ? (tl.kind === 'orb' ? 'ЩИТ' : 'ЩИТ / РЫВОК') : 'УЙДИ';
      const col = tl.blockable ? BLUE : EMBER;
      const x = clamp(p.x, 60, W - 200), y = clamp(p.y + 14 + yNudge, 110, H - 40);
      tag(`${tl.blockable ? '◇' : '▲'} ${KIND[tl.kind] || tl.kind} ${num(tl.remaining, 0).toFixed(1)}s · ${hint}`, x, y, col, `600 12px ${MONO}`, 'center');
      yNudge += 18;
    }
  }

  function drawHero(snap, proj, input) {
    const p = snap.player.position;
    const top = proj({ x: p.x, y: 1.95, z: p.z }), bot = proj({ x: p.x, y: 0, z: p.z });
    if (!top || !bot || top.behind || bot.behind) return;
    const h = Math.abs(bot.y - top.y), w = h * 0.42, cx = (top.x + bot.x) / 2;
    ctx.strokeStyle = STEEL; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
    brackets(cx - w / 2, top.y, cx + w / 2, bot.y, 10);
    ctx.globalAlpha = 1;
    tag(`YOU  x:${p.x.toFixed(1)} z:${p.z.toFixed(1)}`, cx - w / 2, top.y - 18, DIM, `10px ${MONO}`);
    if (snap.player.bastion) tag(`▣ БАСТИОН ${num(snap.player.bastionRemaining, 0).toFixed(1)}s`, cx - w / 2, top.y - 36, GOLD_HI, `600 11px ${MONO}`);
    // заряд кулака — кольцо у героя
    const ch = input ? num(input.charge, 0) : 0;
    if (ch > 0.02) {
      const r = h * 0.55;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(223,232,245,0.25)';
      ctx.beginPath(); ctx.arc(cx, (top.y + bot.y) / 2, r, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = ch >= 0.3 ? EMBER : GOLD;
      ctx.beginPath(); ctx.arc(cx, (top.y + bot.y) / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ch); ctx.stroke();
      tag(`ЗАРЯД ${Math.round(ch * 100)}%${ch >= 0.3 ? ' · РАСКРОЙ' : ''}`, cx, bot.y + 8, ch >= 0.3 ? EMBER : GOLD, `600 11px ${MONO}`, 'center');
    }
  }

  function drawRune(input, rm, dtR) {
    const hands = input && isObj(input.hands) ? input.hands : null;
    const trail = hands && Array.isArray(hands.trail) && hands.trail.length > 1 ? hands.trail : null;
    if (trail) rune.trail = trail;
    if (input && input.runeFizzle) fizzleT = 0;
    // область рисования: квадрат по центру экрана, 62% высоты (координаты кадра камеры 0..1)
    const S = H * 0.62, ox = W / 2 - S * 0.667, oy = H * 0.19;
    const map = (q) => [ox + q.x * S * 1.333, oy + q.y * S];
    const drawing = hands && hands.drawing;
    const tr = drawing ? trail : rune.t < 0.8 ? rune.trail : null;
    if (tr && tr.length > 1) {
      const a = drawing ? 1 : Math.max(0, 1 - rune.t / 0.8);
      for (const [w, al, c] of [[10, 0.12, GOLD], [4, 0.35, GOLD_HI], [1.6, 0.95, '#fff4dc']]) {
        ctx.lineWidth = w; ctx.strokeStyle = c; ctx.globalAlpha = al * a; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        let [x, y] = map(tr[0]); ctx.moveTo(x, y);
        for (let i = 1; i < tr.length; i++) { [x, y] = map(tr[i]); ctx.lineTo(x, y); }
        ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
      if (drawing) {
        const [ex, ey] = map(tr[tr.length - 1]);
        tag('✎ РУНА', ex + 12, ey - 8, GOLD_HI, `600 12px ${MONO}`);
      }
    }
    if (rune.t < 1.6 && rune.name) {
      const k = rune.t / 1.6;
      const shown = scramble(rune.name, rune.t, rm, 0.35);
      ctx.globalAlpha = k < 0.8 ? 1 : 1 - (k - 0.8) / 0.2;
      ctx.font = `600 ${Math.round(H * 0.07)}px ${SERIF}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = GOLD_HI;
      ctx.fillText(shown, W / 2, H * 0.24);
      ctx.font = `13px ${MONO}`;
      ctx.fillStyle = STEEL;
      ctx.fillText(`РУНА · ${rune.sub}`, W / 2, H * 0.24 + H * 0.075);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 1;
    }
    rune.t += dtR;
    if (fizzleT < 0.9 && !(coach.hint && coach.t < 1)) { tag('РУНА НЕ РАСПОЗНАНА', W / 2, H * 0.3, DIM, `600 12px ${MONO}`, 'center'); fizzleT += dtR; }
  }

  // [ТВИСТ «ОШИБКА»] карточка: что за жест, что не так и как исправить. Держится ~4 с, новая заменяет старую.
  function wrapLines(text, maxW) {
    const words = String(text).split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w;
      if (ctx.measureText(next).width > maxW && cur) { lines.push(cur); cur = w; } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 3);
  }
  function drawCoach(cv, dtR, rm) {
    if (!isObj(cv)) return;
    if (isObj(cv.hint) && cv.hint.text && (!coach.hint || cv.hint.tMs !== coach.hint.tMs || cv.hint.code !== coach.hint.code)) {
      coach = { hint: cv.hint, t: 0 };
    }
    // точность жестов за бой — у правого края под кнопкой паузы
    if (Number.isFinite(cv.accuracy) && num(cv.good, 0) + num(cv.mistakes, 0) >= 3) {
      const acc = cv.accuracy;
      tag(`ТОЧНОСТЬ ЖЕСТОВ ${acc}%`, W - 24, 70, acc >= 75 ? GOLD_HI : acc >= 50 ? GOLD : EMBER, `600 11px ${MONO}`, 'right');
    }
    if (!coach.hint || coach.t >= COACH_DUR) { coach.t += dtR; return; }
    const k = coach.t;
    const a = clamp(k / 0.18, 0, 1) * clamp((COACH_DUR - k) / 0.5, 0, 1);
    const h = coach.hint;
    const cw = Math.min(560, W - 40);
    ctx.font = `500 17px ${SERIF}`;
    const lines = wrapLines(h.text, cw - 58);
    const ch = 46 + lines.length * 22;
    const x = W / 2 - cw / 2;
    const rise = rm ? 0 : (1 - clamp(k / 0.25, 0, 1)) * 14;
    const y = Math.min(H * 0.6, H - 260 - ch) + rise; // выше панели способностей и превью камеры
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(12,6,6,0.82)';
    ctx.fillRect(x, y, cw, ch);
    // пульсирующая рамка и красная полоса слева
    const pulse = rm ? 0.8 : 0.6 + 0.4 * Math.abs(Math.sin(k * 5));
    ctx.strokeStyle = `rgba(255,106,60,${(0.55 * pulse).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
    ctx.fillStyle = EMBER;
    ctx.fillRect(x, y, 4, ch);
    // значок «!»
    ctx.beginPath(); ctx.arc(x + 27, y + 24, 11, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,106,60,0.18)'; ctx.fill();
    ctx.strokeStyle = EMBER; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = EMBER; ctx.font = `700 14px ${MONO}`; ctx.textAlign = 'center'; ctx.fillText('!', x + 27, y + 16);
    ctx.textAlign = 'left';
    const side = h.side === 'left' ? ' · ЛЕВАЯ РУКА' : h.side === 'right' ? ' · ПРАВАЯ РУКА' : '';
    ctx.font = `600 11px ${MONO}`; ctx.fillStyle = EMBER;
    ctx.fillText(scramble(`ОШИБКА · ${String(h.gesture || '').toUpperCase()}${side}`, k, rm, 0.3), x + 48, y + 11);
    ctx.font = `500 17px ${SERIF}`; ctx.fillStyle = STEEL;
    lines.forEach((ln, i) => ctx.fillText(ln, x + 48, y + 30 + i * 22));
    // полоска времени жизни
    ctx.fillStyle = 'rgba(255,106,60,0.5)';
    ctx.fillRect(x + 4, y + ch - 2, (cw - 4) * (1 - k / COACH_DUR), 2);
    ctx.globalAlpha = 1;
    coach.t += dtR;
  }

  function drawCombo(snap, dtR, rm) {
    const P = snap.player;
    const n = num(P.combo, 0);
    if (n < combo.n) combo.n = n;
    const x = W - 34, y = H * 0.46;
    if (n >= 2) {
      const s = 1 + (rm ? 0 : combo.pop * 0.25);
      ctx.textAlign = 'right';
      ctx.font = `600 ${Math.round(34 * s)}px ${MONO}`;
      ctx.fillStyle = GOLD_HI;
      ctx.fillText(`x${n}`, x, y);
      ctx.font = `600 11px ${MONO}`;
      ctx.fillStyle = STEEL;
      ctx.fillText(`COMBO  ×${num(P.comboMultiplier, 1).toFixed(2)}`, x, y + 40 * s);
      const frac = clamp(num(P.comboTimer, 0) / 3, 0, 1);
      ctx.fillStyle = 'rgba(223,232,245,0.18)'; ctx.fillRect(x - 110, y + 58 * s, 110, 2);
      ctx.fillStyle = GOLD; ctx.fillRect(x - 110 * frac, y + 58 * s, 110 * frac, 2);
      ctx.textAlign = 'left';
    }
    if (combo.lost > 0.02 && combo.lostN >= 5) {
      ctx.globalAlpha = combo.lost; ctx.textAlign = 'right';
      ctx.font = `600 12px ${MONO}`; ctx.fillStyle = EMBER;
      ctx.fillText(`COMBO LOST · x${combo.lostN}`, x, y + 80);
      ctx.textAlign = 'left'; ctx.globalAlpha = 1;
    }
    combo.pop = Math.max(0, combo.pop - dtR * 6);
    combo.lost = Math.max(0, combo.lost - dtR * 0.9);
  }

  function drawCallouts(dtR, rm) {
    for (let i = callouts.length - 1; i >= 0; i--) {
      const c = callouts[i];
      c.t += dtR;
      if (c.t >= c.dur) { callouts.splice(i, 1); continue; }
      c.y += c.vy * dtR;
      const a = c.t < c.dur * 0.7 ? 1 : 1 - (c.t - c.dur * 0.7) / (c.dur * 0.3);
      ctx.globalAlpha = a;
      ctx.font = `600 ${c.size}px ${c.serif ? SERIF : MONO}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const txt = c.scramble ? scramble(c.text, c.t, rm, 0.3) : c.text;
      ctx.fillText(txt, c.x + 1, c.y + 1);
      ctx.fillStyle = c.color;
      ctx.fillText(txt, c.x, c.y);
    }
    ctx.textAlign = 'left'; ctx.globalAlpha = 1;
  }

  function drawScreenFx(ts, dtR, rm) {
    if (flash.t < flash.dur) { const a = (1 - flash.t / flash.dur) * flash.a; vignette(flash.color, a.toFixed(3), rm ? 0.8 : 0.2); flash.t += dtR; }
    if (hurt.t < hurt.dur) { const a = (1 - hurt.t / hurt.dur) * 0.35; vignette('rgba(255,106,60,', a.toFixed(3), 0.7); hurt.t += dtR; }
    if (ts < 0.99 && ts > 0.05) {
      vignette('rgba(120,150,200,', (0.3 * (1 - ts)).toFixed(3), 0.6);
      tag(`SLOW ×${ts.toFixed(2)}`, W / 2, 88, BLUE, `600 11px ${MONO}`, 'center');
    }
    if (dashFx.t < 0.25 && !rm) {
      const a = 1 - dashFx.t / 0.25;
      ctx.strokeStyle = STEEL; ctx.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const y = (H * (i + 0.5)) / 14 + Math.sin(i * 7.3) * 12;
        const edge = dashFx.dir > 0 ? 0 : W;
        const len = W * (0.08 + 0.06 * ((i * 37) % 5) / 5);
        ctx.globalAlpha = a * 0.35;
        ctx.beginPath(); ctx.moveTo(edge, y); ctx.lineTo(edge + dashFx.dir * len, y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    dashFx.t += dtR;
  }

  function drawIntro(intro, rm) {
    const T = num(intro.t, 0), D = Math.max(1, num(intro.duration, 5));
    const barIn = clamp(T / 0.6, 0, 1), barOut = clamp((D - T) / 0.5, 0, 1);
    const bh = H * 0.11 * Math.min(barIn, barOut);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, bh); ctx.fillRect(0, H - bh, W, bh);
    if (T > 0.8 && T < D - 0.9) {
      ctx.font = `600 12px ${MONO}`; ctx.fillStyle = STEEL; ctx.textAlign = 'center';
      ctx.fillText(scramble('ЦЕЛЬ ОБНАРУЖЕНА', T - 0.8, rm), W / 2, bh + 26);
    }
    if (T > 1.6 && T < D - 0.6) {
      const a = clamp((T - 1.6) / 0.4, 0, 1) * clamp((D - 0.6 - T) / 0.4, 0, 1);
      ctx.globalAlpha = a;
      ctx.font = `600 ${Math.round(H * 0.06)}px ${SERIF}`; ctx.fillStyle = GOLD_HI; ctx.textAlign = 'center';
      ctx.fillText(scramble('РЕГЕНТ НИМБА', T - 1.6, rm, 0.8), W / 2, H - bh - H * 0.2);
      ctx.font = `12px ${MONO}`; ctx.fillStyle = DIM;
      ctx.fillText('x:0.0 z:0.0 · h 7.4m · УКРАДЕННОЕ СОЛНЦЕ', W / 2, H - bh - H * 0.2 + Math.round(H * 0.06) + 12);
      ctx.globalAlpha = 1;
    }
    if (T > D - 0.9) {
      const k = (T - (D - 0.9)) / 0.9;
      ctx.globalAlpha = 1 - k;
      ctx.font = `600 ${Math.round(H * 0.08)}px ${SERIF}`; ctx.fillStyle = STEEL; ctx.textAlign = 'center';
      ctx.fillText('К БОЮ', W / 2, H * 0.52);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';
  }

  function drawResume(ms) {
    const n = Math.ceil(ms / 334);
    ctx.font = `600 ${Math.round(H * 0.09)}px ${SERIF}`; ctx.fillStyle = STEEL; ctx.textAlign = 'center';
    ctx.globalAlpha = 0.9;
    ctx.fillText(String(clamp(n, 1, 3)), W / 2, H * 0.5);
    ctx.font = `12px ${MONO}`; ctx.fillStyle = DIM;
    ctx.fillText('опустите руки · бой продолжится', W / 2, H * 0.5 + 30);
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
  }

  function frame(f) {
    if (disposed) return;
    try {
      const vp = isObj(f.viewport) ? f.viewport : { w: canvas.clientWidth, h: canvas.clientHeight };
      resize(vp.w, vp.h);
      const screen = f.screen;
      const active = screen === 'playing' || screen === 'paused' || screen === 'intro';
      if (!active || !isObj(f.snapshot) || typeof f.project !== 'function') { if (drawn) clearAll(); lastScreen = screen; return; }
      if (screen === 'playing' && lastScreen !== 'playing') playingSince = t;
      lastScreen = screen;
      const rm = !!(f.settings && f.settings.reducedMotion);
      const paused = screen === 'paused';
      const dtR = paused ? 0 : clamp(num(f.dtReal, 0), 0, 0.25);
      t += dtR;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.textBaseline = 'top';
      drawn = true;
      const proj = (p) => { try { return f.project(p); } catch (e) { return null; } };
      const snap = f.snapshot;
      if (!paused) handleEvents(f.events, proj, snap, rm);
      if (screen === 'intro') {
        drawLock(snap, proj, rm, dtR, true);
        drawIntro(isObj(f.intro) ? f.intro : { t: 0, duration: 5 }, rm);
        return;
      }
      if (paused) ctx.globalAlpha = 0.6;
      drawLock(snap, proj, rm, dtR, false);
      drawPois(snap, proj, f.pois);
      drawTelegraphs(snap, proj);
      drawHero(snap, proj, f.input);
      if (!paused) drawStickHud(f.input, snap, dtR, rm);
      drawCombo(snap, dtR, rm);
      drawRune(f.input, rm, dtR);
      drawCoach(f.coach, dtR, rm);
      drawCallouts(dtR, rm);
      drawScreenFx(num(f.timeScale, 1), dtR, rm);
      if (num(f.resumeLeftMs, 0) > 0) drawResume(f.resumeLeftMs);
      if (t - playingSince < 1.2 && playingSince >= 0) {
        ctx.globalAlpha = 1 - (t - playingSince) / 1.2;
        const explore = snap.player && snap.player.encounter === 'explore';
        tag(explore ? 'ПЛАТО · ИДИТЕ К РЕГЕНТУ' : 'БОЙ', W / 2, H * 0.36, GOLD_HI, `600 14px ${MONO}`, 'center');
        ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = 1;
    } catch (e) {
      try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; } catch (e2) { /* ignore */ }
    }
  }

  function reset() {
    callouts.length = 0;
    combo = { n: 0, shown: 0, pop: 0, lost: 0, lostN: 0 };
    rune = { name: '', sub: '', t: 9, trail: null };
    flash.t = 1; hurt.t = 1; dashFx.t = 1; fizzleT = 9; coach = { hint: null, t: 9 }; lock.ok = false; lock.hitFlash = 0;
  }
  function dispose() { disposed = true; clearAll(); }
  return { frame, reset, dispose };
}
