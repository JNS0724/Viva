import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerSkillImportIpc } from '../src/backend/skill-import-ipc.ts'
import { skillRoots } from '../src/backend/skills.ts'

/** Bringing skills in over IPC (skill-import-ipc.ts): folders by id, a scan by id, never a path from the window. */

function setup(t: TestContext, { chosen = null as string | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-ipc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const write = (folder: string, frontmatter: string) => {
    fs.mkdirSync(path.join(dir, folder), { recursive: true })
    fs.writeFileSync(path.join(dir, folder, 'SKILL.md'), `---\n${frontmatter}\n---\n正文\n`)
  }
  const roots = skillRoots({ dshHome: path.join(dir, 'dsh'), cwd: path.join(dir, 'ws') })
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  let ids = 0
  registerSkillImportIpc({ handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) } as never, {
    roots: () => roots,
    sources: () => [{ id: 'claude-code', label: 'Claude Code', dir: path.join(dir, 'claude'), count: 2 }],
    chooseDir: async () => chosen,
    newId: () => `scan-${++ids}`,
  })
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) as Promise<Record<string, any>>
  return { dir, roots, write, call }
}

test('a folder found is scanned by its id; what the window gets has no path', async (t) => {
  const { dir, write, call } = setup(t)
  write('claude/weekly', 'name: weekly\ndescription: 周报')
  write('claude/notes', 'name: Meeting Notes\ndescription: 会议')
  const sources = await call('ext:skill-sources')
  assert.deepEqual(sources.map((source: Record<string, unknown>) => [source.id, source.count, 'dir' in source]), [['claude-code', 2, false]])
  const scan = await call('ext:scan-skills', 'claude-code')
  assert.equal(scan.scanId, 'scan-1')
  assert.deepEqual(scan.candidates.map((candidate: { entry: string, name: string, status: string }) => [candidate.entry, candidate.name, candidate.status]).toSorted(),
    [['notes', 'meeting-notes', 'fixable'], ['weekly', 'weekly', 'ready']])
  assert.equal(JSON.stringify(scan.candidates).includes(dir), false, 'no path reaches the window')
  await assert.rejects(call('ext:scan-skills', 'nowhere'), 'an id not offered is refused')
})

test('importing the ticked ones of the last scan; the skills listed come back with it', async (t) => {
  const { roots, write, call } = setup(t)
  write('claude/weekly', 'name: weekly\ndescription: 周报')
  write('claude/notes', 'name: Meeting Notes\ndescription: 会议')
  const scan = await call('ext:scan-skills', 'claude-code')
  const done = await call('ext:import-skills', scan.scanId, ['notes'])
  assert.deepEqual([done.imported, done.failed], [['meeting-notes'], []])
  assert.match(done.notice, /meeting-notes/)
  assert.deepEqual(done.skills.map((skill: { name: string }) => skill.name), ['meeting-notes'])
  assert.ok(fs.existsSync(path.join(roots[0].dir, 'meeting-notes', 'SKILL.md')))
  await assert.rejects(call('ext:import-skills', 'scan-0', ['weekly']), 'a scan not the last one is refused')
})

test('what Viva already has is taken: scanned again, the same one is offered renamed, not ticked', async (t) => {
  const { write, call } = setup(t)
  write('claude/weekly', 'name: weekly\ndescription: 周报')
  const first = await call('ext:scan-skills', 'claude-code')
  await call('ext:import-skills', first.scanId, ['weekly'])
  const again = await call('ext:scan-skills', 'claude-code')
  assert.deepEqual(again.candidates.map((candidate: { name: string, why: string, picked: boolean }) => [candidate.name, candidate.why, candidate.picked]), [['weekly-2', 'taken', false]])
})

test('a folder picked in the dialog, or the dialog cancelled', async (t) => {
  const cancelled = setup(t)
  cancelled.write('mine/one', 'name: one\ndescription: x')
  const picked = setup(t, { chosen: path.join(cancelled.dir, 'mine') })
  const scan = await picked.call('ext:scan-skills', 'choose')
  assert.deepEqual(scan.candidates.map((candidate: { entry: string }) => candidate.entry), ['one'])
  assert.deepEqual(await cancelled.call('ext:scan-skills', 'choose'), { cancelled: true })
})

test('what a skill ticked would go in as changed since it was shown: nothing copied, the new scan back to look at', async (t) => {
  const { roots, write, call } = setup(t)
  write('claude/weekly', 'name: weekly\ndescription: 周报')
  const shown = await call('ext:scan-skills', 'claude-code')
  assert.equal(shown.candidates[0].name, 'weekly')
  // Meanwhile Viva got one by that name (another import, the conversation).
  fs.mkdirSync(path.join(roots[0].dir, 'weekly'), { recursive: true })
  fs.writeFileSync(path.join(roots[0].dir, 'weekly', 'SKILL.md'), '---\nname: weekly\ndescription: 早就有的\n---\n')
  const answer = await call('ext:import-skills', shown.scanId, ['weekly'])
  assert.equal(answer.changed, true)
  assert.deepEqual(answer.scan.candidates.map((candidate: { name: string, why: string }) => [candidate.name, candidate.why]), [['weekly-2', 'taken']])
  assert.equal(fs.existsSync(path.join(roots[0].dir, 'weekly-2')), false, 'not copied under a name the user did not see')
  const confirmed = await call('ext:import-skills', answer.scan.scanId, ['weekly'])
  assert.deepEqual(confirmed.imported, ['weekly-2'], 'ticked again on the new scan, it goes in as shown')
})
