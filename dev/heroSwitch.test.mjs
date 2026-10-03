// [W5-СМЕНА] node-тест кэша смены героя (modules/heroCache.js) и его использования в модулях оболочки.
// Баг, который не должен вернуться: при каждой смене героя шейдер следа посоха (и ауры) собирался заново — номер
// исходника в ключе программы three рос (WebGLShaderCache: последний материал освобождён → исходник забыт → новый
// номер), а программы прежнего героя уничтожались до сборки нового (dispose → usedTimes 0).
// Здесь — модель этих правил three r185 (FakeRenderer ниже) и проверки:
//   • след посоха: десять загрузок героя → один и тот же ключ программы, одна программа;
//   • без «хранителя» (прямой dispose) ключ растёт — модель воспроизводит баг;
//   • pinPrograms: программа не уничтожается dispose'ом материала, один pin на ключ;
//   • видеопамять текстур: скрытый герой отдаёт свои текстуры, общие с показанным — нет, цели рендера — никогда;
//   • работа кусками: slice() отдаёт поток по бюджету, abort() → ABORT;
//   • снаряжение собирается генератором (dressHeroSteps), холсты ткани и кольцо рун — из кэша.
// Нужен three.js как модуль: `three` из node_modules или путь в ASHEN_THREE (иначе SKIP).
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

let THREE = null;
try { THREE = await import('three'); } catch (e) {
  const c = process.env.ASHEN_THREE;
  if (c && existsSync(c)) { try { THREE = await import(pathToFileURL(c).href); } catch (e2) { /* skip */ } }
}
if (!THREE) { console.log('SKIP heroSwitch: three.js не найден (npm i three или ASHEN_THREE=…/three.module.js)'); process.exit(0); }

const HC = await import('../modules/heroCache.js');
const { createTrail, createFootprints, createDashBurst } = await import('../modules/heroTrail.js');

// ---------------------------------------------------------------- модель правил three r185 (WebGLPrograms + WebGLShaderCache)
// ключ ShaderMaterial = [номер вершинного исходника, номер фрагментного, …]; номер выдаётся счётчиком при первом
// материале с этим исходником и забывается, когда освобождён последний; программа уничтожается при usedTimes 0.
function FakeRenderer() {
  let stageId = 0;
  const stages = new Map();          // код → { id, used }
  const matStages = new Map();       // материал → [стадии]
  const programs = new Map();        // ключ → { cacheKey, usedTimes }
  const props = new Map();           // материал → { programs: Map(key → program), currentProgram }
  let linked = 0;
  const stage = (code) => { let s = stages.get(code); if (!s) { s = { id: stageId++, code, used: 0 }; stages.set(code, s); } return s; };
  const R = {
    properties: { get: (m) => { if (!props.has(m)) props.set(m, {}); return props.get(m); } },
    get linked() { return linked; },
    get alive() { return programs.size; },
    compile(m, variant = 'rt') {
      let key;
      if (m.isShaderMaterial) {
        if (!matStages.has(m)) { const a = [stage(m.vertexShader), stage(m.fragmentShader)]; for (const s of a) s.used++; matStages.set(m, a); }
        const [v, f] = matStages.get(m);
        key = `${v.id},${f.id},${variant}`;
      } else key = `${m.type},${m.customProgramCacheKey ? m.customProgramCacheKey() : ''},${variant}`;
      const pr = R.properties.get(m);
      if (!pr.programs) {
        pr.programs = new Map();
        m.addEventListener('dispose', () => {
          for (const p of pr.programs.values()) if (--p.usedTimes === 0) programs.delete(p.cacheKey);
          const a = matStages.get(m);
          if (a) { for (const s of a) if (--s.used === 0) stages.delete(s.code); matStages.delete(m); }
          props.delete(m);
        });
      }
      if (!pr.programs.has(key)) {
        let p = programs.get(key);
        if (!p) { p = { cacheKey: key, usedTimes: 0 }; programs.set(key, p); linked++; }
        p.usedTimes++;
        pr.programs.set(key, p);
      }
      pr.currentProgram = pr.programs.get(key);
      return key;
    },
  };
  return R;
}

// ---------------------------------------------------------------- 1. модель воспроизводит баг: прямой dispose — ключ растёт
{
  const R = FakeRenderer();
  const keys = new Set();
  const mk = () => new THREE.ShaderMaterial({ vertexShader: 'void main(){gl_Position=vec4(0.0);} // bug-v', fragmentShader: 'void main(){gl_FragColor=vec4(1.0);} // bug-f' });
  for (let i = 0; i < 5; i++) { const m = mk(); keys.add(R.compile(m)); m.dispose(); }
  assert.equal(keys.size, 5, 'модель three: без хранителя каждая загрузка — новый ключ (баг воспроизведён)');
  assert.equal(R.linked, 5, 'модель three: и новая сборка программы каждый раз');
}

