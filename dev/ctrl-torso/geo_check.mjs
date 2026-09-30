process.argv = ['x', 'x', '--only=ZZZ'];
const { bodyPoints, project } = await import('./torso_joy_sim.mjs');
const D2R = Math.PI / 180, A = 4 / 3;
function W(p) {
  const b = bodyPoints(p); const P = (k) => { const q = project(b[k]); return { X: q.x * A, Y: q.y }; };
  const Sr = P('rs'), Sl = P('ls'), Er = P('re'), El = P('le'), N = P('nose');
  const ws = Math.hypot(Sl.X - Sr.X, Sl.Y - Sr.Y), we = Math.hypot(El.X - Er.X, El.Y - Er.Y), c0 = A / 2;
  const smx = (Sr.X + Sl.X) / 2, emx = (Er.X + El.X) / 2;
  return { rho: Math.atan2(-(Sl.Y - Sr.Y), Sl.X - Sr.X) / D2R, sx: (smx - c0) / ws, ex: (emx - c0) / ws, ws, we, off: (N.X - emx) / we, shY: (Sr.Y + Sl.Y) / 2, earY: (Er.Y + El.Y) / 2 };
}
const b0 = W({});
console.log('нейтраль: ширина плеч', b0.ws.toFixed(3), 'высот кадра; уши', b0.we.toFixed(3), '; плечи y', b0.shY.toFixed(3), 'уши y', b0.earY.toFixed(3));
const cases = { 'вбок 12°': { lat: 12 }, 'вбок 7°': { lat: 7 }, 'вбок 22° (уклон)': { lat: 22 }, 'вперёд 15°': { fwd: 15 }, 'вперёд 22°': { fwd: 22 }, 'назад 9°': { fwd: -9 }, 'назад 13°': { fwd: -13 },
  'пожать плечом 4 см': { shrugR: 0.04 }, 'голову к плечу 18°': { hTilt: 18 }, 'кивок 25°': { nod: 25 }, 'скрутка 20°': { twist: 20 }, 'поворот головы 20°': { hYaw: 20 },
  'взгляд на руку': { twist: 12, hYaw: 12, nod: 15 }, 'сдвиг в кресле 5 см': { slideX: -0.05 }, 'отъехал назад 8 см': { dist: 0.08 }, 'правая рука поднята': { armR: 1 }, 'взмах (пик)': { twist: 22, lat: 5, hYaw: 15 }, 'толчок (пик)': { fwd: 6 } };
for (const [name, p] of Object.entries(cases)) {
  const w = W(p);
  const yaw = Math.atan((w.off - b0.off) / 0.73) / D2R;
  const r = (w.rho - b0.rho) / 12, ts = -(w.sx - b0.sx) / 0.285, th = -(w.ex - b0.ex) / 0.42;
  const ds = w.ws / b0.ws - 1, de = (w.we / Math.cos(yaw * D2R)) / b0.we - 1, deRaw = w.we / b0.we - 1;
  const agree = (a, b) => (Math.sign(a) === Math.sign(b) ? Math.sign(a) * Math.min(Math.abs(a), Math.abs(b)) : 0);
  const lat = agree(r, (ts + th) / 2); let dep = agree(ds, de); dep = dep >= 0 ? dep / 0.12 : dep / 0.075;
  const oldLat = ts * 0.285 / 0.24; // старый: сдвиг плеч в sw / moveFull 0.24
  const g = (w.shY - w.earY) / w.ws, g0 = (b0.shY - b0.earY) / b0.ws; console.log(name.padEnd(22), `шея ${((g / g0 - 1) * 100).toFixed(1)}%  крен ${r.toFixed(2)}  плечи ${ts.toFixed(2)}  голова ${th.toFixed(2)} → ВБОК ${lat.toFixed(2)} | ширина ${(ds * 100).toFixed(1)}%  уши ${(deRaw * 100).toFixed(1)}%→${(de * 100).toFixed(1)}% (yaw ${yaw.toFixed(0)}°) → ГЛУБ ${dep.toFixed(2)} | старый: вбок ${oldLat.toFixed(2)} sw-full, глуб ${(ds / 0.17).toFixed(2)}`);
}
