// Сжатие моделей и текстур для веба: node tools/compress_assets.mjs --deps DIR [--check] [файлы…]
//   DIR — папка с node_modules, где стоят meshoptimizer и sharp:
//         mkdir /tmp/ao_deps && cd /tmp/ao_deps && npm i meshoptimizer sharp
//   --check — только посчитать и сверить точность, файлы не записывать.
//
// Почему не gltf-transform: он выбрасывает неизвестные расширения, а у VRM вся разметка (скелет
// гуманоида, выражения, пружинные кости, MToon) лежит в расширении VRM со ссылками на индексы узлов,
// мешей и текстур. Здесь JSON сцены не перестраивается вообще — меняются только буферы:
//   • геометрия, морфы, кости и анимации — EXT_meshopt_compression (bufferView целиком, тот же
//     порядок вершин и треугольников). Числа с плавающей точкой — фильтр EXPONENTIAL: тип данных
//     остаётся Float32 (код, читающий attributes.position.array, не заметит), отбрасываются только
//     младшие биты мантиссы (позиции — 15 бит, UV — 15, нормали — 12, морфы — 14/12). Веса и индексы
//     костей, индексы треугольников, обратные матрицы привязки и ключи анимаций — без потерь;
//   • картинки внутри GLB/VRM — WebP (EXT_texture_webp), сторона не больше maxTex;
//   • отдельные текстуры (polyhaven) — WebP рядом с исходником.
// GLTFLoader распаковывает meshopt через MeshoptDecoder (three/addons/libs/meshopt_decoder.module.js,
// подключён в modules/vrmKit.js → createGltfLoader). Уже сжатый файл пропускается.
// Исходники до сжатия — в истории git (коммит 15298a8): git show 15298a8:assets/vroid/elf.vrm > elf.vrm

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DEPS = argOf('--deps', null);
const CHECK = argv.includes('--check');
if (!DEPS) { console.error('нужен --deps DIR (папка с node_modules: meshoptimizer, sharp)'); process.exit(2); }
const req = createRequire(join(resolve(DEPS), 'node_modules', 'x.js'));
const { MeshoptEncoder, MeshoptDecoder } = req('meshoptimizer');
const sharp = req('sharp');

// maxTex — наибольшая сторона текстуры внутри модели; q — качество WebP
const MODELS = {
  'assets/vroid/elf.vrm': { maxTex: 1024, q: 86 },        // житель деревни и скрытая героиня elfVroid
  'assets/vroid/dark.vrm': { maxTex: 1024, q: 86 },       // скрытая героиня darkVroid
  'assets/vroid/villager_e.vrm': { maxTex: 512, q: 84 },  // жители деревни — мелкие фигуры вдали
  'assets/vroid/villager_g.vrm': { maxTex: 512, q: 84 },
  'assets/heroes/knight.glb': { maxTex: 1024, q: 90 },    // герои: крупный план на витрине меню
  'assets/heroes/ranger.glb': { maxTex: 1024, q: 90 },
  'assets/heroes/wizard.glb': { maxTex: 1024, q: 90 },
  'assets/heroes/anims_kaykit.glb': { dropRestTracks: true, mergeAnim: true },   // библиотека клипов героев (без мешей)
  'assets/quaternius/woman.glb': { maxTex: 512, q: 86, dropRestTracks: true, mergeAnim: true },
  'assets/quaternius/human.glb': { maxTex: 512, q: 86, dropRestTracks: true, mergeAnim: true },
};
// отдельные текстуры: исходник → WebP рядом (world.js грузит *.webp, JPG остаётся запасным)
const TEXTURES = [];
for (const name of ['dark_rock_02', 'monastery_stone_floor']) {
  TEXTURES.push({ src: `assets/polyhaven/${name}/${name}_diff_1k.jpg`, out: `assets/polyhaven/${name}/${name}_diff.webp`, size: 1024, q: 80 });
  TEXTURES.push({ src: `assets/polyhaven/${name}/${name}_nor_gl_1k.jpg`, out: `assets/polyhaven/${name}/${name}_nor_gl.webp`, size: 512, q: 88 });
  TEXTURES.push({ src: `assets/polyhaven/${name}/${name}_arm_1k.jpg`, out: `assets/polyhaven/${name}/${name}_arm.webp`, size: 512, q: 80 });
}

