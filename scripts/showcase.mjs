// npm run showcase: the README's pictures and demo, made by the app itself (src/main/smoke-showcase.ts) on the
// real dsh with the fake model's showcase answers, then fitted for the docs with ffmpeg:
//   docs/images/*.png      the scenes, 1600 px wide (the desktop island on a backdrop)
//   docs/images/demo.gif   the follow-up's whole way, for the README
//   promo/public/          the same demo, sharp, and the scenes, for the promo video (promo/, Remotion);
//                          promo/src/demo-meta.json its length
// Needs ffmpeg on PATH. Run after `npm run build` (the npm script does both).
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'smoke', 'showcase')
const IMAGES = path.join(ROOT, 'docs', 'images')
const PROMO = path.join(ROOT, 'promo', 'public')
const SHOTS = ['home', 'chat', 'followup-card', 'preparing', 'background', 'suggestion', 'approval', 'sources', 'prepare-settings', 'files']
const SHOT_WIDTH = 1600
const GIF_WIDTH = 1100
const FPS = 10

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
}

function runApp() {
  const electron = createRequire(import.meta.url)('electron')
  const ran = spawnSync(electron, ['.'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, SMOKE_PHASE: 'showcase', SMOKE_OUT: OUT, DEEPSEEK_API_KEY: 'smoke-fake-key', SMOKE_LLM_PORT: '47816' },
  })
  if (ran.status !== 0) throw new Error(`the showcase run failed (${ran.status}); see smoke/showcase for what it captured`)
}

function shots() {
  fs.mkdirSync(IMAGES, { recursive: true })
  for (const name of SHOTS) {
    const from = path.join(OUT, `${name}.png`)
    if (!fs.existsSync(from)) throw new Error(`the showcase did not capture ${name}`)
    ffmpeg(['-i', from, '-vf', `scale=${SHOT_WIDTH}:-1:flags=lanczos`, path.join(IMAGES, `${name}.png`)])
  }
  // The island alone is small: on a dark backdrop, as it sits on a desktop.
  const island = path.join(OUT, 'desk-island.png')
  if (fs.existsSync(island)) {
    ffmpeg([
      '-f', 'lavfi', '-i', 'gradients=s=1600x360:c0=0x0b1a33:c1=0x2a1846:x0=0:y0=0:x1=1600:y1=360:d=1,format=rgba',
      '-i', island,
      '-filter_complex', '[1]scale=900:-1:flags=lanczos[i];[0][i]overlay=(W-w)/2:(H-h)/2',
      '-frames:v', '1', path.join(IMAGES, 'desk-island.png'),
    ])
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
  for (const name of [...SHOTS, 'desk-island']) {
    const file = path.join(IMAGES, `${name}.png`)
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(PROMO, `${name}.png`))
  }
}

runApp()
shots()
demo()
const size = (file) => `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`
console.log(`[showcase] docs/images: ${SHOTS.length} scenes, demo.gif ${size(path.join(IMAGES, 'demo.gif'))}; promo/public/demo.mp4 ${size(path.join(PROMO, 'demo.mp4'))}`)
