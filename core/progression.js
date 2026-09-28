// Прогресс героя (ASHEN_V2). Владелец: №1.
// Очки клятвы приходят за настоящие отжимания и чистые приседания перед камерой (1 повтор = 1 очко) и за угли,
// зажжённые на плато (по 3 очка, каждый уголь один раз). Очки тратятся на улучшения.
// Хранится только в этом браузере (localStorage, ключ ashen.oath.v1); без хранилища — в памяти.
// Никуда не отправляется.
//
// createProgression({ storage?, key? }) → {
//   getView(), addPushups(n), addSquats(n), lightEmber(id), isEmberLit(id), buy(id), mods(), resetAll(), onChange(fn)
// }
// mods() — модификаторы для combat.setUpgrades(): аддитивные поля и множители (*Mul).

export const PROGRESSION_VERSION = 1;
export const EMBER_POINTS = 3;
export const PUSHUP_POINTS = 1;
export const SQUAT_POINTS = 1;

const lvlText = (fn) => (l) => fn(Math.max(0, l | 0));
export const UPGRADES = Object.freeze([
  {
    id: 'vitality', name: 'Живучесть', max: 5, costs: [2, 3, 5, 7, 9],
    text: lvlText((l) => `Здоровье +${l * 15}`),
    mods: (l) => ({ maxHp: 15 * l }),
  },
  {
    id: 'focus', name: 'Сосредоточение', max: 5, costs: [2, 3, 5, 7, 9],
    text: lvlText((l) => `Энергия +${l * 12}, восстановление +${l * 8}%`),
    mods: (l) => ({ maxEnergy: 12 * l, energyRegenMul: 1 + 0.08 * l }),
  },
  {
    id: 'stride', name: 'Лёгкий шаг', max: 3, costs: [2, 4, 7],
    text: lvlText((l) => `Бег +${l * 6}%, рывок перезаряжается на ${l * 10}% быстрее`),
    mods: (l) => ({ runSpeedMul: 1 + 0.06 * l, dashCooldownMul: 1 - 0.1 * l }),
  },
  {
    id: 'spark', name: 'Искра', max: 4, costs: [2, 4, 6, 9],
    text: lvlText((l) => `Урон «Искры» +${l * 20}%`),
    mods: (l) => ({ sparkDamageMul: 1 + 0.2 * l }),
  },
  {
    id: 'edge', name: 'Рассечение', max: 4, costs: [2, 4, 6, 9],
    text: lvlText((l) => `Урон «Рассечения» +${l * 15}%, дуга шире на ${l * 8}°`),
    mods: (l) => ({ slashDamageMul: 1 + 0.15 * l, slashAngleAdd: 8 * l }),
  },
  {
    id: 'ward', name: 'Щит клятвы', max: 3, costs: [2, 4, 7],
    text: lvlText((l) => `Щит тратит на ${l * 15}% меньше энергии, окно парирования +${l * 30} мс`),
    mods: (l) => ({ shieldDrainMul: 1 - 0.15 * l, parryWindowAdd: 0.03 * l }),
  },
  {
    id: 'burst', name: 'Выброс', max: 3, costs: [2, 4, 7],
    text: lvlText((l) => `Урон выброса +${l * 20}%, перезарядка −${l * 10}%`),
    mods: (l) => ({ burstDamageMul: 1 + 0.2 * l, burstCooldownMul: 1 - 0.1 * l }),
  },
]);
const BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));
const MAX_POINTS = 100000;

function fresh() { return { v: PROGRESSION_VERSION, points: 0, earned: 0, pushups: 0, squats: 0, embers: [], levels: {} }; }

