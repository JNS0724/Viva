import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { hubPage } from '../src/renderer/hub-state.ts'
import { capabilityCounts, capabilityFeedback, capabilityProblems, pluginStanding, serverStanding, shownPlugin, shownServer, shownSkill, skillGroups } from '../src/renderer/capabilities-state.ts'
import type { PluginView, ServerView, SkillView } from '../src/renderer/capability-types.ts'

/** 能力 (capabilities-state.ts): skills, MCP and plugins, a page of the hub; what is listed, what is shown, what is wrong. */

const skill = (id: string, extra: Partial<SkillView> = {}): SkillView => ({
  id, name: id.split(':')[1], description: `${id} 的说明`, root: id.split(':')[0], rootLabel: `root ${id.split(':')[0]}`,
  managed: id.startsWith('user:'), issues: [], problem: '', shadowedBy: null, ...extra,
})
const server = (name: string, extra: Partial<ServerView> = {}): ServerView => ({ name, type: 'stdio', command: 'npx', args: [], envNames: [], headerNames: [], ...extra })
const plugin = (name: string, extra: Partial<PluginView> = {}): PluginView => ({
  name, version: '1.0.0', description: null, enabled: true, removable: true, error: null, fit: { kind: 'fits' }, rows: [], overrides: [], ...extra,
})

function loaded({ skills = [] as SkillView[], servers = [] as ServerView[], plugins = [] as PluginView[], active = [] as string[], dropped = [] as Array<{ name: string, reason: string }> } = {}) {
  const withExtensions = reduce(initialState, { type: 'extensions_loaded', view: { skills, servers, status: { active, dropped, memory: true } } })
  return reduce(withExtensions, { type: 'plugins_loaded', view: { connected: true, plugins } })
}

test('a page of the hub: opening it closes the others, on the tab and item asked for', () => {
  const settings = reduce(initialState, { type: 'settings_open' })
  const state = reduce(settings, { type: 'capabilities_open', tab: 'mcp', id: 'github' })
  assert.equal(hubPage(state), 'capabilities')
  assert.deepEqual([state.capabilities.tab, state.capabilities.selected, state.settings.open], ['mcp', 'github', false])
  assert.equal(hubPage(reduce(state, { type: 'hub_close' })), null)
  const switched = reduce(reduce(state, { type: 'capabilities_query', query: 'git' }), { type: 'capabilities_tab', tab: 'plugins' })
  assert.deepEqual([switched.capabilities.tab, switched.capabilities.selected, switched.capabilities.query], ['plugins', null, ''], 'a new tab starts afresh')
})

test('skills grouped by where they are, in order, and found by name or description', () => {
  const state = loaded({ skills: [skill('user:weekly'), skill('user:pdf'), skill('workspace:release', { description: '发版检查' })] })
  assert.deepEqual(skillGroups(state).map((group) => [group.root, group.skills.map((one) => one.name)]), [['user', ['weekly', 'pdf']], ['workspace', ['release']]])
  const found = reduce(state, { type: 'capabilities_query', query: '发版' })
  assert.deepEqual(skillGroups(found).map((group) => group.skills.map((one) => one.name)), [['release']])
  assert.deepEqual(skillGroups(reduce(state, { type: 'capabilities_query', query: 'WEEK' }))[0].skills.map((one) => one.name), ['weekly'], 'case does not matter')
})

test('the one shown: the one picked while it is listed, else the first that is wrong, else the first', () => {
  const state = loaded({ skills: [skill('user:weekly'), skill('user:notes', { issues: ['name-format'], problem: 'x' })] })
  assert.equal(shownSkill(state)?.id, 'user:notes', 'what needs looking at first')
  assert.equal(shownSkill(reduce(state, { type: 'capabilities_select', id: 'user:weekly' }))?.id, 'user:weekly')
  assert.equal(shownSkill(reduce(state, { type: 'capabilities_select', id: 'user:gone' }))?.id, 'user:notes')
  assert.equal(shownSkill(loaded()), null)
  const servers = reduce(loaded({ servers: [server('a'), server('b')], active: ['a', 'b'] }), { type: 'capabilities_open', tab: 'mcp', id: 'b' })
  assert.equal(shownServer(servers)?.name, 'b')
  assert.equal(shownPlugin(loaded({ plugins: [plugin('p1'), plugin('p2', { error: { code: 'not-bundle', detail: null } })] }))?.name, 'p2')
})

