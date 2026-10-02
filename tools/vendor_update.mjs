// [OFFLINE] Собирает vendor/ — наши копии всего, что раньше грузилось с внешних хостов:
//   three 0.185.1 (build + только используемые addons с зависимостями), @pixiv/three-vrm 3.5.5,
//   @mediapipe/tasks-vision 0.10.35 (bundle + wasm), модели MediaPipe (.task), peerjs 1.5.5, шрифты woff2.
// Раскладка повторяет пути CDN, поэтому запасной вариант — простая замена префикса:
//   vendor/npm/…              ↔ https://cdn.jsdelivr.net/npm/…
//   vendor/mediapipe-models/… ↔ https://storage.googleapis.com/mediapipe-models/…
//
//   node tools/vendor_update.mjs [--npm DIR] [--no-models] [--no-fonts]
//   --npm DIR — готовый node_modules с нужными версиями (иначе npm install во временную папку).
// После обновления: node tools/sw_manifest.mjs (список офлайн-кэша и версия кэша в sw.js).
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

export const PKGS = {
  three: '0.185.1',
  '@pixiv/three-vrm': '3.5.5',
  '@mediapipe/tasks-vision': '0.10.35',
  peerjs: '1.5.5',
};
// Точки входа addons, которые реально импортирует игра (modules/, core/). Зависимости добираются сами.
export const THREE_ADDONS = [
  'loaders/GLTFLoader.js',
  'utils/SkeletonUtils.js',
  'utils/BufferGeometryUtils.js',
  'postprocessing/EffectComposer.js',
  'postprocessing/RenderPass.js',
  'postprocessing/UnrealBloomPass.js',
  'postprocessing/OutputPass.js',
  'postprocessing/FXAAPass.js',
  'postprocessing/ShaderPass.js',
  'postprocessing/GTAOPass.js',
  'postprocessing/SMAAPass.js',
  'postprocessing/BokehPass.js',
  'libs/meshopt_decoder.module.js', // [LOAD] сжатые модели героев и деревни (EXT_meshopt_compression)
];
// Только SIMD-сборки: worker берёт module-вариант, запасной режим в главном потоке — обычный.
// Сборка без SIMD (браузеры до 2021 г.) не копируется — её отдаёт CDN через sw.js.
const MP_FILES = ['vision_bundle.mjs', 'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm', 'wasm/vision_wasm_module_internal.js', 'wasm/vision_wasm_module_internal.wasm'];
export const MODELS = [
  'pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  'pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  'hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
];
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Alegreya+Sans:ital,wght@0,400;0,500;0,700;1,400&family=Cinzel:wght@500;600;700&family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Forum&display=swap';
const FONT_SUBSETS = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext'];   // кириллица-ext: казахские буквы
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const kb = (n) => `${(n / 1024).toFixed(0)} КБ`;
function put(src, rel) {
  const dst = join(VENDOR, rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`  ${rel}  ${kb(statSync(dst).size)}`);
}
async function download(url, rel) {
  const dst = join(VENDOR, rel);
  mkdirSync(dirname(dst), { recursive: true });
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
  console.log(`  ${rel}  ${kb(statSync(dst).size)}`);
}

// ── npm-пакеты ──
let NM = argOf('--npm', null);
if (!NM) {
  const tmp = mkdtempSync(join(tmpdir(), 'ashen-vendor-'));
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', tmp, ...Object.entries(PKGS).map(([n, v]) => `${n}@${v}`)], { stdio: 'inherit' });
  NM = join(tmp, 'node_modules');
}
for (const [name, ver] of Object.entries(PKGS)) {
  const pj = JSON.parse(readFileSync(join(NM, name, 'package.json'), 'utf8'));
  if (pj.version !== ver) throw new Error(`${name}: в ${NM} версия ${pj.version}, нужна ${ver}`);
}
const npmDir = (name) => `npm/${name}@${PKGS[name]}`;
rmSync(join(VENDOR, 'npm'), { recursive: true, force: true });

console.log('three');
for (const f of ['build/three.module.min.js', 'build/three.core.min.js', 'LICENSE']) put(join(NM, 'three', f), `${npmDir('three')}/${f}`);
{
  const jsm = join(NM, 'three', 'examples', 'jsm');
  const seen = new Set();
  const queue = [...THREE_ADDONS];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = readFileSync(join(jsm, rel), 'utf8');
    for (const m of src.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) queue.push(posix.normalize(posix.join(posix.dirname(rel), m[1])));
    put(join(jsm, rel), `${npmDir('three')}/examples/jsm/${rel}`);
  }
}
console.log('@pixiv/three-vrm');
for (const f of ['lib/three-vrm.module.min.js', 'LICENSE']) put(join(NM, '@pixiv/three-vrm', f), `${npmDir('@pixiv/three-vrm')}/${f}`);
console.log('@mediapipe/tasks-vision');
for (const f of MP_FILES) put(join(NM, '@mediapipe/tasks-vision', f), `${npmDir('@mediapipe/tasks-vision')}/${f}`);
console.log('peerjs');
for (const f of ['dist/peerjs.min.js', 'LICENSE']) put(join(NM, 'peerjs', f), `${npmDir('peerjs')}/${f}`);

// ── модели MediaPipe ──
if (!argv.includes('--no-models')) {
  console.log('модели MediaPipe');
  for (const m of MODELS) {
    if (existsSync(join(VENDOR, 'mediapipe-models', m))) { console.log(`  mediapipe-models/${m}  (уже есть)`); continue; }
    await download(`https://storage.googleapis.com/mediapipe-models/${m}`, `mediapipe-models/${m}`);
  }
}

// ── шрифты ──
if (!argv.includes('--no-fonts')) {
  console.log('шрифты');
  rmSync(join(VENDOR, 'fonts'), { recursive: true, force: true });
  const css = await (await fetch(FONTS_CSS, { headers: { 'user-agent': UA } })).text();
  const files = new Map();
  let out = '/* Шрифты Google Fonts (SIL Open Font License 1.1), локальные копии: tools/vendor_update.mjs.\n'
    + ' * Forum — капители с кириллицей, Cinzel — латиница и цифры, Alegreya Sans — текст, Cormorant Garamond — курсив. */\n';
  for (const m of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)) {
    const [, subset, body] = m;
    if (!FONT_SUBSETS.includes(subset)) continue;
    const url = /url\(([^)]+)\)/.exec(body)[1];
    if (!files.has(url)) {
      const fam = /font-family:\s*'([^']+)'/.exec(body)[1].toLowerCase().replace(/\s+/g, '-');
      const style = /font-style:\s*(\w+)/.exec(body)[1];
      const weight = /font-weight:\s*(\d+)/.exec(body)[1];   // у вариативных шрифтов один файл на все веса
      const name = `${fam}-${style === 'italic' ? 'italic-' : ''}${weight}-${subset}.woff2`;
      files.set(url, name);
      await download(url, `fonts/${name}`);
    }
    out += `/* ${subset} */\n@font-face {${body.replace(/url\([^)]+\)/, `url('${files.get(url)}')`)}}\n`;
  }
  writeFileSync(join(VENDOR, 'fonts', 'fonts.css'), out);
  console.log(`  fonts/fonts.css  ${files.size} файлов`);
}
console.log('\nГотово. Теперь: node tools/sw_manifest.mjs');
