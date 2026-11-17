import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkMemorySemanticFreeze } from '../scripts/memory-semantic-freeze.ts'
import { memorySemanticCases } from '../scripts/memory-semantic-cases.ts'
import { mkdirSync, existsSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { memorySemanticTreeHash, validateMemorySemanticRecoveryOutput } from '../scripts/memory-semantic-evaluation.ts'
import { scratch } from './fixtures/scratch.js'

test('real-model memory evaluation retains its pre-run corpus and rejects changed source material', () => {
  assert.match(checkMemorySemanticFreeze(), /^[a-f0-9]{64}$/u)
  const changed = structuredClone(memorySemanticCases)
  changed[0]!.phases[0]!.turns[0]!.user += ' changed'
  assert.throws(() => checkMemorySemanticFreeze(changed), /changed after its first real-model run/u)
})

test('fixed semantic cases cover distinct evidence hazards with genuine prior short-answer questions', () => {
  assert.deepEqual(new Set(memorySemanticCases.map(item => item.category)), new Set([
    'short-answer', 'quotation', 'negation', 'condition', 'historical-correction', 'project-procedure', 'preference',
  ]))
  assert.equal(memorySemanticCases.find(item => item.category === 'historical-correction')?.phases.length, 2)
  for (const fixture of memorySemanticCases) for (const phase of fixture.phases) {
    assert.ok(phase.turns.length >= 5)
    assert.ok(phase.expectations.some(item => item.disposition === 'required'), 'all-skip must not pass a positive case')
    for (const [index, turn] of phase.turns.entries()) if (turn.answerTo) {
      const previous = phase.turns.slice(0, index).find(item => item.id === turn.answerTo!.turnId)
      assert.ok(previous?.assistant.includes(turn.answerTo.question), 'a later or invented question cannot ground a short reply')
    }
  }
})

test('recovery rejects overlapping and aliased output before changing the preserved source tree', t => {
  const { dir } = scratch(t, 'memory-semantic-output-')
  const source = path.join(dir, 'original'), alias = path.join(dir, 'alias')
  mkdirSync(source)
  writeFileSync(path.join(source, 'proof.json'), '{"preserved":true}\n')
  symlinkSync(source, alias, 'junction')
  const before = memorySemanticTreeHash(source)
  for (const output of [source, dir, path.join(source, 'state', 'new-retry'), path.join(alias, 'new-retry')]) {
    assert.throws(() => validateMemorySemanticRecoveryOutput(output, source), /cannot overlap/u)
    assert.equal(memorySemanticTreeHash(source), before)
  }
  const fresh = path.join(dir, 'separate', 'recovery')
  validateMemorySemanticRecoveryOutput(fresh, source)
  assert.equal(existsSync(path.dirname(fresh)), false)
  assert.equal(memorySemanticTreeHash(source), before)
})
