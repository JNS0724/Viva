import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const GLOBALS = read('src/renderer/globals.d.ts')

/** The block between `interface Name {` and its closing brace at the start of a line. */
const interfaceBody = (name) => {
  const start = GLOBALS.indexOf(`interface ${name} {`)
  assert.ok(start >= 0, `globals.d.ts declares ${name}`)
  return GLOBALS.slice(start, GLOBALS.indexOf('\n}', start))
}

/** Each method a preload script puts on the page, with the channel it invokes or sends on (null: none). */
const exposed = (rel) => new Map([...read(rel).matchAll(/^ {2}(\w+): (.*)$/gm)].map(([, name, rest]) => [
  name,
  rest.match(/ipcRenderer\.(?:invoke|send)\('([^']+)'/)?.[1] ?? null,
]))

/** Each member a declared interface names, with the channel its type takes its arguments from (null: none). */
const declared = (name) => new Map([...interfaceBody(name).matchAll(/^ {2}(\w+): (.*)$/gm)].map(([, member, type]) => [
  member,
  type.match(/(?:Invoke|Args)<'([^']+)'>/)?.[1] ?? null,
]))

const sorted = (map) => [...map].sort(([a], [b]) => a.localeCompare(b))

test('window.agent is declared with every method preload.cjs puts on the page, each on its own channel', () => {
  assert.deepEqual(sorted(declared('AgentApi')), sorted(exposed('src/preload/preload.cjs')))
})

test('window.desk is declared with every method desk-preload.cjs puts on the page', () => {
  const desk = exposed('src/preload/desk-preload.cjs')
  const types = declared('DeskApi')
  assert.deepEqual([...types.keys()].sort(), [...desk.keys()].sort())
  for (const [member, channel] of types) {
    if (channel) assert.equal(desk.get(member), channel, `${member} takes the arguments of the channel it sends on`)
  }
})
