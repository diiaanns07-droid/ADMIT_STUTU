// ASHEN OATH — modules/fx/index.js. Владелец: №7 [VFX].
// Слой эффектов V6 поверх modules/effects.js. effects.js создаёт его один раз и спрашивает:
//   v6.handle(type, ev, d) → true, если V6 полностью нарисовал событие (старый эффект пропускается);
//   false/undefined — старый эффект рисуется как раньше (V6 мог добавить свои слои сверху).
// Подсистемы и хореографии грузятся динамически: любой сбой = откат к старым эффектам.
//
// Модуль хореографии: export function register(fx) { fx.on('rune_cast', (ev, d, fx) => {...; return true;}, d => d.rune === 'ignis'); fx.every((dt, snap, fx) => {...}); }
// fx — общий контекст (см. makeContext ниже): подсистемы (kit, glyph, bolts, trails, decals, shock, hex),
// якоря героя/соперника, цель, палитры стихий, PvP-окраска, подавление старых «постоянных» эффектов.

import { createFxKit, SPRITES } from './kit.js';
import { ELEMENTS, heroElement } from './glsl.js';

export const FX_V6_VERSION = 'ASHEN_V6-fx-1';

// Подсистемы: [ключ, файл, экспорт фабрики]. Отсутствующий файл или ошибка — подсистема = null.
const SUBSYSTEMS = [
  ['glyph', './glyph.js', 'createGlyphs'],
  ['bolts', './bolts.js', 'createBolts'],
  ['trails', './trails.js', 'createTrails'],
  ['decals', './decals.js', 'createDecals'],
  ['shock', './shock.js', 'createShock'],
  ['hex', './shieldHex.js', 'createHexShield'],
];
// Хореографии (порядок = приоритет обработчиков). Слои-«добавки» (возвращают не true) — раньше тех, кто рисует событие целиком.
// [W3-МАГИЯ] магии ладонями: заряд между ладонями, «Врата бури», «Столп небес»; ядро/ореол/свет снарядов и сочные попадания.
const CHOREO = [
  './sigilCharge.js',
  './sigilGate.js',
  './sigilPillar.js',
  './castFx.js',
  './hitFx.js',
  './handMagic.js',
  './runesFire.js',
  './runesLight.js',
  './runesSky.js',
  './runesWild.js',
  './sigils.js',
  './bowHand.js',
  './combatFx.js',
];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const hasVec = (o) => !!o && typeof o === 'object' && isNum(o.x) && isNum(o.y) && isNum(o.z);

/**
 * deps: { THREE, root, camera, renderer, quality, reducedMotion(), lightUnit, onShake, onKick,
 *         anchor(name, out, remote) → out|null, groundY(x, z, fallback), legacy:{...} }
 * Возвращает объект сразу; ready — Promise, которое разрешается, когда всё подгружено.
 */
