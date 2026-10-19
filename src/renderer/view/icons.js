const NS = 'http://www.w3.org/2000/svg'

const ICONS = {
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  panel: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M15 4v16' }]],
  send: [['path', { d: 'M12 19V5M6 11l6-6 6 6' }]],
  stop: [['rect', { x: 7, y: 7, width: 10, height: 10, rx: 2, fill: 'currentColor' }]],
  close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  chevron: [['path', { d: 'M6 9l6 6 6-6' }]],
  trace: [['path', { d: 'M3 12h4l3-8 4 16 3-8h4' }]],
  globe: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18' }]],
  file: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 3v5h5' }]],
  mail: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ['path', { d: 'M3 7l9 6 9-6' }]],
  history: [['path', { d: 'M3 12a9 9 0 1 0 3-6.7L3 8' }], ['path', { d: 'M3 3v5h5M12 7v5l3 2' }]],
  more: [['circle', { cx: 5, cy: 12, r: 1.4, fill: 'currentColor' }], ['circle', { cx: 12, cy: 12, r: 1.4, fill: 'currentColor' }], ['circle', { cx: 19, cy: 12, r: 1.4, fill: 'currentColor' }]],
  search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M20 20l-3.5-3.5' }]],
  gear: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1' }]],
}

/**
 * Stroke icon that inherits `currentColor`; hidden from assistive tech (buttons carry aria-label).
 * @param {keyof typeof ICONS} name
 * @param {number} [size]
 * @returns {SVGSVGElement}
 */
export function icon(name, size = 18) {
  const svg = document.createElementNS(NS, 'svg')
  const attrs = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  }
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, String(value))
  for (const [tag, shapeAttrs] of ICONS[name] ?? []) {
    const shape = document.createElementNS(NS, tag)
    for (const [key, value] of Object.entries(shapeAttrs)) shape.setAttribute(key, String(value))
    svg.append(shape)
  }
  return svg
}
