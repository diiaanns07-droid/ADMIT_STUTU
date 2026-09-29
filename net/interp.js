// ASHEN OATH — буфер интерполяции удалённого героя (№2 [NET]). Чистая логика, тестируется в node.
//
// Пакеты st несут ts по часам отправителя. Задержка «пакет → приём» = recv − ts = смещение часов +
// путь по сети. Минимум этой величины за последние ~3 с — «самый быстрый» пакет, почти без очередей.
// Рисуем соперника в момент renderTs = now − baseDelay − delayMs (по часам отправителя): между двумя
// соседними пакетами — линейная интерполяция, за последним — экстраполяция по скорости до extrapMs,
// дальше стоим. Большой скачок (> snapDist м между соседними пакетами: респаун, раунд) — без
// интерполяции, сразу. Потери до ~delayMs не видны вовсе, длиннее — прикрывает экстраполяция.

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function createInterpBuffer({ delayMs = 100, extrapMs = 220, maxSamples = 40, windowMs = 3000, snapDist = 6, smoothMs = 90 } = {}) {
  const buf = [];          // по возрастанию ts: { ts, x, y, z, yaw, vx, vz, st }
  const delays = [];       // { at, d }
  let base = null;
  // сглаживание коррекций: если экстраполяция ошиблась (пакет потерян во время рывка), скачок
  // переносится в смещение, которое гаснет за ~smoothMs — картинка непрерывна
  const vis = { has: false, rx: 0, rz: 0, ox: 0, oz: 0, t: 0 };
  const out = { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, st: null, ok: false, extrap: 0, behindMs: 0 };

  function push(st, recvMs) {
    if (!st || !st.position || !Number.isFinite(st.ts)) return false;
    const d = recvMs - st.ts;
    // разрыв часов (соперник перезагрузил страницу, вкладка спала > 1,5 с) — начать заново
    if (base !== null && Math.abs(d - base) > 1500) reset();
    const s = { ts: st.ts, x: st.position.x, y: st.position.y, z: st.position.z, yaw: st.yaw, vx: st.velocity ? st.velocity.x : 0, vz: st.velocity ? st.velocity.z : 0, st };
    // по порядку ts (ненадёжный канал может переставить пакеты); дубль — выбросить
    let i = buf.length;
    while (i > 0 && buf[i - 1].ts > s.ts) i--;
    if (i > 0 && buf[i - 1].ts === s.ts) return false;
    buf.splice(i, 0, s);
    if (buf.length > maxSamples) buf.shift();
    // базовая задержка — минимум за окно
    delays.push({ at: recvMs, d });
    while (delays.length && recvMs - delays[0].at > windowMs) delays.shift();
    let m = Infinity;
    for (const x of delays) if (x.d < m) m = x.d;
    base = m;
    return true;
  }

  function sample(nowMs) {
    out.ok = false;
    if (!buf.length || base === null) return out;
    const rt = nowMs - base - delayMs;
    const last = buf[buf.length - 1];
    out.behindMs = nowMs - base - last.ts;
    let a = null, b = null;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].ts <= rt) { a = buf[i]; b = buf[i + 1] || null; break; }
    }
    if (!a) {   // рисуемое время раньше самого старого пакета — берём его
      const f = buf[0];
      set(f, f, 0); out.extrap = 0; out.st = f.st; out.ok = true;
      smooth(nowMs);
      return out;
    }
    if (b) {
      const jump = Math.hypot(b.x - a.x, b.z - a.z) > snapDist;
      const k = jump ? (rt - a.ts < (b.ts - a.ts) / 2 ? 0 : 1) : (rt - a.ts) / Math.max(1, b.ts - a.ts);
      set(a, b, k);
      out.extrap = 0;
      out.st = k < 0.5 ? a.st : b.st;
    } else {
      // за последним пакетом: по скорости, не дальше extrapMs
      const dt = Math.min(extrapMs, rt - a.ts) / 1000;
      out.x = a.x + a.vx * dt; out.y = a.y; out.z = a.z + a.vz * dt;
      out.yaw = a.yaw; out.vx = a.vx; out.vz = a.vz;
      out.extrap = rt - a.ts;
      out.st = a.st;
    }
    // старые пакеты, которые уже никогда не понадобятся
    while (buf.length > 2 && buf[1].ts < rt - 500) buf.shift();
    smooth(nowMs);
    out.ok = true;
    return out;
  }

  function smooth(nowMs) {
    const rx = out.x, rz = out.z;
    if (!vis.has || smoothMs <= 0) { vis.has = true; vis.ox = vis.oz = 0; }
    else {
      const dtS = Math.max(0, (nowMs - vis.t) / 1000);
      const jx = rx - (vis.rx + out.vx * dtS), jz = rz - (vis.rz + out.vz * dtS);
      const j = Math.hypot(jx, jz);
      if (j > snapDist) { vis.ox = vis.oz = 0; }             // телепорт (респаун) — сразу
      else if (j > 0.04) { vis.ox -= jx; vis.oz -= jz; }     // коррекция — плавно
      const k = Math.exp(-(dtS * 1000) / smoothMs);
      vis.ox *= k; vis.oz *= k;
    }
    vis.rx = rx; vis.rz = rz; vis.t = nowMs;
    out.x = rx + vis.ox; out.z = rz + vis.oz;
  }

  function set(a, b, k) {
    out.x = a.x + (b.x - a.x) * k;
    out.y = a.y + (b.y - a.y) * k;
    out.z = a.z + (b.z - a.z) * k;
    out.yaw = a.yaw + wrapPi(b.yaw - a.yaw) * k;
    out.vx = a.vx + (b.vx - a.vx) * k;
    out.vz = a.vz + (b.vz - a.vz) * k;
  }

  function reset() { buf.length = 0; delays.length = 0; base = null; vis.has = false; }

  return {
    push, sample, reset,
    get size() { return buf.length; },
    get baseDelay() { return base; },
    get latest() { return buf.length ? buf[buf.length - 1].st : null; },
  };
}
