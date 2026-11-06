// npm run showcase: the README's pictures and demo, made by the app itself (test/smoke/smoke-showcase.ts) on the
// real dsh with the fake model's showcase answers, then fitted for the docs with ffmpeg:
//   docs/images/*.png      the scenes, 1600 px wide
//   docs/images/demo.gif   a schedule's whole way, for the README
// Needs ffmpeg on PATH. Run after `npm run build` (the npm script does both).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { runExternalScenario } from '../test/smoke/run-external.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'smoke', 'showcase')
const IMAGES = path.join(ROOT, 'docs', 'images')
const SHOTS = ['home', 'chat', 'schedule-card', 'feed-item', 'approval', 'files', 'desk-island']
const SHOT_WIDTH = 1600
const GIF_WIDTH = 1100
const FPS = 10

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
}

async function runApp() {
  const problems = await runExternalScenario({ phases: ['showcase'], outputDirectory: OUT })
  if (problems.length) throw new Error(problems.join('\n'))
}

function shots() {
  fs.mkdirSync(IMAGES, { recursive: true })
  for (const name of SHOTS) {
    const from = path.join(OUT, `${name}.png`)
    if (!fs.existsSync(from)) throw new Error(`the showcase did not capture ${name}`)
    ffmpeg(['-i', from, '-vf', `scale=${SHOT_WIDTH}:-1:flags=lanczos`, path.join(IMAGES, `${name}.png`)])
  }
}

function demo() {
  const frames = path.join(OUT, 'frames', 'frame-%05d.png')
  const palette = `fps=${FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`
  ffmpeg(['-framerate', String(FPS), '-i', frames, '-vf', palette, path.join(IMAGES, 'demo.gif')])
}

await runApp()
shots()
demo()
const size = (file: string) => `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`
console.log(`[showcase] docs/images: ${SHOTS.length} scenes, demo.gif ${size(path.join(IMAGES, 'demo.gif'))}`)
