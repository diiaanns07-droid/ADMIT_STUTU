// ASHEN OATH — [ТВИСТ «ОШИБКА»] подсветка ошибки прямо на превью камеры. Отдельный слой: свой canvas
// поверх #ao-overlay в слоте камеры (трекинг-HUD и эффекты рук его не трогают).
//
// Что рисует:
//  - активная подсказка (core/gestureCoach.js getActiveHint): пульсирующие кружки на нужных точках кисти
//    (для «OK» — кончики большого и указательного), пунктир между ними и метка («СОМКНИ»); если кисть
//    не видна — метка у края кадра с той стороны, где должна быть рука;
//  - тренажёр техники: точки условий жеста — зелёные (выполнено) и красные (нет), у красного — метка.
//
// API: createCoachOverlay({ slot }) → { draw(nowMs, frame), clear(), dispose(), canvas }
//   frame = { hands (vision.getHands(): left/right.landmarks — координаты ПОКАЗА), pose (vision.getPose(): frameW/H,
//             landmarks позы НЕзеркальные, mirror), hint (getActiveHint() | null), marks ([{ hand:'left'|'right'|'pose',
//             points:[…], links:[[a,b]], ok, label }] — тренажёр), skeleton (true — демо тренажёра: hands/pose
//             синтетические, рисуются скелетом поверх затемнённого превью), mode: 'mini' | 'full', reducedMotion }
// Без собственного rAF; никогда не бросает исключений.

const MONO = '"Consolas","Cascadia Mono",monospace';
const RED = '#ff5a4a', RED_SOFT = 'rgba(255,90,74,', GREEN = '#5fd28a';
const PLATE = 'rgba(8,6,6,0.78)';

