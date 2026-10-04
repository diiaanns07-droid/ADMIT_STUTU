// =============================================================================
// coop.js — ASHEN OATH · [КООП] «Вместе против Регента»: онлайн-бой вдвоём с общим Регентом.
// -----------------------------------------------------------------------------
// Связь, герой напарника, его снаряды и эффекты — уже в net/session.js (как в дуэли).
// Здесь — только общий Регент:
//   co   {d}  — урон, который я нанёс Регенту за кадр; напарник вычитает его у своего Регента;
//   coHp {hp} — хост раз в 0,5 с присылает здоровье Регента; у гостя оно не выше (пропуски догоняются).
// Атаки Регента каждый компьютер считает сам (босс бьёт своего игрока) — полной синхронизации босса нет.
// Без DOM: модуль проверяется в Node (dev/coop.test.mjs).
// =============================================================================

export const COOP_HP_EVERY_MS = 500;
const MAX_DAMAGE = 10000;   // защита от мусора в сообщении

// net: { send(type, payload), on(type, fn) → off, isHost }; combat: { coopDamage, coopSyncHp, getSnapshot }
export function createCoop({ net, combat }) {
  let on = true;
  let out = 0;
  let lastHp = -1e9;
  const stats = { sent: 0, got: 0, synced: 0 };
  const offs = [
    net.on('co', (m) => {
      const d = Number(m && m.d);
      if (!on || !(d > 0) || d > MAX_DAMAGE) return;
      stats.got += combat.coopDamage(d) || 0;
    }),
    net.on('coHp', (m) => {
      const hp = Number(m && m.hp);
      if (!on || net.isHost || !Number.isFinite(hp)) return;
      combat.coopSyncHp(hp);
      stats.synced++;
    }),
  ];
  return {
    get active() { return on; },
    // раз в кадр после combat.update: свой урон по Регенту — напарнику; хост — здоровье Регента
    afterUpdate(events, now) {
      if (!on) return;
      if (events && events.length) {
        for (const e of events) {
          if (e && e.type === 'boss_hit' && e.data && !e.data.remote && e.data.target !== 'opponent') out += Number(e.data.amount) || 0;
        }
      }
      if (out > 0) { net.send('co', { d: Math.round(out * 100) / 100 }); stats.sent += out; out = 0; }
      if (net.isHost && now - lastHp >= COOP_HP_EVERY_MS) {
        const s = combat.getSnapshot();
        if (s && s.boss && Number.isFinite(s.boss.hp)) { net.send('coHp', { hp: s.boss.hp }); lastHp = now; }
      }
    },
    stop() { on = false; for (const off of offs) { try { if (typeof off === 'function') off(); } catch (e) { /* ignore */ } } },
    debug() { return { active: on, ...stats }; },
  };
}
