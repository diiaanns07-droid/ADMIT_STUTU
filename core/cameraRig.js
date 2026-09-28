// Камера третьего лица (ASHEN_V2). Владелец: №1 / роль №22.
// Чистая математика без THREE: main.js применяет результат к THREE.PerspectiveCamera,
// а tools/qa_node.mjs проверяет соответствие moveX экранному направлению.
//
// Два режима:
//  • engaged (герой в арене, lock-on): камера позади героя на луче «босс → герой», выше плеча и
//    со сдвигом вправо (over-the-shoulder). Сглаживается ОРБИТАЛЬНЫЙ УГОЛ, а не позиция, поэтому
//    при быстром рывке камера не срезает путь сквозь босса.
//  • explore (открытая карта): камера за спиной героя. Мыши нет — управляют только руки, поэтому
//    после ~0.6 с устойчивого бега камера сама доворачивает за направление движения (бег «на камеру»
//    её не разворачивает). Стоишь — камера не крутится.
// Переход между режимами ≈ 0.6 с. Коллизия камеры — по кругам раскладки карты (без raycast):
// колонна между героем и камерой подтягивает камеру к герою.
//
// update(dt, state) → { position, target, right, forward, yaw }
//   state = { player:{x,y,z}, playerYaw, velocity:{x,z}, boss:{x,y,z}, engaged, impulse:{x,y,z}, colliders, groundY? }
//   colliders — круги и отрезки раскладки; groundY(x,z) — высота земли (камера держится над ней).
// Совместимость V1: update(dt, player, boss, impulse) — это engaged.

const TAU = Math.PI * 2;

function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
function damp(current, target, sharpness, dt) {
  return current + (target - current) * (1 - Math.exp(-sharpness * dt));
}
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

