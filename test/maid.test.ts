import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { MAID_MOODS, MOVING_MOODS, badgeOf, framingOf, maidMood, pictureOf, ringOf } from '../src/renderer/view/maid.ts'

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/assets/maid')

test('every mood has its still picture, and every moving mood its animation', () => {
  for (const framing of ['whole', 'face'] as const) {
    for (const mood of MAID_MOODS) assert.ok(fs.existsSync(path.join(ASSETS, pictureOf(mood, false, framing))), `${framing}/${mood} still`)
    for (const mood of MOVING_MOODS) assert.ok(fs.existsSync(path.join(ASSETS, pictureOf(mood, true, framing))), `${framing}/${mood} moving`)
  }
})

test('all moods have motion, with dedicated centred portraits for conversation avatars', () => {
  assert.equal(pictureOf('typing', true), 'typing-motion.webp')
  assert.equal(pictureOf('typing', false), 'typing.webp')
  assert.equal(pictureOf('done', true), 'done-motion.webp')
  assert.equal(pictureOf('typing', true, 'face'), 'avatars/typing-motion.webp')
  assert.equal(pictureOf('idle', false, 'face'), 'avatars/idle.webp')
  assert.deepEqual([...MOVING_MOODS].sort(), [...MAID_MOODS].sort())
})

test('listening to files held over the island uses the asking pictures, but in blue and without a badge: nothing waits on the user', () => {
  assert.equal(pictureOf('listening', false), 'ask.webp')
  assert.equal(pictureOf('listening', true), 'ask-motion.webp')
  assert.equal(pictureOf('listening', true, 'face'), 'avatars/ask-motion.webp')
  assert.equal(ringOf('listening'), 'blue')
  assert.equal(badgeOf('listening'), null)
})

test('a mood the maid has no picture for rests, and an island still connecting shows her offline', () => {
  assert.equal(maidMood('working'), 'idle')
  assert.equal(maidMood('confirm'), 'confirm')
  assert.equal(maidMood('idle', 'pending'), 'offline')
  assert.equal(maidMood('error', 'pending'), 'error', 'an error is still said as one')
})

test('the badges say what a small picture cannot', () => {
  assert.equal(badgeOf('confirm'), '!')
  assert.equal(badgeOf('ask'), '?')
  assert.equal(badgeOf('done'), '✓')
  assert.equal(badgeOf('typing'), null)
})

test('the ring follows the mood: orange waits on the user, red is an error, blue is at work or done', () => {
  assert.equal(ringOf('confirm'), 'orange')
  assert.equal(ringOf('ask'), 'orange')
  assert.equal(ringOf('error'), 'red')
  assert.equal(ringOf('typing'), 'blue')
  assert.equal(ringOf('done'), 'blue')
  assert.equal(ringOf('offline'), 'gray')
  assert.equal(ringOf('idle'), 'quiet')
})

test('half-body and centred portraits both use the complete canvas without a second crop', () => {
  assert.deepEqual(framingOf(72, 'whole'), { size: 72, offset: 0 })
  assert.deepEqual(framingOf(48, 'face'), { size: 48, offset: 0 })
})

type Manifest = {
  source: { revision: string, overrides?: { path: string, revision: string, manifestSha256: string } },
  encoding: { lossless: boolean, quality: number },
  states: Array<{ id: string, static: string, animation: string, frames: number, loopCount: number, staticSize: number[], animationSize: number[], durationsMs: number[] }>,
  sourceSha256: Record<string, string>,
  sha256: Record<string, string>,
}

/** Read actual WebP animation chunks; a renamed still or single-frame export cannot pass this check. */
function chunksOf(bytes: Buffer) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
  assert.equal(bytes.toString('ascii', 8, 12), 'WEBP')
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8)
  const chunks: Array<{ kind: string, data: Buffer }> = []
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4)
    assert.ok(offset + 8 + size <= bytes.length, 'complete WebP chunk')
    chunks.push({ kind: bytes.toString('ascii', offset, offset + 4), data: bytes.subarray(offset + 8, offset + 8 + size) })
    offset += 8 + size + (size % 2)
  }
  return chunks
}

function dimensionsOf(chunks: ReturnType<typeof chunksOf>): number[] {
  const extended = chunks.find(chunk => chunk.kind === 'VP8X')
  if (extended) return [extended.data.readUIntLE(4, 3) + 1, extended.data.readUIntLE(7, 3) + 1]
  const lossless = chunks.find(chunk => chunk.kind === 'VP8L')
  if (lossless) {
    const bits = lossless.data.readUInt32LE(1)
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
  }
  const lossy = chunks.find(chunk => chunk.kind === 'VP8 ')
  assert.ok(lossy, 'a still has an actual WebP image payload')
  return [lossy.data.readUInt16LE(6) & 0x3fff, lossy.data.readUInt16LE(8) & 0x3fff]
}