function sanitize(raw) {
  const s = fresh();
  if (!raw || typeof raw !== 'object') return s;
  const int = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(MAX_POINTS, Math.floor(v))) : 0);
  s.points = int(raw.points); s.earned = int(raw.earned); s.pushups = int(raw.pushups);
  s.squats = int(raw.squats);   // старые сохранения без поля — 0
  if (Array.isArray(raw.embers)) s.embers = [...new Set(raw.embers.filter((e) => typeof e === 'string' && e.length < 40))].slice(0, 64);
  if (raw.levels && typeof raw.levels === 'object') {
    for (const u of UPGRADES) { const l = int(raw.levels[u.id]); if (l > 0) s.levels[u.id] = Math.min(u.max, l); }
  }
  return s;
}

export function combineMods(levels) {
  const out = {};
  for (const u of UPGRADES) {
    const l = levels && Number.isFinite(levels[u.id]) ? levels[u.id] : 0;
    if (l <= 0) continue;
    const m = u.mods(l);
    for (const k in m) {
      if (k.endsWith('Mul')) out[k] = (out[k] ?? 1) * m[k];
      else out[k] = (out[k] ?? 0) + m[k];
    }
  }
  return out;
}

export function createProgression(opts = {}) {
  const key = typeof opts.key === 'string' ? opts.key : 'ashen.oath.v1';
  let storage = opts.storage;
  if (storage === undefined) { try { storage = typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { storage = null; } }
  let st = fresh();
  try { const txt = storage && storage.getItem(key); if (txt) st = sanitize(JSON.parse(txt)); } catch (e) { st = fresh(); }
  const listeners = new Set();

  function save() { try { if (storage) storage.setItem(key, JSON.stringify(st)); } catch (e) { /* хранилище недоступно — прогресс живёт до перезагрузки */ } }
  function changed(reason) { save(); for (const fn of listeners) { try { fn(reason); } catch (e) { /* ignore */ } } }
  function give(n) { const k = Math.max(0, Math.floor(n)); st.points = Math.min(MAX_POINTS, st.points + k); st.earned = Math.min(MAX_POINTS, st.earned + k); return k; }

  function addPushups(n) {
    const k = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    if (!k) return 0;
    st.pushups = Math.min(MAX_POINTS, st.pushups + k);
    const got = give(k * PUSHUP_POINTS);
    changed('pushup');
    return got;
  }
  // Чистые приседания (с правильной техникой) — тоже очки клятвы.
  function addSquats(n) {
    const k = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    if (!k) return 0;
    st.squats = Math.min(MAX_POINTS, st.squats + k);
    const got = give(k * SQUAT_POINTS);
    changed('squat');
    return got;
  }
  function isEmberLit(id) { return st.embers.includes(String(id)); }
  function lightEmber(id) {
    const s = String(id);
    if (!s || isEmberLit(s)) return 0;
    st.embers.push(s);
    const got = give(EMBER_POINTS);
    changed('ember');
    return got;
  }
  function costOf(u) { const l = st.levels[u.id] || 0; return l >= u.max ? null : u.costs[l]; }
  function buy(id) {
    const u = BY_ID.get(id);
    if (!u) return { ok: false, reason: 'unknown' };
    const c = costOf(u);
    if (c === null) return { ok: false, reason: 'max' };
    if (st.points < c) return { ok: false, reason: 'points', need: c - st.points };
    st.points -= c;
    st.levels[u.id] = (st.levels[u.id] || 0) + 1;
    changed('buy');
    return { ok: true, level: st.levels[u.id] };
  }
  function getView() {
    return {
      points: st.points, earned: st.earned, pushups: st.pushups, squats: st.squats, embers: st.embers.slice(),
      upgrades: UPGRADES.map((u) => {
        const level = st.levels[u.id] || 0, cost = costOf(u);
        return {
          id: u.id, name: u.name, level, max: u.max, cost,
          canBuy: cost !== null && st.points >= cost,
          now: level > 0 ? u.text(level) : '',
          next: cost !== null ? u.text(level + 1) : '',
        };
      }),
    };
  }
  function mods() { return combineMods(st.levels); }
  function resetAll() { st = fresh(); changed('reset'); }
  function onChange(fn) { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); }

  return { getView, addPushups, addSquats, lightEmber, isEmberLit, buy, mods, resetAll, onChange };
}