export function createFxV6(deps) {
  const { THREE } = deps;
  const kit = createFxKit(deps);
  const handlers = new Map(); // type → [{fn, filter, src}]
  const everies = [];
  const clearers = [];
  const disposers = [];
  const suppressedKeys = new Set();
  const warned = new Set();
  const loaded = { subsystems: [], choreo: [], failed: [] };
  let snap = null, input = null, enabled = true, quality = deps.quality || 'medium';
  // [W4-ЗАКЛИНАНИЯ] выбранный герой (effects.js передаёт живую настройку)
  const heroId = () => { try { return typeof deps.heroId === 'function' ? deps.heroId() : deps.heroId; } catch (e) { return null; } };
  const V3 = THREE.Vector3;
  const _a = new V3(), _b = new V3();

  function warn(key, e) { if (warned.has(key)) return; warned.add(key); console.warn('[fx/v6]', key, e); }

  // ---------------------------------------------------------------- контекст хореографий
  const fx = {
    THREE, kit, E: ELEMENTS, SPRITES,
    glyph: null, bolts: null, trails: null, decals: null, shock: null, hex: null,
    legacy: deps.legacy || {},
    external: { bow: false },   // части, которые рисует чужой модуль (bow — 3D-лук modules/handVisuals.js №6)
    get snap() { return snap; },
    get input() { return input; },
    get clock() { return kit.clock; },
    get Q() { return kit.Q; },
    reduced: kit.reduced,
    on(type, fn, filter) {
      if (typeof type !== 'string' || typeof fn !== 'function') return;
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push({ fn, filter: typeof filter === 'function' ? filter : null, src: fx._src || '?' });
    },
    every(fn) { if (typeof fn === 'function') everies.push({ fn, src: fx._src || '?' }); },
    // сброс боя (effects.reset / перезапуск combat): хореография обнуляет свои долгие состояния
    onClear(fn) { if (typeof fn === 'function') clearers.push({ fn, src: fx._src || '?' }); },
    // [W3-МАГИЯ] dispose слоя: хореография освобождает свои меши/материалы/геометрии
    onDispose(fn) { if (typeof fn === 'function') disposers.push({ fn, src: fx._src || '?' }); },
    // общее состояние хореографий (заряд печати → выпуск врат/столпа) и QA-подмена снимка (стенд, видео)
    shared: {},
    qa: { charge: null },
    suppress(key) { suppressedKeys.add(key); },
    // PvP: событие соперника (data.remote) рисуется теми же эффектами в его цвете
    rival: (d) => (d && d.remote ? 1 : 0),
    isRemote: (d) => !!(d && d.remote),
    // палитра стихии; для соперника — холодный фиолетовый
    pal: (el, d) => (d && d.remote ? ELEMENTS.rival : (ELEMENTS[el] || ELEMENTS.gold)),
    // [W4-ЗАКЛИНАНИЯ] стихия героя (settings.hero): его «общие» заклинания окрашены ею; соперник — 'rival'
    heroEl: (d) => (d && d.remote ? 'rival' : heroElement(heroId())),
    heroPal: (d) => (d && d.remote ? ELEMENTS.rival : (ELEMENTS[heroElement(heroId())] || ELEMENTS.fire)),
    // якоря: name ∈ handR | handL | chest | head | feet | staffTip | bowSocket
    anchor: (name, out, remote) => kit.anchor(name, out || new V3(), !!remote),
    /** Позиция события или null. */
    evPos(ev, out) { return ev && hasVec(ev.position) ? out.set(ev.position.x, ev.position.y, ev.position.z) : null; },
    /** Точка/объект из data (from/to) или null. */
    vec(v, out) { return hasVec(v) ? out.set(v.x, v.y, v.z) : null; },
    /** Центр цели заклинателя: для своего — lockTarget/ядро Регента; для соперника — грудь нашего героя. */
    target(out, remote) {
      if (remote) return kit.anchor('chest', out, false);
      const lt = snap && snap.lockTarget;
      if (lt && hasVec(lt.position)) {
        if (lt.kind === 'player') return out.set(lt.position.x, lt.position.y + 1.25, lt.position.z);
        return out.set(lt.position.x, lt.position.y + 2.6, lt.position.z);
      }
      const b = snap && snap.boss;
      if (b && hasVec(b.position)) return out.set(b.position.x, b.position.y + 2.6, b.position.z);
      return out.set(0, 2.6, 0);
    },
    /** Земля под точкой цели (для декалей/колец). */
    targetGround(out, remote) {
      fx.target(out, remote);
      out.y = kit.groundY(out.x, out.z, remote ? (snap && snap.player && snap.player.position ? snap.player.position.y : 0) : (snap && snap.boss && snap.boss.position ? snap.boss.position.y : 0));
      return out;
    },
    /** Горизонтальное направление «заклинатель → цель» (единичное). */
    facing(out, remote) {
      kit.anchor('feet', _a, remote);
      fx.target(_b, remote);
      out.set(_b.x - _a.x, 0, _b.z - _a.z);
      if (out.lengthSq() < 1e-6) out.set(0, 0, -1);
      return out.normalize();
    },
    /** Правое направление от заклинателя (по экрану, если камера за спиной). */
    right(out, remote) { fx.facing(out, remote); return out.set(-out.z, 0, out.x); },
    groundY: (x, z, fb) => kit.groundY(x, z, fb),
    // простые помощники
    lerpV(out, a, b, t) { return out.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); },
    _src: null,
  };

  // ---------------------------------------------------------------- загрузка
  const makeDeps = () => ({ THREE, root: deps.root, camera: deps.camera, renderer: deps.renderer, quality });
  const ready = (async () => {
    for (const [key, file, factory] of SUBSYSTEMS) {
      try {
        const m = await import(file);
        if (typeof m[factory] !== 'function') throw new Error('нет ' + factory);
        const sys = m[factory](makeDeps());
        if (sys && typeof sys.setQuality === 'function') { try { sys.setQuality(quality); } catch (e) { /* ignore */ } }
        if (sys && typeof sys.setReducedMotion === 'function') { try { sys.setReducedMotion(!!kit.reduced()); } catch (e) { /* ignore */ } }
        fx[key] = sys;
        loaded.subsystems.push(key);
      } catch (e) { loaded.failed.push(key); warn('sub:' + key, e && e.message); }
    }
    for (const file of CHOREO) {
      try {
        const m = await import(file);
        if (typeof m.register !== 'function') throw new Error('нет register');
        fx._src = file;
        m.register(fx);
        fx._src = null;
        loaded.choreo.push(file);
      } catch (e) { fx._src = null; loaded.failed.push(file); warn('choreo:' + file, e && e.message); }
    }
    return true;
  })();

  // ---------------------------------------------------------------- диспетчер
  function handle(type, ev, d) {
    if (!enabled) return false;
    // PvP (modules/pvp.js №3): касты соперника приходят как pvp_opponent_cast {sourceType, ...данные, remote:true}
    if (type === 'pvp_opponent_cast' && d && typeof d.sourceType === 'string' && d.sourceType !== type) {
      return handle(d.sourceType, ev, d.remote ? d : Object.assign({}, d, { remote: true }));
    }
    const list = handlers.get(type);
    if (!list) return false;
    let done = false;
    // [W4-ЗАКЛИНАНИЯ] сцена эффекта: всё, что нарисует событие (и его акторы), — одна сцена с приоритетом свежести
    const prevScope = kit.currentScope;
    const sk = scopeKey(type, d);
    // очередь «OK»-снарядов и искр — одна сцена со свежестью от начала очереди; удары и касты — «молодеют»
    if (sk !== null) kit.scope(sk, undefined, !(sk === 'bolt' || sk === 'spark' || sk === 'r:bolt' || sk === 'r:spark'));
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      try {
        if (h.filter && !h.filter(d, ev)) continue;
        if (h.fn(ev, d, fx) === true) { done = true; break; }
      } catch (e) { warn('h:' + type + ':' + h.src, e); }
    }
    kit.enterScope(prevScope);
    return done;
  }
  // [W4-ЗАКЛИНАНИЯ] ключ сцены события (null — без сцены): касты — по заклинанию, удары — общая серия
  function scopeKey(type, d) {
    const r = d && d.remote ? 'r:' : '';
    switch (type) {
      case 'rune_cast': return r + 'rune:' + (d && d.rune);
      case 'player_cast': return r + (d && d.ability === 'rune' ? 'rune:' + d.rune : d && (d.ability === 'bolt' || d.ability === 'spark') ? d.ability : '');
      case 'burst': return r + 'burst';
      case 'sigil_cast': return r + 'sigil:' + (d && d.sigil);
      case 'hand_spell_throw': case 'bow_release': case 'player_slash': case 'ultimate_cast': return '';
      case 'projectile_impact': case 'boss_hit': case 'rune_hit': case 'sigil_hit': case 'arrow_hit': case 'hand_spell_hit': case 'player_hit': return r + 'hit';
      default: return null;
    }
  }
  function update(dt, snapshot) {
    snap = snapshot && typeof snapshot === 'object' ? snapshot : null;
    if (enabled) {
      for (let i = 0; i < everies.length; i++) {
        try { everies[i].fn(dt, snap, fx); } catch (e) { warn('every:' + everies[i].src, e); }
      }
    }
    kit.update(dt);
    const clock = kit.clock;
    for (const k of ['glyph', 'bolts', 'trails', 'decals', 'shock', 'hex']) {
      const s = fx[k];
      if (s && typeof s.update === 'function') { try { s.update(dt, clock); } catch (e) { warn('upd:' + k, e); } }
    }
  }
  function each(method, arg) {
    for (const k of ['glyph', 'bolts', 'trails', 'decals', 'shock', 'hex']) {
      const s = fx[k];
      if (s && typeof s[method] === 'function') { try { s[method](arg); } catch (e) { warn(method + ':' + k, e); } }
    }
  }
  return {
    version: FX_V6_VERSION, ready, fx, kit,
    handle, update,
    setSnapshot(s) { snap = s; },
    setInput(i) { input = i || null; },
    setEnabled(v) { enabled = !!v; if (!enabled) { kit.clear(); each('clear'); } },
    get enabled() { return enabled; },
    suppressed: (key) => enabled && suppressedKeys.has(key),
    setQuality(q) { quality = q; kit.setQuality(q); each('setQuality', q); },
    setReducedMotion(v) { each('setReducedMotion', !!v); },
    takeHitStop: () => kit.takeHitStop(),
    clear() {
      for (let i = 0; i < clearers.length; i++) { try { clearers[i].fn(fx); } catch (e) { warn('clear:' + clearers[i].src, e); } }
      kit.clear(); each('clear');
    },
    dispose() {
      for (let i = 0; i < disposers.length; i++) { try { disposers[i].fn(fx); } catch (e) { warn('dispose:' + disposers[i].src, e); } }
      disposers.length = 0;
      each('dispose'); kit.dispose();
    },
    stats() {
      const sub = {};
      for (const k of ['glyph', 'bolts', 'trails', 'decals', 'shock', 'hex']) { const s = fx[k]; if (s && typeof s.stats === 'function') { try { sub[k] = s.stats(); } catch (e) { sub[k] = null; } } }
      return { kit: kit.stats(), sub, loaded, handlers: Array.from(handlers.keys()) };
    },
  };
}