export function createCameraRig(cfg) {
  const E = {
    followDistance: 4.6, followHeight: 2.35, followShoulder: 0.55, lookAhead: 2.2, lookHeight: 1.45,
    alignDelay: 0.6, alignSharpness: 1.6, alignMinSpeed: 1.2, alignMaxDiffDeg: 125,
    blendTime: 0.6, collisionMargin: 0.35, groundClearance: 0.9,
    ...(cfg && cfg.explore ? cfg.explore : {}),
  };
  const s = {
    angle: 0,           // engaged: atan2(x, z) направления «босс → герой»
    distance: cfg.distance,
    heading: 0,         // explore: yaw «вперёд» камеры
    steady: 0, lastMoveDir: null,
    blend: 1,           // 1 — engaged, 0 — explore
    initialized: false,
    lastYaw: 0,
  };

  // Экранный «вправо» для угла a: касательная к окружности в сторону роста угла.
  // pos(a) = (R sin a, 0, R cos a) ⇒ d/da = (cos a, 0, -sin a).
  function rightVector(a) {
    return { x: Math.cos(a), y: 0, z: -Math.sin(a) };
  }

  function computeTarget(player, boss) {
    const dx = player.x - boss.x;
    const dz = player.z - boss.z;
    const dist = Math.hypot(dx, dz);
    const angle = dist > 1e-4 ? Math.atan2(dx, dz) : s.angle;
    // Чем ближе герой к боссу, тем дальше отъезжает камера, чтобы босс влез в кадр.
    const want = cfg.distance + (6 - Math.min(dist, 8)) * 0.18;
    const distance = Math.max(cfg.minDistance, Math.min(cfg.maxDistance, want));
    return { angle, distance, bossDist: dist };
  }

  function normState(a, b, c) {
    if (a && a.player) return a;
    return { player: a, boss: b, impulse: c, engaged: true };
  }

  function reset(a, b) {
    const st = normState(a, b);
    const player = st.player || { x: 0, y: 0, z: 6 }, boss = st.boss || { x: 0, y: 0, z: 0 };
    const t = computeTarget(player, boss);
    s.angle = t.angle;
    s.distance = t.distance;
    const engaged = st.engaged !== false;
    s.blend = engaged ? 1 : 0;
    s.heading = engaged ? wrapAngle(t.angle + Math.PI) : (fin(st.playerYaw) ? st.playerYaw : wrapAngle(t.angle + Math.PI));
    s.steady = 0; s.lastMoveDir = null;
    s.initialized = true;
  }

  function lockOn(dt, player, boss) {
    const t = computeTarget(player, boss);
    const dA = wrapAngle(t.angle - s.angle);
    s.angle = wrapAngle(s.angle + dA * (1 - Math.exp(-cfg.angleSharpness * dt)));
    s.distance = damp(s.distance, t.distance, cfg.distSharpness, dt);
    const back = { x: Math.sin(s.angle), z: Math.cos(s.angle) }; // от босса к герою
    const right = rightVector(s.angle);
    // Опорная точка — проекция героя на сглаженный луч, чтобы шум позиции не тряс камеру.
    const r = Math.max(0.5, t.bossDist);
    const anchor = { x: boss.x + back.x * r, z: boss.z + back.z * r };
    const pos = {
      x: anchor.x + back.x * s.distance + right.x * cfg.shoulderOffset,
      y: cfg.height + (player.y || 0),
      z: anchor.z + back.z * s.distance + right.z * cfg.shoulderOffset,
    };
    const b = cfg.lookBias;
    // Точка взгляда сдвинута вправо на часть плечевого сдвига: герой уходит в левую
    // половину кадра, торс босса остаётся над его плечом и не перекрывается.
    const ls = cfg.shoulderOffset * (cfg.lookShoulder || 0);
    const target = {
      x: anchor.x + (boss.x - anchor.x) * b + right.x * ls,
      y: cfg.lookHeightPlayer + (cfg.lookHeightBoss - cfg.lookHeightPlayer) * b + (player.y || 0) * (1 - b),
      z: anchor.z + (boss.z - anchor.z) * b + right.z * ls,
    };
    return { pos, target, yaw: wrapAngle(s.angle + Math.PI) };
  }

  function follow(dt, player, vel) {
    const sp = vel ? Math.hypot(vel.x || 0, vel.z || 0) : 0;
    if (sp >= E.alignMinSpeed) {
      const md = Math.atan2(vel.x, vel.z);
      const diff = Math.abs(wrapAngle(md - s.heading)) * 180 / Math.PI;
      const turnDelta = s.lastMoveDir === null ? 0 : Math.abs(wrapAngle(md - s.lastMoveDir)) * 180 / Math.PI;
      s.steady = turnDelta < 25 * Math.max(dt * 60, 1) ? s.steady + dt : 0;
      s.lastMoveDir = md;
      if (s.steady >= E.alignDelay && diff <= E.alignMaxDiffDeg) {
        s.heading = wrapAngle(s.heading + wrapAngle(md - s.heading) * (1 - Math.exp(-E.alignSharpness * dt)));
      }
    } else { s.steady = 0; s.lastMoveDir = null; }
    const f = { x: Math.sin(s.heading), z: Math.cos(s.heading) };
    const right = { x: -f.z, z: f.x };
    const pos = {
      x: player.x - f.x * E.followDistance + right.x * E.followShoulder,
      y: (player.y || 0) + E.followHeight,
      z: player.z - f.z * E.followDistance + right.z * E.followShoulder,
    };
    const target = { x: player.x + f.x * E.lookAhead, y: (player.y || 0) + E.lookHeight, z: player.z + f.z * E.lookAhead };
    return { pos, target, yaw: s.heading };
  }

  // Круги раскладки между героем и камерой подтягивают камеру к герою.
  function collide(player, pos, colliders) {
    if (!Array.isArray(colliders) || !colliders.length) return pos;
    const ax = player.x, az = player.z;
    const dx = pos.x - ax, dz = pos.z - az;
    const L = Math.hypot(dx, dz);
    if (L < 1e-4) return pos;
    let tMin = 1;
    for (const c of colliders) {
      if (c && c.type === 'segment') {
        // [ASHEN_V3] стены: выборка по лучу (отрезок-капсула); стена, в которой стоит герой, не в счёт
        const R = (c.r || 0) + E.collisionMargin;
        const ex = c.bx - c.ax, ez = c.bz - c.az, L2 = ex * ex + ez * ez || 1;
        const segD = (x, z) => { const u = Math.max(0, Math.min(1, ((x - c.ax) * ex + (z - c.az) * ez) / L2)); return Math.hypot(x - c.ax - ex * u, z - c.az - ez * u); };
        const mx = Math.min(c.ax, c.bx) - R, Mx = Math.max(c.ax, c.bx) + R, mz = Math.min(c.az, c.bz) - R, Mz = Math.max(c.az, c.bz) + R;
        if (Math.max(ax, pos.x) < mx || Math.min(ax, pos.x) > Mx || Math.max(az, pos.z) < mz || Math.min(az, pos.z) > Mz) continue;
        if (segD(ax, az) < R) continue;
        for (let i = 1; i <= 12; i++) {
          const t = i / 12;
          if (t >= tMin) break;
          if (segD(ax + dx * t, az + dz * t) < R) { tMin = Math.max(0, t - 1 / 12); break; }
        }
        continue;
      }
      if (!c || c.type !== 'circle') continue;
      const R = c.r + E.collisionMargin;
      const fx = ax - c.x, fz = az - c.z;
      const A = dx * dx + dz * dz, B = 2 * (fx * dx + fz * dz), C = fx * fx + fz * fz - R * R;
      if (C < 0) continue; // герой сам внутри поля — игнор
      const disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      const t = (-B - Math.sqrt(disc)) / (2 * A);
      if (t > 0 && t < tMin) tMin = t;
    }
    if (tMin >= 1) return pos;
    const k = Math.max(0.35, tMin - 0.02);
    return { x: ax + dx * k, y: pos.y + (1 - k) * 0.6, z: az + dz * k };
  }

  /**
   * @returns {{position:{x,y,z}, target:{x,y,z}, right:{x,y,z}, forward:{x,y,z}, yaw:number}}
   */
  function update(dt, a, b, c) {
    const st = normState(a, b, c);
    const player = st.player, boss = st.boss || { x: 0, y: 0, z: 0 };
    if (!s.initialized) reset(st);
    const engaged = st.engaged !== false;
    const bt = Math.max(0.05, E.blendTime);
    s.blend = Math.max(0, Math.min(1, s.blend + (engaged ? dt : -dt) / bt));
    const w = s.blend * s.blend * (3 - 2 * s.blend);
    const L = lockOn(dt, player, boss);
    // в бою heading тянется за lock-on, чтобы выход в explore начинался с того же ракурса
    if (w > 0.999) { s.heading = L.yaw; s.steady = 0; }
    const F = w < 0.999 ? follow(dt, player, st.velocity) : null;
    const lerp = (p, q, k) => p + (q - p) * k;
    let pos = F ? { x: lerp(F.pos.x, L.pos.x, w), y: lerp(F.pos.y, L.pos.y, w), z: lerp(F.pos.z, L.pos.z, w) } : L.pos;
    const target = F ? { x: lerp(F.target.x, L.target.x, w), y: lerp(F.target.y, L.target.y, w), z: lerp(F.target.z, L.target.z, w) } : L.target;

    // V1: не выходить за кольцо стен арены в lock-on (прижать к радиусу и приподнять)
    if (engaged && fin(cfg.maxRadiusFromCenter) && !st.colliders) {
      const rc = Math.hypot(pos.x - boss.x, pos.z - boss.z);
      if (rc > cfg.maxRadiusFromCenter) {
        const k = cfg.maxRadiusFromCenter / rc;
        pos = { x: boss.x + (pos.x - boss.x) * k, y: pos.y + (rc - cfg.maxRadiusFromCenter) * 0.5, z: boss.z + (pos.z - boss.z) * k };
      }
    }
    pos = collide(player, pos, st.colliders);
    // [ASHEN_V3] рельеф большой карты: камера не уходит под землю на склонах (state.groundY — функция раскладки)
    if (typeof st.groundY === 'function') {
      let gy = NaN;
      try { gy = Number(st.groundY(pos.x, pos.z)); } catch (e) { gy = NaN; }
      const minY = gy + E.groundClearance;
      if (Number.isFinite(minY) && pos.y < minY) pos = { x: pos.x, y: minY, z: pos.z };
    }

    const lim = cfg.maxImpulse;
    const clamp = (v) => Math.max(-lim, Math.min(lim, v || 0));
    const imp = st.impulse;
    const ix = clamp(imp && imp.x), iy = clamp(imp && imp.y), iz = clamp(imp && imp.z);

    let fx = target.x - pos.x, fz = target.z - pos.z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;
    const yaw = Math.atan2(fx, fz);
    s.lastYaw = yaw;
    return {
      position: { x: pos.x + ix, y: pos.y + iy, z: pos.z + iz },
      target,
      right: { x: -fz, y: 0, z: fx },
      forward: { x: fx, y: 0, z: fz },
      yaw,
    };
  }

  return { update, reset, rightVector, get angle() { return s.angle; }, get yaw() { return s.lastYaw; }, get blend() { return s.blend; } };
}