// фильтр EXPONENTIAL: биты мантиссы и способ выбора порядка по ролям данных
const EXP = {
  'attr:POSITION': [15, 'SharedVector'], 'attr:NORMAL': [12, 'SharedVector'], 'attr:TANGENT': [12, 'SharedVector'],
  'attr:TEXCOORD_0': [15, 'SharedVector'], 'attr:TEXCOORD_1': [15, 'SharedVector'],
  'morph:POSITION': [14, 'SharedVector'], 'morph:NORMAL': [12, 'SharedVector'], 'morph:TANGENT': [12, 'SharedVector'],
};
const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const MESHOPT = 'EXT_meshopt_compression', WEBP = 'EXT_texture_webp';

function readGlb(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('не GLB');
  const len = buf.readUInt32LE(8);
  let off = 12, json = null, bin = null;
  while (off < len) {
    const cl = buf.readUInt32LE(off), ct = buf.readUInt32LE(off + 4);
    const c = buf.subarray(off + 8, off + 8 + cl);
    if (ct === 0x4e4f534a) json = JSON.parse(c.toString('utf8')); else if (ct === 0x004e4942) bin = c;
    off += 8 + cl;
  }
  return { json, bin };
}
function writeGlb(json, bin) {
  let jb = Buffer.from(JSON.stringify(json), 'utf8');
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)]);
  if (bin.length % 4) bin = Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]);
  const h = Buffer.alloc(12), hj = Buffer.alloc(8), hb = Buffer.alloc(8);
  h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jb.length + 8 + bin.length, 8);
  hj.writeUInt32LE(jb.length, 0); hj.writeUInt32LE(0x4e4f534a, 4);
  hb.writeUInt32LE(bin.length, 0); hb.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([h, hj, jb, hb, bin]);
}
const addExt = (json, name) => {
  json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), name])];
  json.extensionsRequired = [...new Set([...(json.extensionsRequired || []), name])];
};

// роль каждого bufferView: какие аксессоры его читают и зачем
function bufferViewRoles(json) {
  const roles = new Map(); // bv → [{ acc, role }]
  const add = (ai, role) => {
    const a = json.accessors[ai];
    if (!a || a.bufferView == null) return;
    if (!roles.has(a.bufferView)) roles.set(a.bufferView, []);
    roles.get(a.bufferView).push({ ai, a, role });
  };
  for (const m of json.meshes || []) for (const p of m.primitives) {
    if (p.indices != null) add(p.indices, (p.mode ?? 4) === 4 ? 'index:tri' : 'index');
    for (const [k, ai] of Object.entries(p.attributes)) add(ai, 'attr:' + k);
    for (const t of p.targets || []) for (const [k, ai] of Object.entries(t)) add(ai, 'morph:' + k);
  }
  for (const s of json.skins || []) if (s.inverseBindMatrices != null) add(s.inverseBindMatrices, 'ibm');
  for (const an of json.animations || []) for (const s of an.samplers) { add(s.input, 'anim:in'); add(s.output, 'anim:out'); }
  (json.accessors || []).forEach((a, ai) => {
    if (a.sparse) { /* разреженные — не трогаем bufferView: помечаем как «прочее» */
      for (const bv of [a.sparse.indices.bufferView, a.sparse.values.bufferView]) { if (!roles.has(bv)) roles.set(bv, []); roles.get(bv).push({ ai, a, role: 'sparse' }); }
    }
  });
  return roles;
}

// План сжатия одного bufferView: { mode, stride, count, filter?, exp? } или null (оставить как есть)
function planView(json, bv, list) {
  if (!list || !list.length || list.some((r) => r.role === 'sparse')) return null;
  const elem = (a) => COMP_SIZE[a.componentType] * TYPE_N[a.type];
  if (list.every((r) => r.role.startsWith('index'))) {
    const cs = COMP_SIZE[list[0].a.componentType];
    if (cs !== 2 && cs !== 4) return null;
    if (list.some((r) => COMP_SIZE[r.a.componentType] !== cs)) return null;
    const count = bv.byteLength / cs;
    if (!Number.isInteger(count)) return null;
    const tri = list.every((r) => r.role === 'index:tri' && r.a.count % 3 === 0 && ((r.a.byteOffset || 0) / cs) % 3 === 0) && count % 3 === 0;
    return { mode: tri ? 'TRIANGLES' : 'INDICES', stride: cs, count };
  }
  const sizes = new Set(list.map((r) => elem(r.a)));
  const stride = bv.byteStride || (sizes.size === 1 ? [...sizes][0] : 0);
  if (!stride || stride % 4 || stride > 256 || bv.byteLength % stride) return null;
  if (!bv.byteStride && list.some((r) => (r.a.byteOffset || 0) % stride)) return null;
  const plan = { mode: 'ATTRIBUTES', stride, count: bv.byteLength / stride };
  // фильтр — только если весь view — одна роль, float, и без чередования
  const roleSet = new Set(list.map((r) => r.role));
  const a0 = list[0].a;
  if (roleSet.size === 1 && !bv.byteStride && EXP[list[0].role] && list.every((r) => r.a.componentType === 5126 && !r.a.normalized && elem(r.a) === stride)) {
    plan.filter = 'EXPONENTIAL'; plan.exp = EXP[list[0].role]; plan.role = list[0].role; plan.n = TYPE_N[a0.type];
  }
  return plan;
}