// ---------------------------------------------------------------- 2. след посоха, следы шагов, пыль: ключ не меняется
{
  const R = FakeRenderer();
  HC.setRenderer(R);
  for (const [name, make] of [['след посоха', () => createTrail(THREE, { color: 0xff7a2a })], ['следы шагов', () => createFootprints(THREE, {})], ['пыль рывка', () => createDashBurst(THREE, {})]]) {
    const keys = new Set();
    const l0 = R.linked;
    for (let load = 0; load < 10; load++) {
      const fx = make();
      const mat = (fx.mesh || fx.points).material;
      keys.add(R.compile(mat));
      fx.dispose();   // смена героя: прежний герой освобождает свои эффекты
    }
    assert.equal(keys.size, 1, `${name}: десять загрузок героя — один ключ программы (было: новый каждый раз)`);
    assert.equal(R.linked - l0, 1, `${name}: программа собрана один раз`);
  }
}

// ---------------------------------------------------------------- 3. pinPrograms: программа переживает dispose материала
{
  const R = FakeRenderer();
  const a = new THREE.MeshStandardMaterial(); a.customProgramCacheKey = () => 'heroLight:pin-test';
  R.compile(a);
  assert.equal(HC.pinPrograms(R, null, [a]), 1, 'закреплена одна программа');
  assert.equal(HC.pinPrograms(R, null, [a]), 0, 'второй раз — уже закреплена');
  a.dispose();
  assert.equal(R.alive, 1, 'программа жива после dispose материала (вытеснение героя из кэша)');
  const b = new THREE.MeshStandardMaterial(); b.customProgramCacheKey = () => 'heroLight:pin-test';
  const l0 = R.linked;
  R.compile(b);
  assert.equal(R.linked, l0, 'вернувшийся герой не собирает программу заново');
  // ShaderMaterial не закрепляется pin'ом (у него ключ с номерами исходников) — его держит хранитель
  const s = new THREE.ShaderMaterial({ vertexShader: 'void main(){} // pin-v', fragmentShader: 'void main(){} // pin-f' });
  R.compile(s);
  assert.equal(HC.pinPrograms(R, null, [s]), 0, 'ShaderMaterial — через хранителя, не pin');
}

// ---------------------------------------------------------------- 4. retire: хранитель — первый собранный; текстуры у него обнуляются
{
  const R = FakeRenderer();
  HC.setRenderer(R);
  const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const src = { vertexShader: 'void main(){} // keep-v', fragmentShader: 'void main(){} // keep-f' };
  const uncompiled = new THREE.ShaderMaterial({ ...src });
  let disposed = 0;
  uncompiled.addEventListener('dispose', () => disposed++);
  HC.retire(uncompiled);
  assert.equal(disposed, 1, 'несобранный материал — просто dispose (хранить нечего)');
  const m1 = new THREE.ShaderMaterial({ ...src, uniforms: { uTex: { value: tex } } });
  const m2 = new THREE.ShaderMaterial({ ...src });
  R.compile(m1); R.compile(m2);
  let d1 = 0, d2 = 0;
  m1.addEventListener('dispose', () => d1++); m2.addEventListener('dispose', () => d2++);
  HC.retire(m1); HC.retire(m2);
  assert.equal(d1, 0, 'первый собранный — хранитель (не освобождается)');
  assert.equal(m1.uniforms.uTex.value, null, 'у хранителя нет ссылок на текстуры (холсты не держатся)');
  assert.equal(d2, 1, 'остальные — освобождаются');
  const plain = new THREE.MeshBasicMaterial();
  let dp = 0; plain.addEventListener('dispose', () => dp++);
  HC.retire(plain);
  assert.equal(dp, 1, 'обычный материал — dispose');
}

