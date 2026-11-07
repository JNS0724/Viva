import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listSkills, projectRoot, skillRoots } from '../src/backend/skills.ts'

/** The skills listed as dsh would load them (skills.ts): its rules, and which of two with one name it takes. */

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const roots = skillRoots({ dshHome: path.join(dir, 'dsh'), cwd: path.join(dir, 'ws') })
  const write = (rootId: string, folder: string, frontmatter: string) => {
    const root = roots.find((one) => one.id === rootId)!
    fs.mkdirSync(path.join(root.dir, folder), { recursive: true })
    fs.writeFileSync(path.join(root.dir, folder, 'SKILL.md'), `---\n${frontmatter}\n---\n\n正文`)
  }
  return { roots, write }
}

test('a skill dsh would skip says why, by dsh\'s own rules', (t) => {
  const { roots, write } = setup(t)
  write('user', 'notes', 'name: Meeting Notes\ndescription: 会议记录')
  write('user', 'switch', 'name: switch\ndescription: x\nuser-invocable: maybe')
  write('user', 'fine', 'name: fine\ndescription: x\ndisable-model-invocation: yes')
  assert.deepEqual(listSkills(roots).map((skill) => [skill.name, skill.issues, Boolean(skill.problem)]), [
    ['fine', [], false],
    ['Meeting Notes', ['name-format'], true],
    ['switch', ['invocation'], true],
  ])
})

test('of skills with one name, the project\'s .dsh one is loaded; the others say whose is', (t) => {
  const { roots, write } = setup(t)
  write('user', 'review', 'name: review\ndescription: 我的')
  write('workspace-agents', 'review', 'name: review\ndescription: 团队的')
  write('workspace', 'review', 'name: review\ndescription: 项目的')
  write('user', 'broken', 'name: review')
  const workspace = roots.find((root) => root.id === 'workspace')!.label
  const skills = listSkills(roots)
  const loaded = Object.fromEntries(skills.filter((skill) => !skill.issues.length).map((skill) => [skill.root, skill.shadowedBy]))
  assert.deepEqual(loaded, { user: workspace, workspace: null, 'workspace-agents': workspace })
  assert.equal(skills.find((skill) => skill.issues.length)?.shadowedBy, null, 'one dsh skips hides nothing and is hidden by nothing')
})

test('started in a folder under the repository, the project\'s skills are the repository\'s, as dsh takes them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-root-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true })
  assert.equal(projectRoot(path.join(repo, 'src', 'deep')), repo, 'the nearest folder holding .git')
  assert.equal(projectRoot(path.join(dir, 'loose')), path.join(dir, 'loose'), 'none: the working folder itself')

  const roots = skillRoots({ dshHome: path.join(dir, 'dsh'), cwd: path.join(repo, 'src') })
  const write = (rootId: string) => {
    const root = roots.find((one) => one.id === rootId)!
    fs.mkdirSync(path.join(root.dir, 'review'), { recursive: true })
    fs.writeFileSync(path.join(root.dir, 'review', 'SKILL.md'), '---\nname: review\ndescription: x\n---\n')
  }
  write('user')
  write('workspace')
  assert.equal(roots.find((root) => root.id === 'workspace')!.dir, path.join(repo, '.dsh', 'skills'))
  const mine = listSkills(roots).find((skill) => skill.root === 'user')!
  assert.equal(mine.shadowedBy, roots.find((root) => root.id === 'workspace')!.label, 'the repository\'s review is the one dsh loads')
})
