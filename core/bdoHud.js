// ASHEN OATH — core/bdoHud.js. Владелец: №8 [BDO].
// DOM-слой боевого HUD в стиле Black Desert поверх 3D-сцены и canvas-HUD (под экранами ui.js):
// панель умений с иконками и круговыми откатами, полосы HP/MP/выносливости, рамка цели,
// мини-карта, титр зоны, уведомления справа. Вызывается из core/battleHud.js каждый кадр
// с тем же объектом f (см. battleHud.js). При settings.bdoUi === false слой скрыт.
// ЗАГЛУШКА — наполняется в рамках V6 [BDO].

export function createBdoHud({ root } = {}) {
  return {
    frame() {},
    reset() {},
    dispose() {},
  };
}
