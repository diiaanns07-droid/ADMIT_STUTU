// [W5-СЛОЖНОСТЬ] Скриншоты сложности для PR и ручной проверки (1366×768, «Отладка с клавиатуры», виртуальное время):
//   01_menu            — меню: ряд «Лёгкая | Обычная | Сложная | Кошмар» на виду, панель без прокрутки;
//   02_settings        — «Настройки» раскрыты: тот же выбор;
//   03_hard_battle     — бой на «Сложной»: значок у полосы Регента, «!» и подпись нового приёма (залп / двойной удар);
//   04_nightmare_trap  — «Кошмар»: «Каменный капкан» — несколько кругов на полу;
//   05_victory_normal  — победа на «Обычной»: сложность, очки, «попробуй «Сложную»!», зал славы дня, кнопка;
//   06_defeat_hard     — поражение на «Сложной»: совет и кнопка «Полегче: «Обычная»»;
//   07_video           — видео «Кошмара» (--video путь.mp4): капкан, залп, двойной удар — кадр в кадр, 30 к/с.
// node tools/difficulty_shots.mjs [--out docs/screenshots/w5-difficulty] [--only 01,03] [--video docs/video/w5_nightmare.mp4] [--chromium путь]
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { HERE, sleep, args, loadPlaywright, chromiumPath, startServer, launchBrowser, openGame } from './visual_common.mjs';

const A = args();
const OUT = resolve(HERE, A.of('--out', 'docs/screenshots/w5-difficulty'));
const ONLY = A.of('--only', null) ? String(A.of('--only')).split(',') : null;
const SIZE = [1366, 768];
const want = (id) => !ONLY || ONLY.some((x) => id.startsWith(x));
const log = (m) => console.log(m);
mkdirSync(OUT, { recursive: true });

const { chromium } = loadPlaywright();
const server = await startServer(HERE);
const browser = await launchBrowser(chromium, chromiumPath(A.of('--chromium', null)));
const report = {};
const shot = async (g, id) => { const f = join(OUT, `${id}.jpg`); await g.page.screenshot({ path: f, type: 'jpeg', quality: 86 }); log(`  ${id}.jpg`); return f; };

async function session(settings, patch, fn) {
  const g = await openGame(browser, server, { size: SIZE, settings: { quality: 'low', hero: 'ashen', startZone: 'edge', startZoneV: 2, ...settings }, patch, log: (m) => log(`  ${m}`) });
  try { await fn(g); } finally {
    if (g.errors.length) log(`  ошибки страницы: ${g.errors.slice(0, 4).join(' | ')}`);
    await g.ctx.close();
  }
}

