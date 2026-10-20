/**
 * Viva's cat, traced from the app icon (design canvas "Viva 猫猫形象融入", Cat): a three-quarter head with
 * a little body, orange inner ears, two tilted eyes and an ω mouth, plus a prop for some moods (thought
 * bubble, keyboard, a ! or ? sign, sparkles, a sweat drop). With `frame` it sits on its brand-blue disc:
 * the body is cut by the disc, the ears rise over its edge. Motion is CSS (styles.css, .cat-*), still when
 * the system asks for reduced motion.
 *
 * Views are rebuilt often (every frame while an answer streams, every second for the clock), so a cat is
 * kept per slot and reused while its look stays the same: a rebuilt node would restart its animations.
 */
const NS = 'http://www.w3.org/2000/svg'
const INK = '#0E1222'
const EYE = '#B0FCFC'
const EAR = '#FE8838'
const PAPER = '#EEF3FF'
const KEY = '#A3B0CC'
/** The drawing's 120-unit box, and the part of it the disc covers (a circle of radius 55.2 at 60, 75.4). */
const BOX = 120
const DISC = 110.4
const DISC_LEFT = 4.8
const DISC_TOP = 20.2

export const CAT_MOODS = Object.freeze(['idle', 'thinking', 'typing', 'confirm', 'ask', 'done', 'error'])

