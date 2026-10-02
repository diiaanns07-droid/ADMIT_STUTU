// ASHEN OATH — панель «Производительность и трекинг» [PERF]. Владелец: №1.
// F3 (или ?perf=1 в адресе) — показать/скрыть. Только чтение: кадры рендера, автоподстройка,
// камера и распознавание. Ничего не отправляет и не пишет кадры.
//
// createPerfHud({ root, storage? }) → { update(now, { perf, tracking, screen, extra? }), toggle(), get visible, dispose() }

const TIER_RU = { low: 'низкое', medium: 'среднее', high: 'высокое' };
const CLASS_RU = { discrete: 'дискретная', integrated: 'встроенная', 'integrated-strong': 'встроенная (мощная)', software: 'программный рендер', unknown: 'неизвестная' };
const VIS_KEY = 'ashen-oath.perfhud.v1';

const f1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '—');
const f0 = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : '—');
function shortGpu(s) {
  const m = /ANGLE \([^,]+,\s*([^(]+?)(?:\s*\(0x[0-9a-f]+\))?\s*(?:Direct3D|OpenGL|Metal|Vulkan|,|\))/i.exec(String(s || ''));
  return (m ? m[1] : String(s || '—')).replace(/\s+/g, ' ').trim().slice(0, 42);
}
// «светофор» распознавания: доля кадров камеры, которые успевает MediaPipe
function grade(hz, camFps) {
  if (!(hz > 0)) return ['—', ''];
  const need = Math.min(30, camFps > 0 ? camFps : 30);
  const r = hz / need;
  return r >= 0.85 ? ['успевает', 'ok'] : r >= 0.6 ? ['не успевает часть кадров', 'warn'] : ['сильно отстаёт', 'bad'];
}

export function createPerfHud({ root, storage } = {}) {
  const doc = root && root.ownerDocument ? root.ownerDocument : (typeof document !== 'undefined' ? document : null);
  if (!doc || !root) return { update() {}, toggle() {}, get visible() { return false; }, dispose() {} };
  const st = storage !== undefined ? storage : (typeof localStorage !== 'undefined' ? localStorage : null);
  const el = doc.createElement('div');
  el.className = 'ao-perfhud';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'off');
  el.style.cssText = [
    'position:fixed', 'left:12px', 'top:12px', 'z-index:60', 'pointer-events:none',
    'font:12px/1.45 ui-monospace,Consolas,monospace', 'color:#e8e2d0', 'background:rgba(12,10,14,0.78)',
    'border:1px solid rgba(200,164,90,0.45)', 'border-radius:6px', 'padding:8px 10px', 'max-width:min(560px,calc(100vw - 24px))',
    'white-space:pre-wrap', 'box-shadow:0 4px 18px rgba(0,0,0,0.4)', 'display:none',
  ].join(';');
  root.appendChild(el);
  let visible = false;
  try { visible = (typeof location !== 'undefined' && /[?&]perf=1/.test(location.search)) || (st && st.getItem(VIS_KEY) === '1'); } catch (e) { visible = false; }
  let lastT = -1e9;
  const apply = () => { el.style.display = visible ? 'block' : 'none'; };
  apply();
  const onKey = (e) => {
    if (e.code !== 'F3' || e.repeat) return;
    e.preventDefault();
    api.toggle();
  };
  if (typeof window !== 'undefined') window.addEventListener('keydown', onKey);

  const api = {
    get visible() { return visible; },
    toggle() {
      visible = !visible;
      apply();
      try { if (st) st.setItem(VIS_KEY, visible ? '1' : '0'); } catch (e) { /* ignore */ }
      lastT = -1e9;
    },
    update(now, data) {
      if (!visible || now - lastT < 250) return;
      lastT = now;
      const p = (data && data.perf) || null;
      const t = (data && data.tracking) || null;
      const d = (t && t.debug) || {};
      const lines = [];
      lines.push('ПРОИЗВОДИТЕЛЬНОСТЬ  [F3 — скрыть]');
      if (p) {
        lines.push(`Кадры: ${f0(p.fps)} к/с · предел ${f0(p.capFps)}${p.refreshHz ? ` (экран ${f0(p.refreshHz)} Гц)` : ''}${p.lowMode ? ' · режим 30' : ''}`);
        lines.push(`GPU ${p.gpuTimer ? f1(p.gpuMs) + ' мс' : 'н/д'} · JS ${f1(p.cpuMs)} мс · бюджет ${f1(p.capFps ? 1000 / p.capFps : null)} мс`);
        lines.push(`Качество: ${TIER_RU[p.tier] || p.tier}${p.auto ? ' (авто)' : ' (вручную)'} · разрешение ${Math.round((p.scale || 1) * 100)}%`);
        lines.push(`Видеокарта: ${shortGpu(p.gpu)} — ${CLASS_RU[p.gpuClass] || p.gpuClass}${p.cores ? ` · ядер ${p.cores}` : ''}`);
      }
      lines.push('');
      lines.push('ТРЕКИНГ');
      if (!t || t.status === 'idle') lines.push('Камера выключена');
      else {
        const v = d.video || {};
        const [g, cls] = grade(d.inferenceHz, d.cameraFps);
        lines.push(`Камера: ${v.w || '—'}×${v.h || '—'} · ${f0(d.cameraFps)} к/с${d.cameraFallback ? ' · понижена' : ''}`);
        lines.push(`Распознавание: ${f0(d.inferenceHz)} Гц (${g}) · ${f1(d.inferMs)} мс · задержка ${f0(d.latencyMs)} мс`);
        lines.push(`Модель позы: ${d.poseModel || '—'} · ${t.mode || '—'}/${t.delegate || '—'} · кисти: ${t.hands && t.hands.ready ? 'да' : 'нет'}`);
        const rel = d.reliability || {};
        const state = t.status === 'lost' ? 'ПОТЕРЯН' : rel.handsKeepAlive ? 'плечи закрыты — держимся за кисти' : t.status === 'calibrating' ? 'калибровка' : t.calibrated ? 'уверенно' : 'нет калибровки';
        lines.push(`Состояние: ${state} · плечи ${f0(rel.conf != null ? rel.conf * 100 : null)}%${rel.scaleWarning ? ` · ${rel.scaleWarning === 'far' ? 'далеко' : 'близко'}` : ''}`);
        const c = d.counters || {};
        if (c.rebaselines || c.keptAlive || c.reacquired) lines.push(`Калибровка обновлялась сама: ${c.rebaselines || 0} · удержаний по кистям: ${c.keptAlive || 0} · потерь: ${c.reacquired || 0}`);
        if (cls === 'bad') lines.push('Совет: закройте тяжёлые вкладки/программы; добавьте света на лицо и руки');
      }
      if (p && p.log && p.log.length) lines.push('', 'Подстройка: ' + p.log.slice(-3).map((l) => l.text).join(' · '));
      // [W3-SQUAT] строки экрана (приседания): массив или функция — она зовётся только при обновлении панели (раз в 250 мс)
      const extra = data && (typeof data.extra === 'function' ? data.extra() : data.extra);
      if (Array.isArray(extra) && extra.length) lines.push('', ...extra);
      el.textContent = lines.join('\n');
    },
    dispose() {
      if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
      try { el.remove(); } catch (e) { /* ignore */ }
    },
  };
  return api;
}