test('how a server stands: a key missing, connected, dropped with why, or not yet', () => {
  const status = { active: ['on'], dropped: [{ name: 'down', reason: 'timeout' }], memory: true }
  assert.deepEqual(serverStanding(server('on', { missingNames: ['TOKEN'] }), status), { kind: 'missing', names: ['TOKEN'] })
  assert.deepEqual(serverStanding(server('on'), status), { kind: 'connected' })
  assert.deepEqual(serverStanding(server('down'), status), { kind: 'dropped', reason: 'timeout' })
  assert.deepEqual(serverStanding(server('new'), status), { kind: 'idle' })
})

test('how a plugin stands: broken, off, on but needing dsh\'s Web host, rows not running, or on', () => {
  assert.deepEqual(pluginStanding(plugin('p', { error: { code: 'incompatible-version', detail: 'needs 0.1' } })), { kind: 'error', code: 'incompatible-version', detail: 'needs 0.1' })
  const rows = [{ id: 'a', entryId: 'e1', enabled: true, phase: 'pending' }, { id: 'b', entryId: 'e2', enabled: true, phase: 'active' }, { id: 'c', entryId: null, enabled: false, phase: null }]
  assert.deepEqual(pluginStanding(plugin('p', { rows })), { kind: 'stalled', rows: ['a'] })
  assert.deepEqual(pluginStanding(plugin('p', { rows, enabled: false })), { kind: 'off' })
  assert.deepEqual(pluginStanding(plugin('p')), { kind: 'on' })
  const web = { kind: 'needs-web' as const, needs: ['@deepseek-ai/dsh-host-webserver'] }
  assert.deepEqual(pluginStanding(plugin('p', { fit: web, rows })), { kind: 'unsupported', needs: web.needs })
  assert.deepEqual(pluginStanding(plugin('p', { fit: web, enabled: false })), { kind: 'off' }, 'switched off, it is not in the way')
})

test('counts for the tabs, and how many need looking at for the way in', () => {
  const state = loaded({
    skills: [skill('user:a'), skill('user:b', { issues: ['fields'], problem: 'x' })],
    servers: [server('on'), server('down'), server('key', { missingNames: ['T'] })],
    plugins: [plugin('ok'), plugin('bad', { error: { code: 'not-bundle', detail: null } }), plugin('off', { enabled: false }), plugin('web', { fit: { kind: 'needs-web', needs: ['@deepseek-ai/dsh-web'] } })],
    active: ['on'], dropped: [{ name: 'down', reason: 'x' }],
  })
  assert.deepEqual(capabilityCounts(state), { skills: 2, mcp: 3, plugins: 4 })
  assert.equal(capabilityProblems(state), 5, 'a broken skill, a dropped server, one missing a key, a broken plugin, one Viva cannot run; one switched off is fine')
  assert.equal(capabilityProblems(initialState), 0, 'nothing loaded, nothing wrong')
})

test('what a change came to is said whatever is listed: a failed first import, the last one removed', () => {
  const mcp = reduce(loaded(), { type: 'capabilities_open', tab: 'mcp' })
  const failed = reduce(reduce(mcp, { type: 'extensions_busy' }), { type: 'extensions_failed', message: '读不到 dsh 的配置' })
  assert.equal(shownServer(failed), null, 'nothing to pick')
  assert.deepEqual(capabilityFeedback(failed), { error: '读不到 dsh 的配置', notice: null })

  const one = reduce(loaded({ servers: [server('demo')] }), { type: 'capabilities_open', tab: 'mcp' })
  const removed = reduce(one, { type: 'extensions_saved', view: { servers: [] }, notice: '已删除' })
  assert.deepEqual([shownServer(removed), capabilityFeedback(removed)], [null, { error: null, notice: '已删除' }])

  const plugins = reduce(reduce(loaded(), { type: 'capabilities_open', tab: 'plugins' }), { type: 'plugins_failed', message: '找不到这个包' })
  assert.deepEqual(capabilityFeedback(plugins), { error: '找不到这个包', notice: null }, 'the plugins tab says the plugins\' own')
  assert.deepEqual(capabilityFeedback(reduce(plugins, { type: 'capabilities_tab', tab: 'skills' })), { error: null, notice: null })
})