// ---------------------------------------------------------------- перестройка анимаций (только библиотеки клипов)
// dropRestTracks: канал анимации, который весь клип держит кость в её позе покоя, ничего не меняет —
//   миксер three.js и так возвращает кость в исходное состояние (PropertyMixer: недостающий вес
//   добирается исходным значением). У KayKit таких каналов 70%: JSON файла в разы меньше.
// mergeAnim: тысячи крошечных bufferView ключей (по одному на дорожку) → по одному на роль и размер
//   элемента; meshopt сжимает их одним куском.
function restructure(json, bin, opt) {
  const views = json.bufferViews.map((bv) => Buffer.from(bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)));
  const floats = (ai) => {
    const a = json.accessors[ai], v = views[a.bufferView], n = TYPE_N[a.type];
    if (a.componentType !== 5126 || json.bufferViews[a.bufferView].byteStride) return null;
    const o = v.byteOffset + (a.byteOffset || 0);
    return new Float32Array(v.buffer.slice(o, o + a.count * n * 4));
  };
  let dropped = 0;
  if (opt.dropRestTracks) {
    for (const an of json.animations || []) {
      const keep = an.channels.filter((ch) => {
        const s = an.samplers[ch.sampler], node = json.nodes[ch.target.node];
        if (!node || ch.target.path === 'weights' || node.matrix) return true;
        const out = floats(s.output);
        if (!out) return true;
        const n = { rotation: 4, translation: 3, scale: 3 }[ch.target.path];
        const rest = node[ch.target.path] || (ch.target.path === 'rotation' ? [0, 0, 0, 1] : ch.target.path === 'scale' ? [1, 1, 1] : [0, 0, 0]);
        if (s.interpolation === 'CUBICSPLINE') return true;
        for (let k = 0; k < out.length; k++) if (Math.abs(out[k] - rest[k % n]) > 1e-5) return true;
        return false;
      });
      if (!keep.length) keep.push(an.channels[0]);   // в анимации должен остаться хотя бы один канал
      dropped += an.channels.length - keep.length;
      // сэмплеры — только используемые, по порядку
      const used = [...new Set(keep.map((c) => c.sampler))];
      const remap = new Map(used.map((s, i) => [s, i]));
      an.samplers = used.map((s) => an.samplers[s]);
      an.channels = keep.map((c) => ({ ...c, sampler: remap.get(c.sampler) }));
    }
  }
  for (const an of json.animations || []) for (const s of an.samplers) if (s.interpolation === 'LINEAR') delete s.interpolation; // LINEAR — по умолчанию
  // аксессоры: только используемые
  const accUsed = new Set();
  for (const m of json.meshes || []) for (const p of m.primitives) { if (p.indices != null) accUsed.add(p.indices); Object.values(p.attributes).forEach((a) => accUsed.add(a)); for (const t of p.targets || []) Object.values(t).forEach((a) => accUsed.add(a)); }
  for (const s of json.skins || []) if (s.inverseBindMatrices != null) accUsed.add(s.inverseBindMatrices);
  for (const an of json.animations || []) for (const s of an.samplers) { accUsed.add(s.input); accUsed.add(s.output); }
  const accList = [...accUsed].sort((a, b) => a - b), accMap = new Map(accList.map((a, i) => [a, i]));
  const A = (i) => accMap.get(i);
  for (const m of json.meshes || []) for (const p of m.primitives) {
    if (p.indices != null) p.indices = A(p.indices);
    for (const k of Object.keys(p.attributes)) p.attributes[k] = A(p.attributes[k]);
    for (const t of p.targets || []) for (const k of Object.keys(t)) t[k] = A(t[k]);
  }
  for (const s of json.skins || []) if (s.inverseBindMatrices != null) s.inverseBindMatrices = A(s.inverseBindMatrices);
  for (const an of json.animations || []) for (const s of an.samplers) { s.input = A(s.input); s.output = A(s.output); }
  json.accessors = accList.map((i) => json.accessors[i]);
  // слияние ключей анимаций: каждому аксессору — свой кусок в общем bufferView (роль, размер элемента)
  const role = new Map();
  for (const an of json.animations || []) for (const s of an.samplers) { role.set(s.input, 'in'); if (!role.has(s.output)) role.set(s.output, 'out'); }
  const bvUsers = new Map();
  json.accessors.forEach((a, i) => { if (a.bufferView != null) bvUsers.set(a.bufferView, (bvUsers.get(a.bufferView) || 0) + 1); if (a.sparse) { bvUsers.set(a.sparse.indices.bufferView, 99); bvUsers.set(a.sparse.values.bufferView, 99); } });
  (json.images || []).forEach((im) => { if (im.bufferView != null) bvUsers.set(im.bufferView, 99); });
  const outViews = [], outDefs = [], bvMap = new Map();
  const keepView = (old) => { if (!bvMap.has(old)) { bvMap.set(old, outDefs.length); outDefs.push({ ...json.bufferViews[old] }); outViews.push(views[old]); } return bvMap.get(old); };
  const groups = new Map();
  json.accessors.forEach((a, i) => {
    if (a.bufferView == null) return;
    const bv = json.bufferViews[a.bufferView];
    const es = COMP_SIZE[a.componentType] * TYPE_N[a.type];
    const merge = opt.mergeAnim && role.has(i) && bvUsers.get(a.bufferView) === 1 && !bv.byteStride && a.componentType === 5126 && es % 4 === 0;
    if (!merge) { a.bufferView = keepView(a.bufferView); return; }
    const key = role.get(i) + ':' + es;
    if (!groups.has(key)) { groups.set(key, { idx: outDefs.length, parts: [], len: 0 }); outDefs.push({ buffer: 0, byteLength: 0 }); outViews.push(null); }
    const g = groups.get(key);
    const o = views[a.bufferView].subarray(a.byteOffset || 0, (a.byteOffset || 0) + a.count * es);
    a.bufferView = g.idx; a.byteOffset = g.len;
    g.parts.push(o); g.len += o.length;
  });
  for (const g of groups.values()) { outViews[g.idx] = Buffer.concat(g.parts); outDefs[g.idx].byteLength = g.len; }
  json.accessors.forEach((a) => { if (a.sparse) { a.sparse.indices.bufferView = keepView(a.sparse.indices.bufferView); a.sparse.values.bufferView = keepView(a.sparse.values.bufferView); } if (a.byteOffset === 0) delete a.byteOffset; });
  (json.images || []).forEach((im) => { if (im.bufferView != null) im.bufferView = keepView(im.bufferView); });
  // новый BIN
  const chunks = []; let len = 0;
  outDefs.forEach((d, i) => { const pad = (16 - (len % 16)) % 16; if (pad) { chunks.push(Buffer.alloc(pad)); len += pad; } d.byteOffset = len; d.byteLength = outViews[i].length; chunks.push(outViews[i]); len += outViews[i].length; });
  json.bufferViews = outDefs;
  json.buffers[0].byteLength = len;
  if (dropped || groups.size) console.log(`   анимации: убрано каналов в покое ${dropped}, bufferView ${views.length} → ${outDefs.length}`);
  return { json, bin: Buffer.concat(chunks) };
}

