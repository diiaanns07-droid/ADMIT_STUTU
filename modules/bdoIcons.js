// ASHEN OATH — modules/bdoIcons.js. Владелец: №8 [BDO].
// SVG-иконки умений, 10 рун и печатей в едином стиле BDO. ЗАГЛУШКА — наполняется в V6 [BDO].
// iconSvg(id) → строка <svg …> (viewBox 0 0 64 64), всегда что-то возвращает.

export const BDO_ICONS = {};

export function iconSvg(id) {
  return BDO_ICONS[id] || '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="8" y="8" width="48" height="48" fill="none" stroke="#d8b36a" stroke-width="2"/><path d="M32 16 L46 32 L32 48 L18 32 Z" fill="none" stroke="#f3dca0" stroke-width="2"/></svg>';
}
