// [OFFLINE] Список офлайн-кэша для sw.js и объём стартовой загрузки для полосы прогресса в index.html.
//   node tools/sw_manifest.mjs           — обновить блоки <AO_MANIFEST> в sw.js и /*AO_BOOT*/ в index.html
//   node tools/sw_manifest.mjs --check   — только проверить, что они актуальны (код выхода 1, если нет)
// Запускать после изменения кода, ассетов или vendor/: VERSION кэша считается по содержимому файлов,
// поэтому у игроков старый кэш заменится новым сам. Если забыть — игра всё равно работает: код sw.js берёт
// сначала из сети, новые файлы кэширует при первом запросе; устареет только список докачки.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const rel = (p) => relative(ROOT, p).split(sep).join('/');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out); else out.push(rel(p));
  }
  return out;
}
const size = (p) => statSync(join(ROOT, p)).size;

// ── что кэшировать ──
const CODE_RE = /\.(m?js|css|html|json)$/;
const appFiles = [
  ...readdirSync(ROOT).filter((f) => /\.(m?js|css)$/.test(f) && f !== 'sw.js' && statSync(join(ROOT, f)).isFile()),
  'index.html',
  ...['modules', 'core', 'net'].flatMap((d) => walk(join(ROOT, d))).filter((f) => CODE_RE.test(f)),
].sort();
const vendorAll = walk(join(ROOT, 'vendor')).filter((f) => !/(^|\/)(LICENSE|README)[^/]*$/i.test(f) && !/\.md$/.test(f)).sort();
const vendorHeavy = vendorAll.filter((f) => /\.(wasm|task)$/.test(f) || /\/wasm\/[^/]+\.js$/.test(f));
const vendorLight = vendorAll.filter((f) => !vendorHeavy.includes(f));
const assets = walk(join(ROOT, 'assets')).filter((f) => /\.(glb|gltf|vrm|bin|jpe?g|png|webp|ktx2|hdr|json|mp3|ogg|wav)$/i.test(f) && !f.startsWith('assets/vroid_src/')).sort();

// модели и WASM — первыми (без них нет камеры), потом ассеты от маленьких к большим
const heavyOrder = (f) => (/pose_landmarker_lite|hand_landmarker|vision_wasm_module_internal/.test(f) ? 0 : /pose_landmarker_full/.test(f) ? 1 : 2);
const SHELL = ['./', ...appFiles, ...vendorLight];
const WARM = [...vendorHeavy.sort((a, b) => heavyOrder(a) - heavyOrder(b) || a.localeCompare(b)), ...assets.sort((a, b) => size(a) - size(b))];

const hashOf = (files) => {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f + '\0');
    // блок /*AO_BOOT*/ в index.html пишет этот же скрипт — в версию он не входит
    h.update(f === 'index.html' ? readFileSync(join(ROOT, f), 'utf8').replace(/\/\*AO_BOOT\*\/.*?\/\*\/AO_BOOT\*\//, '') : readFileSync(join(ROOT, f)));
  }
  return h.digest('hex').slice(0, 12);
};
const VENDOR_VERSION = hashOf(vendorAll);
const VERSION = hashOf([...appFiles, ...assets, ...vendorAll.filter((f) => !vendorHeavy.includes(f))]);

// ── стартовая загрузка: статические импорты main.js и offline.js, стили ──
const importMap = (() => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const m = /<script type="importmap">\s*({[\s\S]*?})\s*<\/script>/.exec(html);
  return m ? JSON.parse(m[1]).imports : {};
})();
function resolveSpec(spec, from) {
  if (spec.startsWith('./') || spec.startsWith('../')) return posix.normalize(posix.join(posix.dirname(from), spec));
  if (importMap[spec]) return posix.normalize(importMap[spec].replace(/^\.\//, ''));
  for (const [k, v] of Object.entries(importMap)) if (k.endsWith('/') && spec.startsWith(k)) return posix.normalize(v.replace(/^\.\//, '') + spec.slice(k.length));
  return null;
}
const IMPORT_RE = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?['"]([^'"\n]+)['"]/g;
const boot = new Set();
function collect(f) {
  if (!f || boot.has(f) || !existsSync(join(ROOT, f))) return;
  boot.add(f);
  // только статические import/export … from '…' и import '…' (динамические import() грузятся позже)
  for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(IMPORT_RE)) collect(resolveSpec(m[1], f));
}
collect('main.js');
collect('offline.js');
for (const css of ['styles.css', 'modules/ui.css', 'vendor/fonts/fonts.css']) if (existsSync(join(ROOT, css))) boot.add(css);
// big — три самых больших файла старта: заставка называет тот, что ещё грузится
const BOOT = { bytes: [...boot].reduce((s, f) => s + size(f), 0), files: boot.size, big: [...boot].sort((a, b) => size(b) - size(a)).slice(0, 3) };

// ── запись ──
const q = (a) => '[\n' + a.map((f) => `  ${JSON.stringify(f)},`).join('\n') + '\n]';
const block = `// <AO_MANIFEST> — генерирует node tools/sw_manifest.mjs, руками не править
const VERSION = '${VERSION}';
const VENDOR_VERSION = '${VENDOR_VERSION}';
const SHELL = ${q(SHELL)};
const WARM = ${q(WARM)};
// </AO_MANIFEST>`;
const swPath = join(ROOT, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const swNext = sw.replace(/\/\/ <AO_MANIFEST>[\s\S]*?\/\/ <\/AO_MANIFEST>/, block);
const idxPath = join(ROOT, 'index.html');
const idx = readFileSync(idxPath, 'utf8');
const idxNext = idx.replace(/\/\*AO_BOOT\*\/.*?\/\*\/AO_BOOT\*\//, `/*AO_BOOT*/${JSON.stringify(BOOT)}/*/AO_BOOT*/`);
const MB = (n) => (n / 1048576).toFixed(1) + ' МБ';
const sum = (a) => a.reduce((s, f) => s + (f === './' ? 0 : size(f)), 0);
console.log(`VERSION ${VERSION}, VENDOR ${VENDOR_VERSION}`);
console.log(`установка: ${SHELL.length} файлов, ${MB(sum(SHELL))}; докачка: ${WARM.length} файлов, ${MB(sum(WARM))}`);
console.log(`старт игры: ${BOOT.files} файлов, ${MB(BOOT.bytes)}`);
const big = [...vendorAll, ...assets].filter((f) => size(f) > 95 * 1048576);
if (big.length) { console.error('Файлы больше 95 МБ (лимит GitHub 100 МБ):', big); process.exitCode = 1; }
if (CHECK) {
  const stale = [swNext !== sw && 'sw.js', idxNext !== idx && 'index.html'].filter(Boolean);
  if (stale.length) { console.error(`устарело: ${stale.join(', ')} — запустите node tools/sw_manifest.mjs`); process.exitCode = 1; }
  else console.log('актуально');
} else {
  if (swNext !== sw) writeFileSync(swPath, swNext);
  if (idxNext !== idx) writeFileSync(idxPath, idxNext);
  console.log('записано: sw.js, index.html');
}
