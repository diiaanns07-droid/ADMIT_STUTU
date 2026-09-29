// ASHEN OATH — упаковка состояния для сети (№2 [NET]). Чистые функции без DOM: тестируются в node.
//
// st (20 Гц, ненадёжно) — состояние своего героя из combat.getSnapshot().player + input.bow/handSpell (C2):
//   { s: seq, ts: мс по моим часам, p:[x,y,z], y: yaw, v:[vx,vz], h, H, e, E, a: action, l: locomotion,
//     f: флаги, b: burstCharge, c:[kind,size,charge], d:[dx,dz] (рывок), bw:[draw,aimX,aimY,charged,element],
//     hs:[phase,element,power,dx,dy], sp: sprint }
// ev (надёжно) — локальные события боя, нужные сопернику для картинки: { e: {id,type,position,data} }.
// pr (10 Гц, ненадёжно) — свои снаряды (owner 'player'): { ts, l: [[id,kind,x,y,z,vx,vy,vz,r,extra]] }.

const r2 = (v) => Math.round((+v || 0) * 100) / 100;
const r3 = (v) => Math.round((+v || 0) * 1000) / 1000;
const r1 = (v) => Math.round((+v || 0) * 10) / 10;
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const F = { shielding: 1, invulnerable: 2, dashing: 4, cruise: 8, warded: 16, bastion: 32, stunned: 64, slowed: 128, dead: 256, lockedOn: 512 };
const HS_PHASES = ['idle', 'form', 'hold', 'throw'];

export function encodeState(P, input, seq, ts) {
  if (!P || !P.position) return null;
  let f = 0;
  if (P.shielding) f |= F.shielding;
  if (P.invulnerable) f |= F.invulnerable;
  if (P.dashing) f |= F.dashing;
  if (P.cruise) f |= F.cruise;
  if (P.warded) f |= F.warded;
  if (P.bastion) f |= F.bastion;
  if (P.stunned) f |= F.stunned;
  if (P.slowed) f |= F.slowed;
  if (P.action === 'dead') f |= F.dead;
  if (P.lockedOn) f |= F.lockedOn;
  const v = P.velocity || {};
  const o = {
    s: seq | 0, ts: Math.round(num(ts)),
    p: [r2(P.position.x), r2(P.position.y), r2(P.position.z)],
    y: r3(P.yaw),
    v: [r2(v.x), r2(v.z)],
    h: r1(P.hp), H: r1(P.maxHp), e: r1(P.energy), E: r1(P.maxEnergy),
    a: typeof P.action === 'string' ? P.action : 'idle',
    l: typeof P.locomotion === 'string' ? P.locomotion : 'idle',
    f,
  };
  if (num(P.sprint) > 0) o.sp = r2(P.sprint);
  if (num(P.burstCharge) > 0.01) o.b = r2(P.burstCharge);
  if (P.conjure && typeof P.conjure === 'object') o.c = [String(P.conjure.kind || 'orb'), r2(P.conjure.size), r2(P.conjure.charge)];
  if (P.dashing && P.dashDir && typeof P.dashDir === 'object') o.d = [r2(P.dashDir.x), r2(P.dashDir.z)];
  const bow = input && input.bow;
  if (bow && bow.active) o.bw = [r2(bow.draw), r2(bow.aimX), r2(bow.aimY), bow.charged ? 1 : 0, bow.element || 0];
  const hs = input && input.handSpell;
  if (hs && hs.phase && hs.phase !== 'idle') {
    o.hs = [Math.max(0, HS_PHASES.indexOf(hs.phase)), hs.element || 'fire', r2(hs.power), r2(hs.dir && hs.dir.x), r2(hs.dir && hs.dir.y)];
  }
  return o;
}

// → объект в форме snapshot.player (+ ts, seq, bow, handSpell) для remotePlayer и snap.opponent
export function decodeState(m) {
  if (!m || !Array.isArray(m.p) || m.p.length < 3) return null;
  const f = m.f | 0;
  const vx = num(m.v && m.v[0]), vz = num(m.v && m.v[1]);
  const out = {
    seq: m.s | 0, ts: num(m.ts),
    position: { x: num(m.p[0]), y: num(m.p[1]), z: num(m.p[2]) },
    yaw: num(m.y),
    velocity: { x: vx, z: vz }, speed: Math.hypot(vx, vz),
    hp: num(m.h), maxHp: num(m.H, 100), energy: num(m.e), maxEnergy: num(m.E, 100),
    action: typeof m.a === 'string' ? m.a : 'idle',
    locomotion: typeof m.l === 'string' ? m.l : 'idle',
    shielding: !!(f & F.shielding), invulnerable: !!(f & F.invulnerable), dashing: !!(f & F.dashing),
    cruise: !!(f & F.cruise), warded: !!(f & F.warded), bastion: !!(f & F.bastion),
    stunned: !!(f & F.stunned), slowed: !!(f & F.slowed), dead: !!(f & F.dead), lockedOn: !!(f & F.lockedOn),
    sprint: num(m.sp), burstCharge: num(m.b),
    conjure: Array.isArray(m.c) ? { kind: String(m.c[0]), size: num(m.c[1]), charge: num(m.c[2]) } : null,
    dashDir: Array.isArray(m.d) ? { x: num(m.d[0]), z: num(m.d[1]) } : null,
    bow: Array.isArray(m.bw) ? { active: true, draw: num(m.bw[0]), aimX: num(m.bw[1]), aimY: num(m.bw[2]), charged: !!m.bw[3], release: false, element: m.bw[4] || null } : null,
    handSpell: Array.isArray(m.hs) ? { phase: HS_PHASES[m.hs[0] | 0] || 'idle', element: String(m.hs[1] || 'fire'), power: num(m.hs[2]), dir: { x: num(m.hs[3]), y: num(m.hs[4]) } } : null,
  };
  return out;
}

