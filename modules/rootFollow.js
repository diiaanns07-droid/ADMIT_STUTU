// ASHEN OATH — [W5-ПОЛ] Высота корня героя по земле (свой герой — world.updateHero, соперник в дуэли — remotePlayer).
// Сглаживается только скачок (ступень арены): перепад земли за кадр больше max(2 см, 2,5 м/с·dt, половины пройденного
// по горизонтали) — корень догоняет экспонентой. Плавный склон корень повторяет сразу, и на бегу, и в рывке (3,6 м за
// 0,22 с) — иначе на подъёме он отставал на v·уклон/16 (до 10 см на бегу, до 30 см в рывке), а у героя-модели нет IK
// стоп по земле, и стопы уходили в склон.
//   followRootY(st, y, dt, dxz = 0) → st.rootY. st: { rootY, groundY } (меняется; rootY не число — сразу на землю),
//   y — земля сейчас, dxz — пройдено по горизонтали за кадр (м).

const dampK = (rate, dt) => 1 - Math.exp(-rate * dt);

export function followRootY(st, y, dt, dxz = 0) {
  if (!Number.isFinite(st.rootY) || Math.abs(y - st.rootY) > 1.2 || dt <= 0) st.rootY = y;
  else {
    const dg = Number.isFinite(st.groundY) ? y - st.groundY : 0;
    if (Math.abs(dg) <= Math.max(0.02, 2.5 * dt, 0.5 * dxz)) st.rootY += dg;
    st.rootY += (y - st.rootY) * dampK(y > st.rootY ? 16 : 11, dt);
  }
  st.groundY = y;
  return st.rootY;
}