const BODY = 'M84.8 16.2 C84.1 16.3 83.4 16.6 82.7 16.9 C82.0 17.1 81.4 17.5 80.7 17.9 C80.1 18.2 79.4 18.6 78.8 19.1 C78.2 19.5 77.6 19.9 77.0 20.4 C76.4 20.8 75.9 21.3 75.3 21.8 C74.7 22.3 74.2 22.8 73.7 23.4 C73.1 23.9 72.6 24.4 72.1 25.0 C71.6 25.5 71.1 26.1 70.6 26.7 C70.2 27.2 69.7 27.8 69.2 28.4 C68.8 29.0 68.4 29.6 67.9 30.2 C67.5 30.8 67.2 31.5 66.7 32.1 C66.2 32.6 65.8 33.2 65.1 33.5 C64.5 33.7 63.6 33.4 62.9 33.5 C62.2 33.5 61.4 33.6 60.7 33.7 C59.9 33.7 59.2 33.8 58.4 33.9 C57.7 34.0 57.0 34.2 56.2 34.3 C55.5 34.5 54.8 34.6 54.1 34.8 C53.3 35.0 52.6 35.2 51.9 35.4 C51.2 35.6 50.5 35.8 49.8 36.0 C49.1 36.3 48.4 36.5 47.7 36.8 C47.0 37.1 46.3 37.6 45.6 37.6 C44.9 37.6 44.2 37.3 43.6 37.0 C43.0 36.6 42.4 36.1 41.8 35.6 C41.2 35.2 40.6 34.7 40.0 34.3 C39.4 33.9 38.7 33.5 38.1 33.1 C37.5 32.7 36.8 32.3 36.2 32.0 C35.5 31.6 34.8 31.3 34.2 31.0 C33.5 30.7 32.8 30.4 32.1 30.1 C31.4 29.8 30.7 29.5 30.0 29.3 C29.3 29.1 28.6 28.9 27.9 28.7 C27.1 28.6 26.4 28.4 25.7 28.3 C24.9 28.2 24.2 28.2 23.4 28.2 C22.7 28.3 21.9 28.4 21.3 28.7 C20.6 29.0 20.0 29.5 19.4 30.0 C18.9 30.5 18.5 31.1 18.1 31.8 C17.8 32.4 17.5 33.1 17.2 33.8 C16.9 34.5 16.7 35.2 16.5 35.9 C16.3 36.6 16.1 37.4 16.0 38.1 C15.8 38.8 15.7 39.6 15.6 40.3 C15.4 41.0 15.3 41.8 15.3 42.5 C15.2 43.3 15.1 44.0 15.1 44.7 C15.0 45.5 15.0 46.2 15.0 47.0 C15.0 47.7 15.0 48.5 15.0 49.2 C15.0 50.0 15.0 50.7 15.0 51.4 C15.1 52.2 15.2 52.9 15.2 53.7 C15.3 54.4 15.4 55.2 15.5 55.9 C15.5 56.6 15.6 57.4 15.8 58.1 C15.9 58.9 16.0 59.6 16.1 60.3 C16.3 61.1 16.6 61.8 16.5 62.5 C16.4 63.2 15.9 63.9 15.5 64.5 C15.2 65.2 14.8 65.8 14.4 66.5 C14.1 67.1 13.7 67.8 13.4 68.5 C13.1 69.1 12.8 69.8 12.5 70.5 C12.2 71.2 11.9 71.9 11.7 72.6 C11.5 73.3 11.2 74.0 11.0 74.7 C10.8 75.4 10.7 76.2 10.5 76.9 C10.4 77.6 10.3 78.4 10.2 79.1 C10.1 79.9 10.1 80.6 10.1 81.3 C10.1 82.1 10.1 82.8 10.2 83.6 C10.3 84.3 10.4 85.1 10.6 85.8 C10.8 86.5 11.0 87.2 11.3 87.9 C11.6 88.6 11.9 89.3 12.2 89.9 C12.6 90.6 13.0 91.2 13.4 91.8 C13.9 92.4 14.3 93.0 14.9 93.5 C15.4 94.1 15.9 94.6 16.5 95.1 C17.1 95.5 17.7 95.9 18.3 96.3 C19.0 96.7 19.6 97.1 20.3 97.4 C21.0 97.7 21.7 98.0 22.4 98.3 C23.0 98.6 24.3 98.7 24.4 99.1 C24.5 99.5 23.7 100.2 23.2 100.7 C22.7 101.1 21.9 101.4 21.3 101.8 C20.6 102.2 20.0 102.6 19.4 103.0 C18.8 103.5 18.2 103.9 17.7 104.4 C17.1 104.9 16.5 105.4 16.0 105.9 C15.2 106.7 11.2 110.6 9.0 115.0 C6.8 119.4 5.8 124.6 5.5 130.0 L5.5 140 L112.5 140 L112.5 130.0 C112.2 123.6 110.4 117.6 107.4 113.0 C104.0 108.4 98.0 104.8 95.5 103.4 C95.0 102.9 94.4 102.4 93.9 101.9 C93.3 101.4 92.7 100.9 92.2 100.4 C91.6 100.0 91.0 99.5 90.3 99.1 C89.7 98.7 89.0 98.4 88.4 98.0 C87.8 97.7 86.6 97.2 86.7 96.8 C86.7 96.4 87.8 96.1 88.5 95.8 C89.1 95.4 89.9 95.2 90.6 95.0 C91.3 94.7 92.0 94.4 92.6 94.1 C93.3 93.8 94.0 93.5 94.7 93.1 C95.3 92.8 96.0 92.5 96.6 92.1 C97.3 91.8 97.9 91.4 98.6 91.0 C99.2 90.6 99.8 90.2 100.4 89.7 C101.0 89.3 101.6 88.8 102.2 88.4 C102.8 87.9 103.3 87.4 103.9 86.9 C104.4 86.3 104.9 85.8 105.4 85.2 C105.9 84.7 106.3 84.1 106.7 83.4 C107.1 82.8 107.5 82.2 107.9 81.5 C108.2 80.8 108.5 80.2 108.7 79.5 C109.0 78.7 109.2 78.0 109.3 77.3 C109.5 76.6 109.6 75.8 109.7 75.1 C109.8 74.4 109.8 73.6 109.9 72.9 C109.9 72.1 109.8 71.4 109.7 70.6 C109.7 69.9 109.6 69.1 109.5 68.4 C109.3 67.7 109.2 66.9 109.0 66.2 C108.8 65.5 108.6 64.8 108.4 64.1 C108.2 63.4 107.9 62.7 107.7 62.0 C107.4 61.3 107.1 60.6 106.8 59.9 C106.5 59.2 106.2 58.5 105.8 57.9 C105.5 57.2 105.2 56.5 104.8 55.9 C104.4 55.3 104.0 54.6 103.6 54.0 C103.2 53.4 102.8 52.7 102.4 52.1 C102.0 51.5 101.4 51.0 101.1 50.3 C100.7 49.7 100.4 49.0 100.2 48.3 C100.0 47.6 100.1 46.8 100.0 46.1 C99.9 45.4 99.8 44.6 99.7 43.9 C99.6 43.1 99.5 42.4 99.4 41.7 C99.2 40.9 99.1 40.2 99.0 39.5 C98.8 38.7 98.6 38.0 98.5 37.3 C98.3 36.6 98.1 35.8 97.9 35.1 C97.7 34.4 97.5 33.7 97.3 33.0 C97.1 32.3 96.9 31.5 96.6 30.8 C96.4 30.1 96.1 29.4 95.9 28.7 C95.6 28.0 95.3 27.3 95.1 26.7 C94.8 26.0 94.4 25.3 94.1 24.6 C93.8 24.0 93.5 23.3 93.1 22.6 C92.7 22.0 92.4 21.3 91.9 20.7 C91.5 20.1 91.1 19.5 90.6 18.9 C90.1 18.4 89.6 17.8 89.0 17.4 C88.4 16.9 87.7 16.5 87.0 16.3 C86.4 16.1 85.6 16.1 84.8 16.2 Z'
const EAR_LEFT = 'M24.0 36.1 C23.5 36.2 23.0 36.4 22.7 36.7 C22.4 37.0 22.2 37.5 22.0 38.0 C21.8 38.4 21.7 38.9 21.6 39.4 C21.5 39.8 21.4 40.3 21.3 40.8 C21.2 41.3 21.2 41.7 21.1 42.2 C21.0 42.7 21.0 43.2 21.0 43.7 C20.9 44.1 20.9 44.6 20.9 45.1 C20.9 45.6 20.9 46.1 20.9 46.5 C21.0 47.0 21.0 47.5 21.0 48.0 C21.1 48.5 21.1 48.9 21.2 49.4 C21.2 49.9 21.3 50.4 21.4 50.9 C21.5 51.3 21.5 51.8 21.6 52.3 C21.7 52.8 21.8 53.2 21.9 53.7 C22.0 54.2 22.1 55.0 22.3 55.1 C22.5 55.2 22.9 54.7 23.2 54.4 C23.5 54.1 23.7 53.6 24.0 53.2 C24.3 52.8 24.6 52.5 24.9 52.1 C25.2 51.7 25.5 51.3 25.8 51.0 C26.1 50.6 26.4 50.2 26.8 49.9 C27.1 49.5 27.4 49.2 27.8 48.8 C28.1 48.5 28.4 48.1 28.8 47.8 C29.1 47.5 29.5 47.1 29.9 46.8 C30.2 46.5 30.6 46.2 30.9 45.9 C31.3 45.6 31.7 45.3 32.1 45.0 C32.5 44.7 32.8 44.4 33.2 44.1 C33.6 43.8 34.1 43.6 34.4 43.3 C34.7 42.9 35.2 42.6 35.2 42.2 C35.1 41.9 34.5 41.6 34.1 41.3 C33.8 40.9 33.4 40.6 33.0 40.3 C32.6 40.0 32.2 39.7 31.8 39.5 C31.5 39.2 31.0 38.9 30.6 38.7 C30.2 38.4 29.8 38.2 29.4 37.9 C29.0 37.7 28.6 37.5 28.1 37.3 C27.7 37.1 27.2 36.8 26.8 36.7 C26.4 36.5 25.9 36.3 25.4 36.2 C25.0 36.1 24.4 36.1 24.0 36.1 Z'
const EAR_RIGHT = 'M85.5 24.6 C85.1 24.7 84.6 24.9 84.2 25.2 C83.8 25.4 83.4 25.7 83.0 26.0 C82.7 26.3 82.3 26.6 81.9 26.9 C81.6 27.3 81.2 27.6 80.9 27.9 C80.6 28.3 80.3 28.7 80.0 29.0 C79.7 29.4 79.3 29.8 79.1 30.1 C78.8 30.5 78.5 30.9 78.2 31.3 C77.9 31.7 77.6 32.1 77.4 32.5 C77.1 32.9 76.8 33.3 76.6 33.7 C76.4 34.1 76.1 34.7 76.3 35.0 C76.5 35.2 77.2 35.3 77.6 35.4 C78.1 35.6 78.5 35.8 79.0 35.9 C79.4 36.1 79.9 36.3 80.3 36.5 C80.8 36.7 81.2 36.9 81.6 37.1 C82.1 37.3 82.5 37.5 82.9 37.7 C83.4 37.9 83.8 38.1 84.2 38.4 C84.6 38.6 85.0 38.8 85.4 39.1 C85.9 39.3 86.3 39.6 86.7 39.8 C87.1 40.1 87.5 40.4 87.8 40.6 C88.2 40.9 88.6 41.2 89.0 41.5 C89.4 41.8 89.8 42.1 90.1 42.4 C90.5 42.7 90.9 43.1 91.2 43.3 C91.6 43.6 92.2 44.0 92.3 43.8 C92.5 43.7 92.4 42.9 92.4 42.4 C92.3 41.9 92.3 41.4 92.3 41.0 C92.2 40.5 92.2 40.0 92.2 39.5 C92.1 39.0 92.0 38.6 92.0 38.1 C91.9 37.6 91.8 37.1 91.7 36.7 C91.7 36.2 91.6 35.7 91.4 35.3 C91.3 34.8 91.2 34.3 91.1 33.9 C91.0 33.4 90.9 32.9 90.7 32.5 C90.6 32.0 90.5 31.6 90.3 31.1 C90.2 30.7 90.0 30.2 89.8 29.8 C89.7 29.3 89.5 28.9 89.3 28.4 C89.1 28.0 88.9 27.6 88.7 27.1 C88.4 26.7 88.2 26.3 87.9 25.9 C87.7 25.5 87.3 25.1 86.9 24.9 C86.5 24.7 86.0 24.6 85.5 24.6 Z'
const MOUTH = 'M69.5 76.2 C69.3 76.2 69.1 76.3 68.9 76.4 C68.8 76.6 68.7 76.8 68.7 77.0 C68.6 77.2 68.5 77.4 68.4 77.5 C68.3 77.7 68.2 77.9 68.0 78.0 C67.9 78.1 67.7 78.2 67.5 78.3 C67.3 78.3 67.1 78.3 66.9 78.3 C66.7 78.3 66.5 78.2 66.3 78.2 C66.1 78.1 65.9 77.9 65.8 77.8 C65.6 77.7 65.5 77.5 65.3 77.4 C65.2 77.3 65.0 77.1 64.8 77.0 C64.6 77.0 64.4 77.0 64.2 77.1 C64.0 77.2 63.9 77.4 63.8 77.5 C63.7 77.7 63.6 77.9 63.5 78.1 C63.4 78.2 63.3 78.4 63.2 78.6 C63.1 78.8 62.9 78.9 62.8 79.0 C62.6 79.1 62.4 79.2 62.2 79.3 C62.0 79.3 61.8 79.3 61.6 79.3 C61.4 79.3 61.2 79.2 61.0 79.1 C60.8 79.0 60.7 78.8 60.6 78.7 C60.4 78.6 60.3 78.4 60.2 78.2 C60.0 78.1 59.8 78.0 59.6 78.0 C59.4 78.0 59.2 78.1 59.0 78.3 C58.9 78.4 58.8 78.6 58.8 78.8 C58.7 79.0 58.8 79.2 58.9 79.4 C58.9 79.6 59.1 79.7 59.2 79.9 C59.3 80.1 59.5 80.2 59.6 80.3 C59.8 80.5 59.9 80.6 60.1 80.7 C60.3 80.8 60.5 80.9 60.7 81.0 C60.8 81.0 61.0 81.1 61.2 81.1 C61.4 81.2 61.7 81.2 61.9 81.2 C62.1 81.2 62.3 81.2 62.5 81.1 C62.7 81.1 62.9 81.0 63.1 80.9 C63.3 80.9 63.4 80.8 63.6 80.6 C63.8 80.5 63.9 80.4 64.1 80.3 C64.3 80.1 64.4 80.0 64.5 79.8 C64.7 79.7 64.9 79.6 65.1 79.6 C65.3 79.6 65.4 79.8 65.6 79.9 C65.8 80.0 66.0 80.0 66.2 80.1 C66.4 80.1 66.6 80.2 66.8 80.2 C67.0 80.2 67.2 80.2 67.4 80.2 C67.6 80.2 67.8 80.1 68.0 80.1 C68.2 80.0 68.4 79.9 68.6 79.8 C68.8 79.7 69.0 79.6 69.1 79.5 C69.3 79.4 69.4 79.2 69.6 79.1 C69.7 78.9 69.8 78.8 69.9 78.6 C70.0 78.4 70.1 78.2 70.2 78.0 C70.3 77.9 70.3 77.7 70.4 77.5 C70.4 77.3 70.4 77.0 70.3 76.8 C70.3 76.7 70.2 76.4 70.0 76.3 C69.9 76.2 69.7 76.1 69.5 76.2 Z'
/** Without a disc the body ends in a rounded edge; on the disc it ends where the disc does. */
const CLIP_PLAIN = ['rect', { x: 3, y: -60, width: 114, height: 174, rx: 16 }]
const CLIP_DISC = ['path', { d: 'M-50 -50 H170 V75.4 H115.2 A55.2 55.2 0 0 1 4.8 75.4 H-50 Z' }]

