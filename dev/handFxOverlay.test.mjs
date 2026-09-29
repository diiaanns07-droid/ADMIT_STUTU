// [HAND] Тест core/handFxOverlay.js на поддельном 2D-контексте: не бросает на любых данных, не чистит и не
// ресайзит чужой canvas, восстанавливает transform/composite, укладывается в бюджет вызовов. node dev/handFxOverlay.test.mjs

import { createHandFxOverlay } from '../core/handFxOverlay.js';
import { buildHandFrame } from '../core/bowGesture.js';
import { makeScene, handAt, obsOf, SHAPES } from './handSynth.mjs';

let pass = 0, fail = 0;
const out = [];
function test(name, fn) {
  try { fn(); pass++; out.push(`PASS ${name}`); }
  catch (e) { fail++; out.push(`FAIL ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };

function mockCanvas() {
  const log = { calls: 0, clearRect: 0, saves: 0, restores: 0 };
  const state = { globalCompositeOperation: 'source-over', globalAlpha: 1 };
  const stack = [];
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'canvas') return canvas;
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (k === 'measureText') return () => ({ width: 10 });
      return (...a) => {
        log.calls++;
        if (k === 'clearRect') log.clearRect++;
        if (k === 'save') { log.saves++; stack.push({ ...t }); }
        if (k === 'restore') { log.restores++; const top = stack.pop(); if (top) Object.assign(t, top); }
      };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  const canvas = { clientWidth: 400, clientHeight: 300, width: 800, height: 600, getContext: () => ctx };
  return { canvas, ctx, log, state };
}
globalThis.document = globalThis.document || { createElement: () => mockCanvas().canvas };
globalThis.window = globalThis.window || { devicePixelRatio: 2 };

const S = makeScene();
const fr = buildHandFrame(obsOf(S, 1000, { left: handAt(S, 'left', -0.42, 0.3, 'fist', { size: 0.1 }), right: handAt(S, 'right', 0.2, -0.3, SHAPES.pinch, { size: 0.08 }) }), S.pose());
const H = (h) => ({ lm: h.D.map((p) => ({ x: p.x / fr.aspect, y: p.y })), center: { x: h.center.x / fr.aspect, y: h.center.y }, pinch: { x: h.pinchPt.x / fr.aspect, y: h.pinchPt.y }, scale: h.scale, shape: h.shape, normal: h.normal });
const hands = { left: H(fr.left), right: H(fr.right) };

test('API и рисование лука/сгустков всех стихий: без исключений, canvas не чистится и не ресайзится', () => {
  const m = mockCanvas();
  const fx = createHandFxOverlay({ canvas: m.canvas });
  ok(typeof fx.draw === 'function' && typeof fx.clear === 'function' && typeof fx.dispose === 'function', 'API');
  const w0 = m.canvas.width, h0 = m.canvas.height;
  for (const q of ['low', 'medium', 'high']) for (const rm of [false, true]) for (const mode of ['mini', 'full']) {
    for (let i = 0; i < 40; i++) {
      const now = 1000 + i * 16;
      fx.draw(now, { hands, bow: { active: true, phase: 'drawing', draw: (i % 20) / 20, aimX: 0.2, aimY: 0.1, charged: i > 30, element: i % 2 ? 'fire' : null, release: i === 35, rain: i === 35 && q === 'high' }, spell: { phase: 'idle' }, settings: { quality: q, reducedMotion: rm }, mode, pose: { frameW: 640, frameH: 480 } });
      for (const el of ['fire', 'storm', 'frost', 'earth']) fx.draw(now, { hands, bow: null, spell: { phase: i === 39 ? 'throw' : i < 4 ? 'form' : 'hold', element: el, power: i / 40, size: i / 40, twoHand: i > 20, dir: { x: 1, y: 0 } }, settings: { quality: q, reducedMotion: rm }, mode });
    }
  }
  ok(m.log.clearRect === 0, `clearRect ${m.log.clearRect}`);
  ok(m.canvas.width === w0 && m.canvas.height === h0, 'canvas ресайзнут');
  ok(m.log.saves === m.log.restores, `save ${m.log.saves} / restore ${m.log.restores}`);
  ok(m.state.globalCompositeOperation === 'source-over', `composite ${m.state.globalCompositeOperation}`);
});
test('мусорные данные не роняют оверлей', () => {
  const m = mockCanvas();
  const fx = createHandFxOverlay({ canvas: m.canvas });
  for (const d of [null, undefined, {}, { hands: null }, { hands: { left: { lm: [] }, right: { lm: [{ x: NaN, y: 1 }] } }, bow: { active: true }, spell: { phase: 'hold', element: 'xx' } }, { hands, bow: { active: true, draw: NaN, aimX: Infinity }, spell: { phase: 'throw', dir: null } }]) fx.draw(2000, d);
  fx.draw(NaN, { hands });
  fx.clear(); fx.dispose(); fx.draw(3000, { hands, bow: { active: true } });
  ok(true);
});
test('бюджет: не больше ~400 вызовов контекста на кадр (medium, лук + сгусток)', () => {
  const m = mockCanvas();
  const fx = createHandFxOverlay({ canvas: m.canvas });
  for (let i = 0; i < 20; i++) fx.draw(1000 + i * 16, { hands, bow: { active: true, phase: 'drawing', draw: 0.8, charged: true, element: 'storm' }, spell: { phase: 'idle' }, settings: { quality: 'medium' }, mode: 'full' });
  const c0 = m.log.calls;
  for (let i = 20; i < 80; i++) fx.draw(1000 + i * 16, { hands, bow: { active: true, phase: 'drawing', draw: 0.8, charged: true, element: 'storm' }, spell: { phase: 'idle' }, settings: { quality: 'medium' }, mode: 'full' });
  const per = (m.log.calls - c0) / 60;
  console.log(`  вызовов контекста на кадр: ${per.toFixed(0)}`);
  ok(per <= 400, `${per}`);
});

for (const l of out) console.log(l);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