async function compressModel(rel, opt) {
  const file = join(ROOT, rel);
  if (!existsSync(file)) { console.warn('нет файла', rel); return null; }
  const src = readFileSync(file);
  let { json, bin } = readGlb(src);
  if ((json.extensionsUsed || []).includes(MESHOPT)) { console.log(`${rel}: уже сжат, пропуск`); return { rel, before: src.length, after: src.length, skipped: true }; }
  if ((json.buffers || []).length !== 1 || json.buffers[0].uri) throw new Error(rel + ': ожидался GLB с одним встроенным буфером');
  if (opt.dropRestTracks || opt.mergeAnim) ({ json, bin } = restructure(json, bin, opt));
  const roles = bufferViewRoles(json);
  const imageViews = new Map();
  (json.images || []).forEach((im, i) => { if (im.bufferView != null) imageViews.set(im.bufferView, i); });

  // 1. картинки → WebP
  const newImage = new Map(); // bv → Buffer
  let imgBefore = 0, imgAfter = 0;
  const texLog = [];
  for (const [bvi, ii] of imageViews) {
    const bv = json.bufferViews[bvi], im = json.images[ii];
    const raw = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    imgBefore += raw.length;
    if (!opt.maxTex || !/png|jpeg/.test(im.mimeType || '')) { imgAfter += raw.length; continue; }
    const img = sharp(raw, { failOn: 'none' });
    const meta = await img.metadata();
    const big = Math.max(meta.width, meta.height);
    const k = Math.min(1, opt.maxTex / big);
    let pipe = sharp(raw, { failOn: 'none' });
    if (k < 1) pipe = pipe.resize(Math.max(1, Math.round(meta.width * k)), Math.max(1, Math.round(meta.height * k)), { kernel: 'lanczos3' });
    const alpha = meta.hasAlpha && !(await sharp(raw).stats()).isOpaque;
    if (!alpha) pipe = pipe.removeAlpha();
    const out = await pipe.webp({ quality: opt.q || 85, alphaQuality: 100, effort: 6, smartSubsample: true }).toBuffer();
    if (k >= 1 && out.length >= raw.length * 0.9) { imgAfter += raw.length; continue; } // маленькая картинка: WebP не выигрывает
    newImage.set(bvi, out);
    imgAfter += out.length;
    texLog.push(`${meta.width}→${Math.round(meta.width * k)}${alpha ? 'α' : ''}:${(raw.length / 1024) | 0}→${(out.length / 1024) | 0}K`);
    im.mimeType = 'image/webp';
    for (const t of json.textures || []) if (t.source === ii) { t.extensions = { ...(t.extensions || {}), [WEBP]: { source: ii } }; delete t.source; }
  }
  if (newImage.size) addExt(json, WEBP);

  // 2. геометрия и анимации → meshopt
  const chunks = [];
  let binLen = 0, fbLen = 0, geoBefore = 0, geoAfter = 0, maxErr = {};
  const push = (buf, align = 4) => { const pad = (align - (binLen % align)) % align; if (pad) { chunks.push(Buffer.alloc(pad)); binLen += pad; } const off = binLen; chunks.push(buf); binLen += buf.length; return off; };
  let anyMeshopt = false;
  json.bufferViews.forEach((bv, i) => {
    const raw = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    if (imageViews.has(i)) { const data = newImage.get(i) || raw; bv.byteOffset = push(data); bv.byteLength = data.length; bv.buffer = 0; return; }
    const plan = planView(json, bv, roles.get(i));
    let enc = null, filtered = raw;
    if (plan) {
      if (plan.filter === 'EXPONENTIAL') {
        const f32 = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
        filtered = Buffer.from(MeshoptEncoder.encodeFilterExp(f32, plan.count, plan.stride, plan.exp[0], plan.exp[1]));
      }
      enc = Buffer.from(MeshoptEncoder.encodeGltfBuffer(new Uint8Array(filtered.buffer, filtered.byteOffset, filtered.length), plan.count, plan.stride, plan.mode, 0));
      // проверка: распаковка тем же алгоритмом, что у GLTFLoader, и сверка с исходником
      const dec = new Uint8Array(plan.count * plan.stride);
      MeshoptDecoder.decodeGltfBuffer(dec, plan.count, plan.stride, enc, plan.mode, plan.filter);
      if (plan.filter) {
        const a = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)), b = new Float32Array(dec.buffer);
        let e = 0, mag = 0;
        for (let j = 0; j < a.length; j++) { e = Math.max(e, Math.abs(a[j] - b[j])); mag = Math.max(mag, Math.abs(a[j])); }
        const k = plan.role; if (!maxErr[k] || maxErr[k].e < e) maxErr[k] = { e, mag };
        if (!(e <= mag * 2 ** -(plan.exp[0] - 3) + 1e-9)) throw new Error(`${rel}: bufferView ${i} (${k}) ошибка ${e} при размахе ${mag}`);
      } else if (plan.mode === 'TRIANGLES') {
        // кодек треугольников может повернуть вершины внутри треугольника (abc → bca): обход и порядок
        // треугольников те же, картинка та же
        const A = plan.stride === 2 ? new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)) : new Uint32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
        const B = plan.stride === 2 ? new Uint16Array(dec.buffer) : new Uint32Array(dec.buffer);
        for (let j = 0; j < A.length; j += 3) {
          const a = A[j], b = A[j + 1], c = A[j + 2], x = B[j], y = B[j + 1], z = B[j + 2];
          if (!((a === x && b === y && c === z) || (a === y && b === z && c === x) || (a === z && b === x && c === y))) throw new Error(`${rel}: bufferView ${i}: треугольник ${j / 3} изменился`);
        }
      } else if (Buffer.compare(Buffer.from(dec), raw) !== 0) throw new Error(`${rel}: bufferView ${i} не совпал после распаковки`);
      if (enc.length >= raw.length * 0.95) enc = null; // не выигрываем — оставляем как было
    }
    geoBefore += raw.length;
    if (!enc) { bv.byteOffset = push(raw); bv.buffer = 0; geoAfter += raw.length; return; }
    anyMeshopt = true;
    const off = push(enc);
    geoAfter += enc.length;
    const fbOff = Math.ceil(fbLen / 16) * 16;
    fbLen = fbOff + bv.byteLength;
    bv.buffer = 1; bv.byteOffset = fbOff;
    const ext = { buffer: 0, byteOffset: off, byteLength: enc.length, byteStride: plan.stride, count: plan.count, mode: plan.mode };
    if (plan.filter) ext.filter = plan.filter;
    bv.extensions = { ...(bv.extensions || {}), [MESHOPT]: ext };
  });
  const newBin = Buffer.concat(chunks);
  json.buffers[0].byteLength = newBin.length;
  if (anyMeshopt) {
    json.buffers[1] = { byteLength: fbLen, extensions: { [MESHOPT]: { fallback: true } } };
    addExt(json, MESHOPT);
  }
  const out = writeGlb(json, newBin);
  if (!CHECK) writeFileSync(file, out);
  const MB = (b) => (b / 1048576).toFixed(2);
  console.log(`${rel}: ${MB(src.length)} → ${MB(out.length)} МБ  (картинки ${MB(imgBefore)}→${MB(imgAfter)}, буферы ${MB(geoBefore)}→${MB(geoAfter)}, JSON ${MB(Buffer.byteLength(JSON.stringify(json)))})`);
  if (texLog.length) console.log('   текстуры:', texLog.join(' '));
  const errs = Object.entries(maxErr).map(([k, v]) => `${k} ±${v.e.toExponential(1)} (до ${v.mag.toFixed(2)})`);
  if (errs.length) console.log('   точность:', errs.join(', '));
  return { rel, before: src.length, after: out.length };
}

