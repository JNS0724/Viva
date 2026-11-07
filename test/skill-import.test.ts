import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importCandidates, kebabName, scanSkills, skillSources } from '../src/backend/skill-import.ts'
import { checkSkill } from '../src/backend/skill-spec.ts'

/** Skills brought in from folders the user already has (skill-import.ts): found, checked, fixed where it can be, copied. */

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const write = (folder: string, frontmatter: string, file = 'SKILL.md') => {
    fs.mkdirSync(path.join(dir, folder), { recursive: true })
    fs.writeFileSync(path.join(dir, folder, file), `---\n${frontmatter}\n---\n\n正文\n`)
  }
  return { dir, write }
}

test('kebab case from a name: lower case, words joined by hyphens; nothing left when no letter or digit is', () => {
  assert.equal(kebabName('Meeting Notes'), 'meeting-notes')
  assert.equal(kebabName('  PDF__Forms v2 '), 'pdf-forms-v2')
  assert.equal(kebabName('周报'), '')
})

test('the folders a user may have skills in, those with any', (t) => {
  const { dir, write } = setup(t)
  write('home/.claude/skills/weekly', 'name: weekly\ndescription: x')
  write('home/.codex/skills/a', 'name: a\ndescription: x')
  write('home/.codex/skills/b', 'name: b\ndescription: x')
  fs.mkdirSync(path.join(dir, 'home/.agents/skills'), { recursive: true })
  const sources = skillSources({ home: path.join(dir, 'home'), dshHome: path.join(dir, 'home/.dsh') })
  assert.deepEqual(sources.map((source) => [source.id, source.count]), [['claude-code', 1], ['codex', 2]], 'an empty folder or none is not offered')
})

test('scanning a folder of skills: ready, fixable (name, clash) or not, each with why', (t) => {
  const { dir, write } = setup(t)
  write('src/weekly', 'name: weekly\ndescription: 周报')
  write('src/notes', 'name: Meeting Notes\ndescription: 会议记录')
  write('src/git', 'name: git-helper\ndescription: x')
  write('src/twin', 'name: weekly\ndescription: 另一个周报')
  write('src/zh', 'name: 周报助手\ndescription: x')
  write('src/broken', 'name: broken')
  fs.writeFileSync(path.join(dir, 'src', 'flat.md'), '---\nname: flat\ndescription: 单文件\n---\n')
  fs.writeFileSync(path.join(dir, 'src', 'notes.txt'), 'not a skill')
  const found = scanSkills(path.join(dir, 'src'), new Set(['git-helper']))
  const row = (entry: string) => found.find((candidate) => candidate.entry === entry)!
  assert.deepEqual(found.map((candidate) => candidate.entry).toSorted(), ['broken', 'flat.md', 'git', 'notes', 'twin', 'weekly', 'zh'])
  assert.deepEqual([row('weekly').status, row('weekly').name, row('weekly').picked], ['ready', 'weekly', true])
  assert.deepEqual([row('flat.md').status, row('flat.md').name], ['ready', 'flat'])
  assert.deepEqual([row('notes').status, row('notes').name, row('notes').fix, row('notes').picked], ['fixable', 'meeting-notes', 'name-format', true])
  assert.deepEqual([row('git').status, row('git').name, row('git').fix, row('git').picked], ['fixable', 'git-helper-2', 'taken', false], 'Viva has one by that name: offered renamed, not picked')
  assert.deepEqual([row('twin').status, row('twin').name, row('twin').fix], ['fixable', 'weekly-2', 'taken'], 'two in the folder with one name')
  assert.deepEqual([row('zh').status, row('zh').picked], ['blocked', false], 'a name that makes no kebab case is left to the user')
  assert.deepEqual([row('broken').status, row('broken').issues], ['blocked', ['fields']])
})

test('one skill picked as the folder: it alone is the candidate', (t) => {
  const { dir, write } = setup(t)
  write('one', 'name: one\ndescription: x')
  assert.deepEqual(scanSkills(path.join(dir, 'one'), new Set()).map((candidate) => [candidate.entry, candidate.status]), [['one', 'ready']])
})