const eye = (cx, cy, rx, ry, angle) => ['ellipse', { cx, cy, rx, ry, transform: `rotate(${angle} ${cx} ${cy})`, fill: EYE }]
const eyes = (dy = 0, scale = 1, height = 1) => [
  eye(48.99, 73.58 + dy, 3.64 * scale, 4.94 * scale * height, -8),
  eye(78.26, 68.31 + dy, 3.67 * scale, 5.01 * scale * height, -7.2),
]
const stroke = (d, width) => ['path', { d, fill: 'none', stroke: EYE, 'stroke-width': width, 'stroke-linecap': 'round' }]
const sparkle = (x, y, r, cls) => ['path', { class: cls, d: `M${x} ${y - r} Q${x} ${y} ${x + r} ${y} Q${x} ${y} ${x} ${y + r} Q${x} ${y} ${x - r} ${y} Q${x} ${y} ${x} ${y - r} Z`, fill: PAPER }]
const sign = (mark) => [['g', { class: 'cat-bounce' }, [['circle', { cx: 114, cy: 18, r: 13, fill: PAPER }], ...mark]]]

/** What each mood draws on the face (eyes, and the mouth when it is not the usual ω) and around the cat. */
const MOODS = {
  idle: { face: [['g', { class: 'cat-blink' }, eyes()]] },
  thinking: {
    face: [['g', { transform: 'translate(1.6 -2)' }, eyes()]],
    props: [['g', { class: 'cat-bounce' }, [
      ['circle', { cx: 104, cy: 40, r: 3.5, fill: PAPER }],
      ['circle', { cx: 112, cy: 30, r: 5, fill: PAPER }],
      ['ellipse', { cx: 128, cy: 13, rx: 21, ry: 14, fill: PAPER }],
      ['circle', { class: 'cat-dot', cx: 119, cy: 13, r: 2.8, fill: INK }],
      ['circle', { class: 'cat-dot cat-d2', cx: 128, cy: 13, r: 2.8, fill: INK }],
      ['circle', { class: 'cat-dot cat-d3', cx: 137, cy: 13, r: 2.8, fill: INK }],
    ]]],
  },
  typing: {
    face: [['g', { class: 'cat-scan' }, eyes(1.7, 1, 0.85)]],
    mouthClass: 'cat-scan',
    props: [
      ['rect', { x: 16, y: 100, width: 88, height: 20, rx: 7, fill: PAPER }],
      ['g', { fill: KEY }, [
        ...[23, 33, 43, 53, 63, 73, 83].map((x) => ['rect', { x, y: 104, width: 7, height: 4, rx: 1.5 }]),
        ['rect', { x: 93, y: 104, width: 5, height: 4, rx: 1.5 }],
        ['rect', { x: 23, y: 111, width: 10, height: 4, rx: 1.5 }],
        ['rect', { x: 36, y: 111, width: 40, height: 4, rx: 1.5 }],
        ['rect', { x: 79, y: 111, width: 19, height: 4, rx: 1.5 }],
      ]],
      ['ellipse', { class: 'cat-paw-l', cx: 44, cy: 101, rx: 9, ry: 6, fill: INK }],
      ['ellipse', { class: 'cat-paw-r', cx: 80, cy: 101, rx: 9, ry: 6, fill: INK }],
    ],
  },
  confirm: {
    tilt: true,
    face: eyes(-0.3, 1.15),
    props: sign([['rect', { x: 112, y: 9, width: 4.2, height: 12, rx: 2.1, fill: INK }], ['circle', { cx: 114.1, cy: 25.5, r: 2.4, fill: INK }]]),
  },
  ask: {
    tilt: true,
    face: eyes(-0.3, 1.15),
    props: sign([
      ['path', { d: 'M109.5 14.5 Q109.5 9 114 9 Q118.5 9 118.5 13.5 Q118.5 16.5 115 18 Q114 18.6 114 20.5', fill: 'none', stroke: INK, 'stroke-width': 3.4, 'stroke-linecap': 'round' }],
      ['circle', { cx: 114, cy: 25.5, r: 2.3, fill: INK }],
    ]),
  },
  done: {
    face: [['g', { class: 'cat-pop' }, [stroke('M45 75.6 Q48.8 69.4 52.9 74.6', 2.8), stroke('M74.3 70.3 Q78.1 64.1 82.2 69.3', 2.8)]]],
    props: [
      sparkle(5, 59, 7, 'cat-twinkle'),
      sparkle(112, 14, 8, 'cat-twinkle cat-d2'),
      sparkle(117, 55, 5, 'cat-twinkle cat-d3'),
    ],
  },
  error: {
    face: [
      stroke('M45.5 70.1 L52.5 77.1 M52.5 70.1 L45.5 77.1 M74.8 64.8 L81.8 71.8 M81.8 64.8 L74.8 71.8', 2.8),
      stroke('M58.6 79.6 Q61.6 77.1 64.6 79.1 Q67.6 81.1 70.6 78.1', 2),
    ],
    noMouth: true,
    props: [['path', { class: 'cat-drip', d: 'M106 44 Q101 52 106 55 Q111 52 106 44 Z', fill: EYE }]],
  },
}