// События, которые сопернику нужны для картинки (C3 + боевые события героя)
export const NET_EVENT_TYPES = new Set([
  'player_cast', 'player_slash', 'player_dash', 'shield_start', 'shield_end', 'parry', 'burst',
  'rune_cast', 'sigil_cast', 'rune_hit', 'sigil_hit', 'projectile_reflected', 'projectile_impact',
  'ward_start', 'ward_end', 'bastion_start', 'bastion_end',
  'bow_draw_start', 'bow_release', 'arrow_hit',
  'hand_spell_form', 'hand_spell_throw', 'hand_spell_hit', 'hand_spell_cancel',
]);

function compact(v, depth = 0) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
  if (depth > 3) return undefined;
  if (Array.isArray(v)) return v.length > 24 ? undefined : v.map((x) => compact(x, depth + 1));
  const o = {};
  for (const k in v) { const c = compact(v[k], depth + 1); if (c !== undefined) o[k] = c; }
  return o;
}

// Своё событие → пакет ev (или null, если сопернику оно не нужно)
export function encodeEvent(e) {
  if (!e || !NET_EVENT_TYPES.has(e.type)) return null;
  if (e.data && e.data.remote) return null;          // чужое эхо обратно не шлём
  // удары по боссу/снаряды босса сопернику не нужны; свои снаряды — нужны
  if (e.type === 'projectile_impact' && e.data && e.data.owner && e.data.owner !== 'player') return null;
  return { id: String(e.id), type: e.type, position: compact(e.position), data: compact(e.data || {}) };
}

// Пакет ev → событие в общий массив: id с префиксом, data.remote = true (C3), снаряды — с префиксом 'r:'
export function decodeEvent(m) {
  const e = m && m.e;
  if (!e || typeof e.type !== 'string' || !NET_EVENT_TYPES.has(e.type)) return null;
  const data = e.data && typeof e.data === 'object' ? { ...e.data } : {};
  data.remote = true;
  if (data.projectileId !== undefined && data.projectileId !== null) data.projectileId = `r:${data.projectileId}`;
  if (data.owner === 'player') data.owner = 'opponent';
  const p = e.position && typeof e.position === 'object' ? { x: num(e.position.x), y: num(e.position.y), z: num(e.position.z) } : { x: 0, y: 0, z: 0 };
  return { id: `r-${e.id}`, type: e.type, position: p, data };
}

// Свои снаряды → pr
export function encodeProjectiles(list, ts) {
  const l = [];
  if (Array.isArray(list)) {
    for (const pr of list) {
      if (!pr || pr.owner !== 'player' || !pr.position) continue;
      const v = pr.velocity || {};
      const extra = {};
      if (pr.element) extra.el = pr.element;
      if (pr.size !== undefined) extra.sz = r2(pr.size);
      if (pr.power !== undefined) extra.pw = r2(pr.power);
      if (pr.reflected) extra.rf = 1;
      l.push([String(pr.id), String(pr.kind || 'bolt'), r2(pr.position.x), r2(pr.position.y), r2(pr.position.z), r2(v.x), r2(v.y), r2(v.z), r2(pr.radius || 0.3), extra]);
      if (l.length >= 24) break;
    }
  }
  return { ts: Math.round(num(ts)), l };
}

export function decodeProjectiles(m) {
  if (!m || !Array.isArray(m.l)) return [];
  const out = [];
  for (const a of m.l) {
    if (!Array.isArray(a) || a.length < 9) continue;
    const x = a[9] && typeof a[9] === 'object' ? a[9] : {};
    const o = {
      id: `r:${a[0]}`, owner: 'opponent', remote: true, kind: String(a[1]),
      position: { x: num(a[2]), y: num(a[3]), z: num(a[4]) },
      velocity: { x: num(a[5]), y: num(a[6]), z: num(a[7]) }, radius: num(a[8], 0.3),
    };
    if (x.el) o.element = x.el;
    if (x.sz !== undefined) o.size = num(x.sz);
    if (x.pw !== undefined) o.power = num(x.pw);
    if (x.rf) o.reflected = true;
    out.push(o);
  }
  return out;
}
