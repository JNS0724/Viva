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

type Manifest = { states: Array<{ id: string, static: string, animation: string, frames: number, loopCount: number, animationSize: number[] }>, sha256: Record<string, string> }

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

test('both asset sets preserve source bytes, real frame counts, dimensions and greeting-only single playback', () => {
  for (const directory of [ASSETS, path.join(ASSETS, 'avatars')]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as Manifest
    assert.equal(manifest.states.length, 10)
    for (const state of manifest.states) {
      for (const file of [state.static, state.animation]) {
        const bytes = fs.readFileSync(path.join(directory, path.basename(file)))
        assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256[file], file)
        const chunks = chunksOf(bytes)
        if (file === state.static) {
          assert.equal(chunks.some(chunk => chunk.kind === 'ANIM'), false, `${state.id} reduced-motion still`)
          continue
        }
        const anim = chunks.find(chunk => chunk.kind === 'ANIM')!
        const header = chunks.find(chunk => chunk.kind === 'VP8X')!
        assert.ok(anim && header, `${state.id} animation metadata`)
        assert.equal(chunks.filter(chunk => chunk.kind === 'ANMF').length, state.frames)
        assert.deepEqual([header.data.readUIntLE(4, 3) + 1, header.data.readUIntLE(7, 3) + 1], state.animationSize)
        assert.equal(anim.data.readUInt16LE(4), state.id === 'greeting' ? 1 : 0, state.id)
      }
    }
  }
})
