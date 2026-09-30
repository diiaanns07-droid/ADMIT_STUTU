process.argv = ['x', 'x', '--only=ZZZ'];
const M = await import('./sim2.mjs');
const variants = JSON.parse(process.env.V || '[{}]');
const names = ['I_right', 'I_left', 'I_fwd', 'I_back', 'I_fr', 'I_bl', 'I_walk', 'F_runstart', 'X_shrug', 'X_headTilt', 'X_nod', 'X_twist', 'X_headYaw', 'X_lookHand', 'X_slide', 'X_armRaise', 'X_slash', 'X_throw', 'X_rune', 'M_runRune', 'N_idle'];
const dn = ['D_right', 'D_left', 'D_fwd', 'D_back'];
const SEEDS = 20;
for (const over of variants) {
  for (const fps of [6, 10, 15, 30]) {
    const hits = {}; for (const d of dn) { let h = 0; for (let sd = 1; sd <= SEEDS; sd++) h += M.metrics(d, M.run(d, { fps, seed: sd, over })).hit; hits[d.slice(2)] = h; }
    let fd = 0, fdn = []; for (const n of names) { let c = 0; for (let sd = 1; sd <= SEEDS; sd++) c += M.metrics(n, M.run(n, { fps, seed: sd, over })).dashes; if (c) fdn.push(`${n}:${c}`); fd += c; }
    console.log(JSON.stringify(over), fps, 'fps  попаданий из 20:', JSON.stringify(hits), ' ложных рывков:', fd, fdn.join(' '));
  }
}
