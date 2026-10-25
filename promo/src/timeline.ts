import demoMeta from './demo-meta.json'
import { FPS, TRANSITION_FRAMES } from './theme'

/** The recorded demo plays this much faster than it was captured. */
export const DEMO_RATE = 1.35
/** How long the demo scene runs: the recording (written by scripts/showcase.mjs) at DEMO_RATE, plus a beat. */
export const DEMO_FRAMES = Math.ceil((demoMeta.frames / demoMeta.fps) * FPS / DEMO_RATE) + 15

/** Each scene's length, in order; the transitions overlap neighbors, so the total is shorter than the sum. */
export const SCENE_FRAMES = {
  intro: 100,
  hook: 96,
  demo: DEMO_FRAMES,
  bento: 140,
  approval: 110,
  files: 110,
  today: 110,
  developers: 150,
  outro: 120,
} as const

const scenes = Object.values(SCENE_FRAMES)
export const TOTAL_FRAMES = scenes.reduce((sum, n) => sum + n, 0) - (scenes.length - 1) * TRANSITION_FRAMES
