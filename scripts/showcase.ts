// npm run showcase: the README's pictures and demo, made by the app itself (test/smoke/smoke-showcase.ts) on the
// real dsh with the fake model's showcase answers, then fitted for the docs with ffmpeg:
//   docs/images/*.png      the scenes, 1600 px wide
//   docs/images/demo.gif   the follow-up's whole way, for the README
//   promo/public/          the same demo, sharp, and the scenes, for the promo video (promo/, Remotion);
//                          promo/src/demo-meta.json its length
// Needs ffmpeg on PATH. Run after `npm run build` (the npm script does both).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { runExternalScenario } from '../test/smoke/run-external.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'smoke', 'showcase')
const IMAGES = path.join(ROOT, 'docs', 'images')
const PROMO = path.join(ROOT, 'promo', 'public')
const SHOTS = ['home', 'chat', 'followup-card', 'preparing', 'background', 'suggestion', 'approval', 'sources', 'prepare-settings', 'files', 'desk-island']
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
  fs.mkdirSync(PROMO, { recursive: true })
  ffmpeg(['-framerate', String(FPS), '-i', frames, '-vf', 'scale=1920:-2:flags=lanczos,fps=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', path.join(PROMO, 'demo.mp4')])
  // The promo times its demo scene by the recording's length (promo/src/timeline.ts).
  const recorded = fs.readdirSync(path.join(OUT, 'frames')).filter((name) => name.endsWith('.png')).length
  fs.writeFileSync(path.join(ROOT, 'promo', 'src', 'demo-meta.json'), `${JSON.stringify({ frames: recorded, fps: FPS })}\n`)
  fs.copyFileSync(path.join(ROOT, 'build', 'icons', 'viva.png'), path.join(PROMO, 'icon.png'))
  for (const name of SHOTS) {
    const file = path.join(IMAGES, `${name}.png`)
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(PROMO, `${name}.png`))
  }
}

await runApp()
shots()
demo()
const size = (file: string) => `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`
console.log(`[showcase] docs/images: ${SHOTS.length} scenes, demo.gif ${size(path.join(IMAGES, 'demo.gif'))}; promo/public/demo.mp4 ${size(path.join(PROMO, 'demo.mp4'))}`)
