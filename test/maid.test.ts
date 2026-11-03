import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FACE_ZOOM, MAID_MOODS, MOVING_MOODS, badgeOf, framingOf, maidMood, pictureOf, ringOf } from '../src/renderer/view/maid.ts'

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/assets/maid')

test('every mood has its still picture, and every moving mood its animation', () => {
  for (const mood of MAID_MOODS) assert.ok(fs.existsSync(path.join(ASSETS, pictureOf(mood, false))), `${mood} still`)
  for (const mood of MOVING_MOODS) assert.ok(fs.existsSync(path.join(ASSETS, pictureOf(mood, true))), `${mood} moving`)
})

test('only the moods that have an animation move; the others stay still when asked to move', () => {
  assert.equal(pictureOf('typing', true), 'typing-motion.webp')
  assert.equal(pictureOf('typing', false), 'typing.webp')
  assert.equal(pictureOf('done', true), 'done.webp')
  assert.deepEqual([...MOVING_MOODS].sort(), ['ask', 'confirm', 'greeting', 'thinking', 'typing'])
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

test('whole shows the half-body as drawn; face zooms in on her face, centred', () => {
  assert.deepEqual(framingOf(72, 'whole'), { size: 72, offset: 0 })
  assert.equal(FACE_ZOOM, 1.6)
  assert.deepEqual(framingOf(48, 'face'), { size: 76.8, offset: -14.4 })
})