test('importing copies what is picked, renamed in the copy only; the original is left as it was', (t) => {
  const { dir, write } = setup(t)
  write('src/notes', 'name: Meeting Notes\ndescription: 会议记录\nmetadata:\n  team: core')
  write('src/weekly', 'name: weekly\ndescription: 周报')
  write('src/broken', 'name: broken')
  const target = path.join(dir, 'viva')
  const found = scanSkills(path.join(dir, 'src'), new Set())
  const result = importCandidates(found, ['notes', 'broken'], target)
  assert.deepEqual(result, { imported: ['meeting-notes'], failed: [] }, 'one that cannot load is never copied, picked or not')
  const copied = fs.readFileSync(path.join(target, 'meeting-notes', 'SKILL.md'), 'utf8')
  assert.deepEqual(checkSkill(copied), { name: 'meeting-notes', description: '会议记录', issues: [] })
  assert.match(copied, /team: core/, 'the rest of its frontmatter kept')
  assert.match(copied, /正文/)
  assert.match(fs.readFileSync(path.join(dir, 'src', 'notes', 'SKILL.md'), 'utf8'), /name: Meeting Notes/, 'the original untouched')
  assert.equal(fs.existsSync(path.join(target, 'weekly')), false, 'only what was picked')
})

test('a folder already taken by the time of the copy is reported, not written over', (t) => {
  const { dir, write } = setup(t)
  write('src/weekly', 'name: weekly\ndescription: 周报')
  const target = path.join(dir, 'viva')
  const found = scanSkills(path.join(dir, 'src'), new Set())
  fs.mkdirSync(path.join(target, 'weekly'), { recursive: true })
  const result = importCandidates(found, ['weekly'], target)
  assert.deepEqual([result.imported, result.failed.map((failure) => failure.entry)], [[], ['weekly']])
})

/** A link made, or the test skipped where the system will not make one (Windows without the right). */
function linkOrSkip(t: TestContext, target: string, at: string, type: 'dir' | 'file'): boolean {
  try {
    fs.symlinkSync(target, at, type === 'dir' ? 'junction' : 'file')
    return true
  } catch {
    t.skip('this system will not make the link')
    return false
  }
}

test('a skill reached through a link is copied as files: renaming the copy never writes through to the original', (t) => {
  const { dir, write } = setup(t)
  write('real/notes', 'name: Meeting Notes\ndescription: 会议记录')
  write('real/flat', 'name: Weekly Notes\ndescription: 周报')
  const original = (file: string) => fs.readFileSync(path.join(dir, file))
  const before = { folder: original('real/notes/SKILL.md'), file: original('real/flat/SKILL.md') }
  fs.mkdirSync(path.join(dir, 'src', 'linked-file'), { recursive: true })
  if (!linkOrSkip(t, path.join(dir, 'real', 'notes'), path.join(dir, 'src', 'notes'), 'dir')) return
  if (!linkOrSkip(t, path.join(dir, 'real', 'flat', 'SKILL.md'), path.join(dir, 'src', 'linked-file', 'SKILL.md'), 'file')) return

  const target = path.join(dir, 'viva')
  const found = scanSkills(path.join(dir, 'src'), new Set())
  assert.deepEqual(found.map((candidate) => [candidate.entry, candidate.name]).toSorted(), [['linked-file', 'weekly-notes'], ['notes', 'meeting-notes']])
  const result = importCandidates(found, ['notes', 'linked-file'], target)
  assert.deepEqual(result.imported.toSorted(), ['meeting-notes', 'weekly-notes'])
  assert.deepEqual([original('real/notes/SKILL.md'), original('real/flat/SKILL.md')], [before.folder, before.file], 'the originals are byte for byte as they were')
  for (const copied of ['meeting-notes', 'weekly-notes']) {
    assert.equal(fs.lstatSync(path.join(target, copied)).isSymbolicLink(), false, `${copied} is a folder of its own`)
    assert.equal(fs.lstatSync(path.join(target, copied, 'SKILL.md')).isSymbolicLink(), false, `${copied}/SKILL.md is a file of its own`)
    assert.equal(checkSkill(fs.readFileSync(path.join(target, copied, 'SKILL.md'), 'utf8')).name, copied)
  }
})

test('a link inside a skill pointing back up its own folder is left out, so the copy ends', (t) => {
  const { dir, write } = setup(t)
  write('src/loop', 'name: loop\ndescription: x')
  if (!linkOrSkip(t, path.join(dir, 'src', 'loop'), path.join(dir, 'src', 'loop', 'again'), 'dir')) return
  const target = path.join(dir, 'viva')
  const result = importCandidates(scanSkills(path.join(dir, 'src'), new Set()), ['loop'], target)
  assert.deepEqual(result, { imported: ['loop'], failed: [] })
  assert.deepEqual(fs.readdirSync(path.join(target, 'loop')), ['SKILL.md'])
})
