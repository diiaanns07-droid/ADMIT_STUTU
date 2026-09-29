process.argv = ['x', 'x', '--only=ZZZ'];
const M = await import('./sim2.mjs');
const algo = process.env.ALGO || 'new';
const noiseOpt = process.env.NOISE ? { white: +process.env.NOISE.split(',')[0], ar: +process.env.NOISE.split(',')[1] } : {};
const SEEDS = 20;
const fpsL = (process.env.FPS || '10,15,30').split(',').map(Number);
const med = (a) => { const v = a.filter((x) => x !== null).sort((p, q) => p - q); return v.length ? v[v.length >> 1] : null; };
const p90 = (a) => { const v = a.filter((x) => x !== null).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length * 0.9)] : null; };
const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length;
const intents = ['I_right', 'I_left', 'I_fwd', 'I_back', 'I_fr', 'I_bl', 'I_walk', 'F_runstart', 'M_runRune'];
const noises = ['N_idle', 'X_shrug', 'X_headTilt', 'X_nod', 'X_twist', 'X_headYaw', 'X_lookHand', 'X_slide', 'X_scootBack', 'X_armRaise', 'X_rune', 'X_runeNoLock', 'X_slash', 'X_slashNoLock', 'X_throw', 'X_throwNoLock'];
console.log(`алгоритм ${algo}, шум ${JSON.stringify(noiseOpt)}`);
for (const n of intents) {
  const row = [];
  for (const fps of fpsL) {
    const L = []; for (let sd = 1; sd <= SEEDS; sd++) L.push(M.metrics(n, M.run(n, { fps, seed: sd, algo, noiseOpt })));
    row.push(`${fps}fps: старт ${med(L.map((x) => x.onsetMs))}/${p90(L.map((x) => x.onsetMs))} мс, стоп ${med(L.map((x) => x.stopMs))} мс, верно ${(mean(L.map((x) => x.holdGood)) * 100).toFixed(0)}%, ошибка ${mean(L.map((x) => x.dirErr ?? 0)).toFixed(1)}°, рывков ${L.reduce((p, x) => p + x.dashes, 0)}`);
  }
  console.log(n.padEnd(12), row.join(' | '));
}
for (const n of noises) {
  const row = [];
  for (const fps of fpsL) {
    const L = []; for (let sd = 1; sd <= SEEDS; sd++) L.push(M.metrics(n, M.run(n, { fps, seed: sd, algo, noiseOpt })));
    row.push(`${fps}fps: ложный ход ${(mean(L.map((x) => x.falseShare)) * 100).toFixed(1)}%, путь ${mean(L.map((x) => x.driftM)).toFixed(2)} м, макс ${Math.max(...L.map((x) => x.maxMag)).toFixed(2)}, рывков ${L.reduce((p, x) => p + x.dashes, 0)}`);
  }
  console.log(n.padEnd(14), row.join(' | '));
}