// ---------------------------------------------------------------- 5. видеопамять: скрытый герой отдаёт свои текстуры
{
  const mk = () => new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const own = mk(), shared = mk(), next = mk();
  const rt = new THREE.WebGLRenderTarget(1, 1);
  const count = new Map();
  for (const t of [own, shared, next, rt.texture]) t.addEventListener('dispose', () => count.set(t, (count.get(t) || 0) + 1));
  const A = new Set([own, shared, rt.texture]), B = new Set([shared, next]);
  HC.showTextures(A);
  HC.showTextures(B);                 // новый герой показан (общая текстура — у обоих)
  assert.equal(HC.hideTextures(A), 1, 'прежний спрятан: отдана одна своя текстура');
  assert.equal(count.get(own), 1, 'своя текстура прежнего героя — dispose (видеопамять)');
  assert.ok(!count.get(shared), 'общая с показанным героем — остаётся');
  assert.ok(!count.get(rt.texture), 'цель рендера (окружение, отражение) — никогда');
  assert.ok(own.image && own.image.data, 'исходник текстуры остаётся (three загрузит её снова при показе)');
  HC.hideTextures(B);
  assert.equal(count.get(shared), 1, 'последний пользователь спрятан — общая отдана');
  const ups = [];
  await HC.uploadTextures({ initTexture: (t) => ups.push(t) }, new Set([own, rt.texture]), null);
  assert.deepEqual(ups, [own], 'заранее загружаются только свои текстуры героя');
}

// ---------------------------------------------------------------- 6. работа кусками и отмена
{
  const job = HC.createJob({ idle: false });
  const t0 = performance.now();
  await job.slice();
  assert.ok(performance.now() - t0 < 5, 'в пределах куска slice() не отдаёт поток');
  const spin = performance.now(); while (performance.now() - spin < 18) { /* кусок исчерпан */ }
  await job.slice();
  assert.equal(job.slices, 1, 'кусок > 16 мс — поток отдан');
  assert.ok(job.maxSlice >= 16, 'длина куска учтена');
  job.abort();
  await assert.rejects(() => job.slice(), (e) => e === HC.ABORT, 'после abort() — ABORT');
  const idle = HC.createJob({ idle: true });
  assert.equal(idle.budget, 8, 'в простое — кусок 8 мс');
  idle.hurry();
  assert.equal(idle.idle, false, 'спешно: пользователь ждёт этого героя');
  assert.equal(HC.memo('t|a', () => 7), 7);
  assert.equal(HC.memo('t|a', () => 8), 7, 'memo: второй раз не считается');
  assert.ok(HC.memoHas('t|a'));
}

// ---------------------------------------------------------------- 7. снаряжение — по частям, холсты ткани — из кэша
{
  const G = await import('../modules/heroGear.js');
  assert.equal(typeof G.dressHero, 'function');
  assert.equal(Object.prototype.toString.call(G.dressHeroSteps), '[object GeneratorFunction]', 'dressHeroSteps — генератор (сборка кусками)');
  const F = await import('../modules/heroForge.js');
  // без document холстов нет, но кэш отвечает одним и тем же объектом
  assert.equal(F.capeTextures(THREE, { base: 1, trim: 2, glow: 3 }), F.capeTextures(THREE, { base: 1, trim: 2, glow: 3 }), 'плащ: те же холсты из кэша');
  assert.equal(F.panelTextures(THREE, { base: 1 }), F.panelTextures(THREE, { base: 1 }), 'полы: те же холсты из кэша');
  let made = 0;
  const a = F.sharedTextures('t:w5', () => { made++; return { map: new THREE.DataTexture(new Uint8Array(4), 1, 1) }; });
  a.release();
  const b = F.sharedTextures('t:w5', () => { made++; return {}; });
  assert.equal(made, 1, 'наряд: последняя ссылка отпущена — холсты остаются в кэше (A→B→A не рисует заново)');
  assert.equal(b.tex, a.tex);
  b.release();
}

// ---------------------------------------------------------------- 8. heroModel: API смены (витрина и стенд замера)
{
  const src = (await import('node:fs')).readFileSync(new URL('../modules/heroModel.js', import.meta.url), 'utf8');
  // прежняя причина: clear() в начале setHero освобождал героя до сборки нового
  const setHeroBody = src.slice(src.indexOf('  async function setHero(id) {'), src.indexOf('  // [W5-СМЕНА] тихая предсборка'));
  assert.ok(setHeroBody.length > 100, 'setHero найден');
  assert.ok(!/\bclear\(\)/.test(setHeroBody), 'setHero не освобождает прежнего героя до сборки нового');
  assert.ok(!/deepDispose\(/.test(src.slice(src.indexOf('  function disposeRec(rec) {'), src.indexOf('  function trimLru() {'))), 'освобождение героя не трогает общие кэшированные текстуры (deepDispose)');
  for (const k of ['prebuild', 'neighbors', 'get shown()', 'get swaps()', 'warmsPrograms']) assert.ok(src.includes(k), `heroModel: ${k}`);
}

console.log('heroSwitch.test: ok');