async function compressTexture(t) {
  const src = join(ROOT, t.src), out = join(ROOT, t.out);
  if (!existsSync(src)) { if (existsSync(out)) return { rel: t.out, before: 0, after: readFileSync(out).length, skipped: true }; console.warn('нет', t.src); return null; }
  const raw = readFileSync(src);
  const meta = await sharp(raw).metadata();
  const buf = await sharp(raw).resize(Math.min(t.size, meta.width), Math.min(t.size, meta.height), { kernel: 'lanczos3' }).webp({ quality: t.q, effort: 6, smartSubsample: true }).toBuffer();
  if (!CHECK) writeFileSync(out, buf);
  console.log(`${t.out}: ${meta.width}px ${(raw.length / 1024) | 0}K → ${Math.min(t.size, meta.width)}px ${(buf.length / 1024) | 0}K`);
  return { rel: t.out, before: raw.length, after: buf.length };
}

await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const only = argv.filter((a) => !a.startsWith('--') && a !== DEPS);
const res = [];
for (const [rel, opt] of Object.entries(MODELS)) if (!only.length || only.some((o) => rel.includes(o))) res.push(await compressModel(rel, opt));
for (const t of TEXTURES) if (!only.length || only.some((o) => t.src.includes(o))) res.push(await compressTexture(t));
const ok = res.filter(Boolean);
const b = ok.reduce((s, r) => s + r.before, 0), a = ok.reduce((s, r) => s + r.after, 0);
console.log(`итого: ${(b / 1048576).toFixed(2)} → ${(a / 1048576).toFixed(2)} МБ${CHECK ? ' (--check: файлы не записаны)' : ''}`);
