import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkSkill, SKILL_NAME } from '../src/backend/skill-spec.ts'

/** A skill as dsh reads it (skill-spec.ts): the same rules, so what is listed as fine is what dsh loads. */

const skill = (frontmatter: string, body = 'body') => `---\n${frontmatter}\n---\n${body}`

test('a skill dsh loads: name in kebab case, a description, YAML of any style', () => {
  assert.deepEqual(checkSkill(skill('name: weekly-report\ndescription: 按团队模板写周报')), { name: 'weekly-report', description: '按团队模板写周报', issues: [] })
  assert.deepEqual(checkSkill(skill('name: "x2"\ndescription: >\n  第一行\n  第二行\nmetadata: {}')).description, '第一行 第二行\n')
  assert.deepEqual(checkSkill(skill('name: a\ndescription: b\ndisable-model-invocation: yes\nuser-invocable: "0"')).issues, [])
})

test('what dsh skips, and why: no frontmatter, bad YAML, a field missing, a name not in kebab case, a bad switch', () => {
  const issues = (text: string) => checkSkill(text).issues
  assert.deepEqual(issues('# just markdown'), ['frontmatter'])
  assert.deepEqual(issues('---\nname: a\ndescription: b\n'), ['frontmatter'], 'never closed')
  assert.deepEqual(issues(skill('name: [a\ndescription: b')), ['frontmatter'], 'YAML that does not parse')
  assert.deepEqual(issues(skill('- a\n- b')), ['frontmatter'], 'a list, not fields')
  assert.deepEqual(issues(skill('name: a')), ['fields'])
  assert.deepEqual(issues(skill('name: a\ndescription: ""')), ['fields'], 'an empty description is none')
  assert.deepEqual(issues(skill('name: 42\ndescription: b')), ['fields'], 'a name that is not text')
  assert.deepEqual(issues(skill('name: Meeting Notes\ndescription: b')), ['name-format'])
  assert.deepEqual(issues(skill('name: a\ndescription: b\nuser-invocable: maybe')), ['invocation'])
  assert.deepEqual(issues(skill('name: a\ndescription: b\nuserInvocable: true')), ['invocation'], 'the old spelling dsh refuses')
})

test('the name rule is dsh\'s own', () => {
  for (const name of ['a', 'weekly-report', 'v2-notes']) assert.ok(SKILL_NAME.test(name), name)
  for (const name of ['Weekly', 'a--b', '-a', 'a-', 'a_b', 'a b', '']) assert.ok(!SKILL_NAME.test(name), name)
})

test('line endings from Windows read the same', () => {
  assert.deepEqual(checkSkill('---\r\nname: a\r\ndescription: b\r\n---\r\nbody').issues, [])
})
