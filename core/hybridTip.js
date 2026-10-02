// ASHEN OATH — подсказка про гибридный ноутбук [PERF]. Владелец: №1.
// Chrome на ноутбуке с двумя видеокартами часто работает на встроенной (страница выбрать дискретную не может),
// и MediaPipe вместе с игрой не успевает. Если видеокарта встроенная и распознавание медленнее tipMinHz дольше
// tipHoldMs (core/visionPlan.js), на экранах камеры, калибровки и обучения показывается небольшая ненавязчивая
// карточка с путём к настройке Windows. «Понятно» — больше не показывать (localStorage). На дискретной — никогда.
//
// createHybridTip({ root, storage? }) → { update(now, { gpuClass, hz, cameraFps, screen }), get shown, get dismissed, dispose() }

import { hybridTipDue, HYBRID_TIP_TEXT } from './visionPlan.js';

export const HYBRID_TIP_KEY = 'ashen-oath.hybridTip.v1';
const SCREENS = new Set(['camera', 'calibration', 'tutorial']);

export function createHybridTip({ root, storage } = {}) {
  const doc = root && root.ownerDocument ? root.ownerDocument : (typeof document !== 'undefined' ? document : null);
  const st = storage !== undefined ? storage : (typeof localStorage !== 'undefined' ? localStorage : null);
  let dismissed = false;
  try { dismissed = !!(st && st.getItem(HYBRID_TIP_KEY) === '1'); } catch (e) { dismissed = false; }
  if (!doc || !root) return { update() {}, get shown() { return false; }, get dismissed() { return dismissed; }, dispose() {} };
  const el = doc.createElement('div');
  el.className = 'ao-hybrid-tip';
  el.setAttribute('role', 'note');
  el.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:18px', 'transform:translateX(-50%)', 'z-index:61', 'max-width:min(620px,calc(100vw - 32px))',
    'display:none', 'gap:12px', 'align-items:center', 'padding:10px 14px', 'border-radius:8px',
    'font:13px/1.4 system-ui,"Segoe UI",sans-serif', 'color:#efe6d0', 'background:rgba(14,12,16,0.86)',
    'border:1px solid rgba(200,164,90,0.5)', 'box-shadow:0 6px 24px rgba(0,0,0,0.45)', 'pointer-events:auto',
  ].join(';');
  const text = doc.createElement('span');
  text.textContent = HYBRID_TIP_TEXT;
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Понятно';
  btn.style.cssText = 'flex:0 0 auto;padding:6px 12px;border-radius:6px;border:1px solid rgba(200,164,90,0.6);background:rgba(200,164,90,0.16);color:#f3e6c4;font:600 13px system-ui,sans-serif;cursor:pointer';
  btn.addEventListener('click', () => { dismissed = true; try { if (st) st.setItem(HYBRID_TIP_KEY, '1'); } catch (e) { /* ignore */ } el.style.display = 'none'; });
  el.append(text, btn);
  root.appendChild(el);
  const due = { since: null };
  let shown = false, latched = false;
  const api = {
    update(now, v = {}) {
      if (dismissed) { if (shown) { shown = false; el.style.display = 'none'; } return; }
      if (hybridTipDue(now, { gpuClass: v.gpuClass, hz: v.hz, cameraFps: v.cameraFps, dismissed }, due)) latched = true;
      const want = latched && SCREENS.has(v.screen);
      if (want !== shown) { shown = want; el.style.display = shown ? 'flex' : 'none'; }
      if (!SCREENS.has(v.screen)) latched = latched && v.screen !== 'playing';   // в бою подсказка не нужна; вернулись к камере — снова
    },
    get shown() { return shown; },
    get dismissed() { return dismissed; },
    dispose() { try { el.remove(); } catch (e) { /* ignore */ } },
  };
  return api;
}