let clipSeq = 0

function draw([tag, attrs, children = []]) {
  const el = document.createElementNS(NS, tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value))
  for (const child of children) el.append(draw(child))
  return el
}

const layer = (children) => draw(['svg', { class: 'cat-layer', viewBox: `0 0 ${BOX} ${BOX}`, 'aria-hidden': 'true' }, children])

function box(className, styles) {
  const el = document.createElement('div')
  el.className = className
  Object.assign(el.style, styles)
  return el
}

/**
 * @param {string} mood one of CAT_MOODS (anything else draws `idle`)
 * @param {{ size?: number, frame?: boolean, still?: boolean }} [options] frame: on its blue disc; still: no motion
 *   (cats that only mark a past answer)
 * @returns {HTMLElement}
 */
export function drawCat(mood, { size = 120, frame = false, still = false } = {}) {
  const look = MOODS[mood] ?? MOODS.idle
  const clipId = `cat-clip-${++clipSeq}`
  const cat = box(still ? 'cat cat-still' : 'cat', { width: `${size}px`, height: `${size}px` })
  cat.dataset.mood = CAT_MOODS.includes(mood) ? mood : 'idle'
  if (frame) cat.append(box('cat-disc', {}))
  // The drawing's box, scaled so that on a disc the disc's circle in it lands on the disc.
  const scale = frame ? size / DISC : size / BOX
  const inner = box('cat-inner', {
    width: `${BOX * scale}px`, height: `${BOX * scale}px`, left: frame ? `${-DISC_LEFT * scale}px` : '0', top: frame ? `${-DISC_TOP * scale}px` : '0',
  })
  const head = box(look.tilt ? 'cat-head cat-tilt' : 'cat-head', {})
  head.append(layer([
    ['defs', {}, [['clipPath', { id: clipId }, [frame ? CLIP_DISC : CLIP_PLAIN]]]],
    ['g', { 'clip-path': `url(#${clipId})` }, [['path', { d: BODY, fill: INK }], ['path', { d: EAR_LEFT, fill: EAR }], ['path', { d: EAR_RIGHT, fill: EAR }]]],
    ...(look.noMouth ? [] : [['g', look.mouthClass ? { class: look.mouthClass } : {}, [['path', { d: MOUTH, fill: EYE }]]]]),
    ...look.face,
  ]))
  inner.append(head)
  if (look.props) inner.append(layer(look.props))
  cat.append(inner)
  return cat
}

/**
 * The cat for `slot`, reused while its look stays the same.
 * @param {Map<string, { key: string, el: HTMLElement }>} cache
 * @param {string} slot
 * @param {string} mood
 * @param {{ size?: number, frame?: boolean, still?: boolean }} [options]
 */
export function catFor(cache, slot, mood, options = {}) {
  const key = `${mood}|${options.size}|${Boolean(options.frame)}|${Boolean(options.still)}`
  const kept = cache.get(slot)
  if (kept?.key === key) return kept.el
  const el = drawCat(mood, options)
  cache.set(slot, { key, el })
  return el
}