const isObj = (v) => v !== null && typeof v === 'object';
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createCoachOverlay({ slot } = {}) {
  let canvas = null, ctx = null;
  try {
    if (typeof document !== 'undefined' && slot && typeof slot.appendChild === 'function') {
      canvas = document.createElement('canvas');
      canvas.className = 'ao-coach-overlay';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.pointerEvents = 'none';
      slot.appendChild(canvas);
      ctx = canvas.getContext('2d');
    }
  } catch (e) { canvas = null; ctx = null; }
  if (!ctx) return { draw() {}, clear() {}, dispose() {}, canvas: null };
  let drawn = false, W = 0, H = 0;
  let rx = 0, ry = 0, rw = 0, rh = 0, frameW = 640, frameH = 480;

  function wipe() { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; }
  function resize() {
    // слот перемещается между экранами (canvas внутри него) — размер берём каждый кадр
    if (slot && canvas.parentNode !== slot) { try { slot.appendChild(canvas); } catch (e) { /* ignore */ } }
    const cw = canvas.clientWidth | 0, ch = canvas.clientHeight | 0;
    if (cw < 8 || ch < 8) return false;
    const d = clamp(fin(typeof window !== 'undefined' ? window.devicePixelRatio : 1) ? window.devicePixelRatio : 1, 1, 2);
    const bw = Math.round(cw * d), bh = Math.round(ch * d);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    W = cw; H = ch;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // прямоугольник видео при object-fit: contain
    const aspect = frameW / frameH;
    if (W / H > aspect) { rh = H; rw = H * aspect; rx = (W - rw) / 2; ry = 0; } else { rw = W; rh = W / aspect; rx = 0; ry = (H - rh) / 2; }
    return true;
  }
  const px = (p) => rx + p.x * rw, py = (p) => ry + p.y * rh;
  function handPts(hands, side) {
    const h = isObj(hands) ? hands[side] : null;
    const L = h && Array.isArray(h.landmarks) && h.landmarks.length >= 21 ? h.landmarks : null;
    if (!L) return null;
    for (let i = 0; i < 21; i++) if (!isObj(L[i]) || !fin(L[i].x) || !fin(L[i].y)) return null;
    return L;
  }
  function posePts(pose) {
    const L = isObj(pose) && Array.isArray(pose.landmarks) ? pose.landmarks : null;
    if (!L) return null;
    const mir = pose.mirror !== false;
    return L.map((q) => (isObj(q) && fin(q.x) && fin(q.y) && (!fin(q.visibility) || q.visibility >= 0.4) ? { x: mir ? 1 - q.x : q.x, y: q.y } : null));
  }

  function label(text, x, y, color, mini, align = 'center') {
    ctx.font = `700 ${mini ? 9 : 13}px ${MONO}`;
    const w = ctx.measureText(text).width, hgt = mini ? 13 : 19;
    let lx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    lx = clamp(lx, 3, W - w - 7);
    const ly = clamp(y, 2, H - hgt - 2);
    ctx.fillStyle = PLATE; ctx.fillRect(lx - 4, ly, w + 8, hgt);
    ctx.fillStyle = color; ctx.fillRect(lx - 4, ly, 2, hgt);
    ctx.textBaseline = 'top';
    ctx.fillStyle = color; ctx.fillText(text, lx, ly + (mini ? 2 : 3));
  }
  // одна группа отметок: точки, связи и метка
  function mark(L, points, links, ok, text, now, mini, rm) {
    const col = ok ? GREEN : RED;
    const pulse = rm || ok ? 0.5 : 0.5 + 0.5 * Math.sin(now / 140);
    const r0 = mini ? 3.2 : 7;
    let cx = 0, cy = 0, n = 0, top = Infinity;
    // пунктир-связи (например, «сомкни» между кончиками большого и указательного)
    ctx.setLineDash(mini ? [3, 3] : [5, 4]);
    ctx.lineWidth = mini ? 1.5 : 2.5;
    ctx.strokeStyle = col;
    for (const [a, b] of links || []) {
      const A = L[a], B = L[b];
      if (!A || !B) continue;
      ctx.globalAlpha = 0.95;
      ctx.beginPath(); ctx.moveTo(px(A), py(A)); ctx.lineTo(px(B), py(B)); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const i of points || []) {
      const p = L[i];
      if (!p) continue;
      const X = px(p), Y = py(p);
      cx += X; cy += Y; n++; top = Math.min(top, Y);
      // ореол
      ctx.globalAlpha = ok ? 0.25 : 0.18 + 0.22 * pulse;
      ctx.fillStyle = ok ? 'rgba(95,210,138,1)' : RED_SOFT + '1)';
      ctx.beginPath(); ctx.arc(X, Y, r0 * (ok ? 1.6 : 1.5 + 0.9 * pulse), 0, Math.PI * 2); ctx.fill();
      // кольцо
      ctx.globalAlpha = 1;
      ctx.lineWidth = mini ? 1.5 : 2.5;
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.arc(X, Y, r0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(X, Y, mini ? 1.2 : 2.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (n && text) label(text, cx / n, top - (mini ? 18 : 30), col, mini);
    return n > 0;
  }

  // демо тренажёра: кисть/поза скелетом (камеры нет или она не нужна) на затемнённом превью
  const HAND_BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
  const POSE_BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32]];
  function drawSkeleton(hands, pose, mini) {
    ctx.globalAlpha = 0.97;
    ctx.fillStyle = '#07090d';
    ctx.fillRect(rx, ry, rw, rh);
    // лёгкая сетка — «экран распознавания», а не пустота
    ctx.globalAlpha = 0.08; ctx.strokeStyle = '#9fc4ff'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 8; i++) { const x = rx + (rw * i) / 8; ctx.moveTo(x, ry); ctx.lineTo(x, ry + rh); }
    for (let i = 1; i < 6; i++) { const y = ry + (rh * i) / 6; ctx.moveTo(rx, y); ctx.lineTo(rx + rw, y); }
    ctx.stroke();
    ctx.globalAlpha = 1;
    const bones = (L, B, w, col) => {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round';
      ctx.beginPath();
      for (const [a, b] of B) { const A = L[a], Bq = L[b]; if (!A || !Bq) continue; ctx.moveTo(px(A), py(A)); ctx.lineTo(px(Bq), py(Bq)); }
      ctx.stroke();
      ctx.fillStyle = col;
      for (const q of L) if (q) { ctx.beginPath(); ctx.arc(px(q), py(q), w * 0.75, 0, Math.PI * 2); ctx.fill(); }
      ctx.lineCap = 'butt';
    };
    for (const side of ['left', 'right']) { const L = handPts(hands, side); if (L) bones(L, HAND_BONES, mini ? 2 : 3.5, 'rgba(223,232,245,0.82)'); }
    const P = posePts(pose);
    if (P) bones(P, POSE_BONES, mini ? 2 : 4, 'rgba(223,232,245,0.82)');
  }

  function draw(nowMs, f) {
    try {
      const fr = isObj(f) ? f : {};
      const now = fin(nowMs) ? nowMs : 0;
      const pose = isObj(fr.pose) ? fr.pose : null;
      if (pose && fin(pose.frameW) && fin(pose.frameH) && pose.frameW > 0 && pose.frameH > 0) { frameW = pose.frameW; frameH = pose.frameH; }
      const hint = isObj(fr.hint) ? fr.hint : null;
      const marks = Array.isArray(fr.marks) ? fr.marks : null;
      const skel = !!fr.skeleton;
      if (!hint && !(marks && marks.length) && !skel) { if (drawn) wipe(); return; }
      if (!resize()) { if (drawn) wipe(); return; }
      drawn = true;
      const mini = fr.mode === 'mini' || W < 260;
      const rm = !!fr.reducedMotion;
      const hands = fr.hands;
      if (skel) drawSkeleton(hands, pose, mini);
      if (marks && marks.length) {
        let pp = null;
        for (const m of marks) {
          if (!isObj(m)) continue;
          const L = m.hand === 'pose' ? (pp || (pp = posePts(pose))) : handPts(hands, m.hand);
          if (!L) continue;
          mark(L, m.points, m.links, !!m.ok, m.ok ? '' : m.label || '', now, mini, rm);
        }
      }
      if (hint) {
        const sides = hint.hand === 'both' ? ['left', 'right'] : hint.hand === 'left' || hint.hand === 'right' ? [hint.hand] : ['left', 'right'];
        const fade = clamp(fin(hint.life) ? hint.life * 4 : 1, 0, 1);
        ctx.globalAlpha = fade;
        let any = false;
        for (const side of sides) {
          const L = handPts(hands, side);
          if (L && hint.landmarks && hint.landmarks.length) any = mark(L, hint.landmarks, hint.links, false, hint.mark || '', now, mini, rm) || any;
        }
        if (!any && hint.mark) {
          // кисти не видно: метка у края кадра с нужной стороны (на превью правая рука — справа)
          const side = sides.length === 1 ? sides[0] : null;
          const x = side === 'left' ? rx + 6 : side === 'right' ? rx + rw - 6 : rx + rw / 2;
          const word = side === 'left' ? 'ЛЕВАЯ: ' : side === 'right' ? 'ПРАВАЯ: ' : '';
          label(word + hint.mark, x, ry + rh * 0.5, RED, mini, side === 'left' ? 'left' : side === 'right' ? 'right' : 'center');
        }
        // рамка превью краснеет, пока висит подсказка
        ctx.globalAlpha = (rm ? 0.6 : 0.45 + 0.35 * Math.abs(Math.sin(now / 260))) * fade;
        ctx.strokeStyle = RED; ctx.lineWidth = mini ? 2 : 3;
        ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
        ctx.globalAlpha = 1;
      }
      ctx.globalAlpha = 1;
    } catch (e) {
      try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.setLineDash([]); } catch (e2) { /* ignore */ }
    }
  }

  return {
    canvas,
    draw,
    clear() { if (drawn) wipe(); },
    dispose() { try { wipe(); canvas.remove(); } catch (e) { /* ignore */ } },
  };
}