test('runtime assets match their hashes, real dimensions, frame timings and framing-specific playback', () => {
  for (const directory of [ASSETS, path.join(ASSETS, 'avatars')]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as Manifest
    assert.match(manifest.source.revision, /^[a-f0-9]{40}$/)
    assert.equal(manifest.encoding.lossless, false)
    assert.equal(manifest.encoding.quality, 90)
    assert.equal(manifest.states.length, 10)
    for (const state of manifest.states) {
      for (const file of [state.static, state.animation]) {
        assert.equal(path.basename(file), file, 'manifest paths resolve directly within the asset set')
        assert.match(manifest.sourceSha256[file], /^[a-f0-9]{64}$/)
        const bytes = fs.readFileSync(path.join(directory, file))
        assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256[file], file)
        const chunks = chunksOf(bytes)
        if (file === state.static) {
          assert.equal(chunks.some(chunk => chunk.kind === 'ANIM'), false, `${state.id} reduced-motion still`)
          assert.deepEqual(dimensionsOf(chunks), state.staticSize)
          continue
        }
        const anim = chunks.find(chunk => chunk.kind === 'ANIM')!
        const header = chunks.find(chunk => chunk.kind === 'VP8X')!
        assert.ok(anim && header, `${state.id} animation metadata`)
        assert.equal(chunks.filter(chunk => chunk.kind === 'ANMF').length, state.frames)
        assert.deepEqual(dimensionsOf(chunks), state.animationSize)
        assert.deepEqual(chunks.filter(chunk => chunk.kind === 'ANMF').map(chunk => chunk.data.readUIntLE(12, 3)), state.durationsMs)
        const expectedLoops = state.id === 'greeting' && directory !== ASSETS ? 1 : 0
        assert.equal(anim.data.readUInt16LE(4), expectedLoops, `${path.basename(directory)}/${state.id}`)
        assert.equal(anim.data.readUInt16LE(4), state.loopCount)
      }
    }
  }
})

test('the half-body greeting keeps waving and completion lifts the card with a held thumbs-up', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8')) as Manifest
  const greeting = manifest.states.find(state => state.id === 'greeting')!
  assert.equal(greeting.loopCount, 0)
  assert.equal(greeting.frames, 15)
  assert.equal(greeting.durationsMs.reduce((sum, ms) => sum + ms, 0), 1980)
  assert.equal(greeting.durationsMs.at(-1), 720, 'a short rest between wrist waves')
  const done = manifest.states.find(state => state.id === 'done')!
  assert.deepEqual(done.staticSize, [400, 400])
  assert.deepEqual(done.animationSize, [256, 256])
  assert.equal(done.frames, 11)
  assert.equal(done.loopCount, 0)
  assert.equal(done.durationsMs.reduce((sum, ms) => sum + ms, 0), 2590)
  assert.equal(done.durationsMs[5], 850, 'hold the completed-task gesture at its high point')
})

test('approved runtime overrides are reproducible without another lossy encoding pass', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8')) as Manifest
  const overrides = manifest.source.overrides!
  assert.equal(overrides.path, 'build/maid-overrides')
  const directory = path.resolve(ASSETS, '../../..', overrides.path)
  const bytes = fs.readFileSync(path.join(directory, 'manifest.json'))
  assert.equal(createHash('sha256').update(bytes.toString('utf8').replaceAll('\r\n', '\n')).digest('hex'), overrides.manifestSha256)
  const source = JSON.parse(bytes.toString('utf8')) as {
    revision: string,
    files: Record<string, { sha256: string, sourceSha256: string }>,
  }
  assert.equal(source.revision, overrides.revision)
  assert.deepEqual(Object.keys(source.files).sort(), ['done-motion.webp', 'done.webp', 'greeting-motion.webp'])
  for (const [file, expected] of Object.entries(source.files)) {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex'), expected.sha256)
    assert.equal(manifest.sha256[file], expected.sha256, file)
    assert.equal(manifest.sourceSha256[file], expected.sourceSha256, file)
  }
})

test('the runtime character directory contains only referenced assets within its byte budgets', () => {
  let total = 0
  for (const directory of [ASSETS, path.join(ASSETS, 'avatars')]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as Manifest
    const referenced = manifest.states.flatMap(state => [state.static, state.animation])
    const entries = fs.readdirSync(directory, { withFileTypes: true })
    assert.ok(entries.every(entry => entry.isFile() || (directory === ASSETS && entry.name === 'avatars' && entry.isDirectory())),
      'only the referenced portrait directory is allowed alongside runtime files')
    const actual = entries.filter(entry => entry.isFile()).map(entry => entry.name)
    assert.deepEqual(actual.sort(), ['manifest.json', ...referenced].sort(), 'source sheets and unused exports stay outside runtime assets')
    for (const file of actual) {
      const bytes = fs.statSync(path.join(directory, file)).size
      total += bytes
      const limit = file.endsWith('-motion.webp') ? (directory.endsWith('avatars') ? 128 : 512) * 1024 : 32 * 1024
      assert.ok(bytes <= limit, `${file} is ${bytes} bytes, exceeding ${limit}`)
    }
  }
  assert.ok(total <= 4 * 1024 * 1024, `character runtime assets exceed 4 MiB at ${total} bytes`)
})
