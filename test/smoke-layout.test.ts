import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import config from './smoke/playwright.config.ts'
import { integrationLanes, integrationSpecs } from './smoke/suites.ts'

test('integration lanes cover every integration spec exactly once and reject invalid lanes', () => {
  const full = integrationSpecs()
  const lanes = Object.keys(integrationLanes).flatMap(lane => integrationSpecs(lane))
  assert.deepEqual([...lanes].sort(), [...full].sort())
  assert.equal(new Set(lanes).size, lanes.length)
  assert.deepEqual(integrationSpecs('memory'), ['memory.spec.ts', 'schedules.spec.ts', 'lifecycle.spec.ts'])
  assert.throws(() => integrationSpecs(''), /Unknown smoke lane/)
  assert.throws(() => integrationSpecs('typo'), /Unknown smoke lane/)
  const projects = config.projects!
  assert.deepEqual(projects.find(project => project.name === 'integration')!.testMatch, integrationSpecs(process.env.VIVA_SMOKE_LANE))
  const configured = projects.flatMap(project => project.name === 'integration' ? full : project.testMatch as string[] | string).sort()
  const discovered = fs.readdirSync(path.join(import.meta.dirname, 'smoke')).filter(file => file.endsWith('.spec.ts')).sort()
  assert.deepEqual(configured, discovered, 'each source, package and performance spec has one explicit project')
  assert.equal(config.workers, 1)
  assert.equal(config.retries, 0)
})

test('the source smoke tests cover independent memory, schedules and real task restart', () => {
  const source = (file: string) => fs.readFileSync(path.join(import.meta.dirname, 'smoke', file), 'utf8')
  const specs = ['critical.spec.ts', ...integrationSpecs()]
  const titles = specs.flatMap(file => [...source(file).matchAll(/\btest\('([^']+)'/g)].map(match => match[1]))
  assert.equal(titles.length, 13)
  for (const title of [
    'MCP import menu stays inside its sidebar and cancelling an edit restores the saved server',
    'setup and source management @setup',
    'walkthrough and persisted relaunch @walkthrough @relaunch',
    'memory, capabilities and background tasks @memory',
    'persisted tasks resume after a real restart @resume',
    'scheduled work runs when its real timer is due @schedules',
    'long timeline and review @timeline',
    'system and switched languages @language',
  ]) assert.ok(titles.includes(title), title)
  for (const [file, first, second] of [
    ['walkthrough.spec.ts', 'walkthrough', 'relaunch'],
    ['resume.spec.ts', 'resume-prepare', 'resume'],
  ]) {
    assert.ok(source(file).replace(/\r\n/g, '\n').includes(`await run.run('${first}')\n  await run.run('${second}')`))
    assert.equal((source(file).match(/await scenario\(/g) ?? []).length, 1)
  }
})