try {
  if (want('01') || want('02')) {
    await session({ difficulty: 'hard' }, {}, async (g) => {
      await sleep(1500);
      const m = await g.page.evaluate(() => {
        const p = document.querySelector('.ao-panel--menu');
        const fs = document.querySelector('.ao-fieldset--diff');
        const r = fs ? fs.getBoundingClientRect() : null;
        const checked = fs ? fs.querySelector('input:checked') : null;
        return { overflow: p ? p.scrollHeight - p.clientHeight : null, rowY: r ? Math.round(r.top) : null, rowH: r ? Math.round(r.height) : null, rowW: r ? Math.round(r.width) : null, checked: checked && checked.value, buttons: fs ? [...fs.querySelectorAll('.ao-seg__label')].map((x) => x.textContent) : [] };
      });
      report.menu = m;
      log(`  меню: ${JSON.stringify(m)}`);
      if (want('01')) await shot(g, '01_menu');
      if (want('02')) {
        await g.page.locator('.ao-disclose', { hasText: 'Настройки' }).click();
        await sleep(400);
        await g.page.evaluate(() => { const b = document.querySelector('.ao-menu__setbody'); if (b) b.scrollIntoView({ block: 'end' }); });
        await shot(g, '02_settings');
      }
    });
  }

  // бой: ждём телеграф нужного приёма, держим огонь, снимок в момент «!»
  async function battleShot(level, moves, id) {
    await session({ difficulty: level }, { levels: { [level]: { bossHp: 3, bossDamage: 0.05 } } }, async (g) => {
      await g.toBattle();
      await g.walkToBoss();
      await g.page.keyboard.down('KeyJ');
      // крупные шаги (0,1 с боя на кадр: SwiftShader рисует кадр около секунды) до замаха нужного приёма, потом — по кадру до «!»
      let r = { ok: false, n: 0 };
      for (let tries = 0; tries < 12 && !r.ok; tries++) {
        const a = await g.stepUntil(`(s) => s && s.telegraphs.some((t) => ${JSON.stringify(moves)}.includes(t.move) && t.remaining > 0.4)`, { max: 400, ms: 100 });
        if (!a.ok) break;
        r = await g.stepUntil(`(s) => s && s.telegraphs.some((t) => ${JSON.stringify(moves)}.includes(t.move) && t.remaining < (t.cue || 0.9) && t.remaining > 0.12)`, { max: 30 });
      }
      await g.page.keyboard.up('KeyJ');
      const s = await g.page.evaluate(() => { const s = window.__ASHEN__.snapshot(); return { difficulty: s.difficulty, maxHp: s.boss.maxHp, tele: s.telegraphs.map((t) => ({ kind: t.kind, move: t.move, rem: +t.remaining.toFixed(2), cue: t.cue })) }; });
      report[id] = { found: r.ok, steps: r.n, ...s };
      log(`  ${id}: ${JSON.stringify(report[id])}`);
      await g.step(1);
      await shot(g, id);
    });
  }
  if (want('03')) await battleShot('hard', ['volley', 'double'], '03_hard_battle');
  if (want('04')) await battleShot('nightmare', ['trap'], '04_nightmare_trap');

  if (want('05')) {
    await session({ difficulty: 'normal' }, { normalHp: 0.15, normalDamage: 0 }, async (g) => {
      await g.toBattle();
      await g.walkToBoss();
      await g.page.keyboard.down('KeyJ');
      const r = await g.stepUntil('(s, A) => A.screen === "victory"', { max: 600, ms: 100 });
      await g.page.keyboard.up('KeyJ');
      await g.virtual(false);
      await sleep(800);
      report.victory = { ok: r.ok, steps: r.n, ...(await g.page.evaluate(() => ({
        rows: [...document.querySelectorAll('.ao-panel--victory .ao-stat')].filter((x) => !x.hidden).map((x) => x.textContent.trim()),
        lead: (document.querySelector('.ao-panel--victory .ao-lead') || {}).textContent || '',
        level: (document.querySelector('.ao-panel--victory .ao-result__levelline') || {}).textContent || '',
        btn: (document.querySelector('.ao-panel--victory .ao-result__level') || {}).textContent || '',
        hall: [...document.querySelectorAll('.ao-panel--victory .ao-fhall__row')].map((x) => x.textContent.trim()),
      }))) };
      log(`  победа: ${JSON.stringify(report.victory)}`);
      await shot(g, '05_victory_normal');
    });
  }

  if (want('06')) {
    await session({ difficulty: 'hard' }, { levels: { hard: { bossHp: 2, bossDamage: 1.6 } } }, async (g) => {
      await g.toBattle();
      await g.walkToBoss();
      await g.page.keyboard.down('KeyJ');   // огонь до конца: у Регента на итогах — часть здоровья
      const r = await g.stepUntil('(s, A) => A.screen === "defeat"', { max: 900, ms: 100 });
      await g.page.keyboard.up('KeyJ');
      await g.virtual(false);
      await sleep(800);
      report.defeat = { ok: r.ok, steps: r.n, ...(await g.page.evaluate(() => ({
        lead: (document.querySelector('.ao-panel--defeat .ao-lead') || {}).textContent || '',
        btn: (document.querySelector('.ao-panel--defeat .ao-result__level') || {}).textContent || '',
      }))) };
      log(`  поражение: ${JSON.stringify(report.defeat)}`);
      await shot(g, '06_defeat_hard');
    });
  }
  if (want('07')) {
    const OUTV = resolve(HERE, A.of('--video', 'docs/video/w5_nightmare.mp4'));
    await session({ difficulty: 'nightmare' }, { levels: { nightmare: { bossHp: 4, bossDamage: 0.05 } } }, async (g) => {
      await g.toBattle();
      await g.walkToBoss();
      const dir = mkdtempSync(join(tmpdir(), 'w5v-'));
      let n = 0;
      const rec = async (count) => {
        for (let i = 0; i < count; i++) { await g.step(1); await g.page.screenshot({ path: join(dir, `${String(n++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 85 }); }
      };
      await g.page.keyboard.down('KeyJ');
      const seen = [];
      for (const move of ['trap', 'volley', 'double']) {
        const w = await g.stepUntil(`(s) => s && s.telegraphs.some((t) => t.move === '${move}' && t.remaining > 0.5)`, { max: 600, ms: 100 });
        if (!w.ok) { log(`  видео: не дождались ${move}`); continue; }
        await rec(105);   // 3,5 с: замах, «!», удар
        seen.push(move);
      }
      await g.page.keyboard.up('KeyJ');
      mkdirSync(dirname(OUTV), { recursive: true });
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(dir, '%05d.jpg'), '-vf', 'scale=1280:-2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', '-movflags', '+faststart', OUTV]);
      rmSync(dir, { recursive: true, force: true });
      report.video = { file: OUTV, frames: n, moves: seen };
      log(`  видео: ${OUTV} (${n} кадров: ${seen.join(', ')})`);
    });
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(JSON.stringify(report, null, 1));
