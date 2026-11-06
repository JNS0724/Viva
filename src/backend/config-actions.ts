import { t } from '../shared/i18n/translate.ts'
import type { ConfigActions, ServerUpdate } from './config-channel.ts'
import { editServer, parseServerInput, type ServerChanges, type createMcpConfigStore } from './mcp-config.ts'
import { expandHome, importSummary, userDshHome, type ImportResult } from './dsh-mcp-import.ts'
import { createSkill, importSkill, listSkills, removeSkill, type skillRoots } from './skills.ts'

/** The settings form's shape, which parseServerInput checks: keys as "NAME=value" lines, env or headers by type. */
function serverForm(spec: { name: string, url?: string, command?: string, args: readonly string[] }, secrets: Readonly<Record<string, unknown>>) {
  const pairs = Object.entries(secrets).map(([name, value]) => `${name}=${value}`).join('\n')
  const http = Boolean(spec.url)
  return { name: spec.name, type: http ? 'http' : 'stdio', command: spec.command, args: spec.args.join('\n'), url: spec.url, env: http ? '' : pairs, headers: http ? pairs : '' }
}

/** A change the model asked for (config-channel.ts ServerUpdate) as editServer takes it: what it names, and the keys typed. */
const updateChanges = (spec: ServerUpdate, secrets: Readonly<Record<string, string>>): ServerChanges => ({
  name: spec.newName || undefined,
  type: spec.url ? 'http' : spec.command ? 'stdio' : undefined,
  command: spec.command || undefined,
  args: spec.args ?? undefined,
  url: spec.url || undefined,
  values: secrets,
})

/** Approved configuration operations, independent of process startup and the backend composition root. */
export function createConfigActions({ store, roots, onMcpChange, importDsh, rememberDshDir, trash }: {
  store: Pick<ReturnType<typeof createMcpConfigStore>, 'list' | 'add' | 'remove' | 'update'>
  roots: () => ReturnType<typeof skillRoots>
  onMcpChange: () => void
  importDsh: (dir: string) => Promise<ImportResult>
  rememberDshDir: (dir: string) => void
  trash: (file: string) => Promise<void>
}): ConfigActions {
  const takenServerNames = () => store.list().map(server => server.name)
  function serverNamed(name: string) {
    const server = store.list().find((item) => item.name === name)
    if (!server) throw new Error(t("main.main.no.mcp.server.named", { name: name }))
    return server
  }

  const userRoot = () => {
    const root = roots().find((item) => item.managed)
    if (!root) throw new Error('the app has no skill folder of its own')
    return root.dir
  }
  return {
    listServers: () => store.list().map((server) => `${server.name}（${server.type === 'http' ? server.url : [server.command, ...server.args].join(' ')}）`
      + (server.missing.length ? t("main.main.missing.credentials", { value1: server.missing.join('、') }) : '')),
    prepareServer: (spec) => {
      parseServerInput(serverForm(spec, Object.fromEntries(spec.secrets.map((name) => [name, 'x']))), takenServerNames())
    },
    addServer: (spec, secrets) => {
      store.add(parseServerInput(serverForm(spec, secrets), takenServerNames()))
      onMcpChange()
      return t("main.main.connected.mcp.server.takes.effect.after.this", { name: spec.name, value2: spec.secrets.length ? t("main.main.credentials.are.entered.in.the.window.by") : '' })
    },
    removeServer: (name) => {
      if (!takenServerNames().includes(name)) throw new Error(t("main.main.no.mcp.server.named", { name: name }))
      store.remove(name)
      onMcpChange()
      return t("main.main.removed.mcp.server.takes.effect.after.this", { name: name })
    },
    prepareUpdate: (spec) => {
      editServer(serverNamed(spec.name), updateChanges(spec, Object.fromEntries(spec.secrets.map((name) => [name, 'x']))), takenServerNames())
    },
    updateServer: (spec, secrets) => {
      const next = editServer(serverNamed(spec.name), updateChanges(spec, secrets), takenServerNames())
      store.update(spec.name, next)
      onMcpChange()
      return t("main.main.updated.mcp.server.takes.effect.after.this", { name: next.name, value2: next.missing.length ? t("main.main.still.needs.the.user.can.enter.these", { value1: next.missing.join('、') }) : '' })
    },
    /** No card: the servers and keys are the user's own, already set up in dsh (they asked for it this way). */
    importServers: async (dir) => {
      const target = dir ? expandHome(dir) : userDshHome()
      const result = await importDsh(target)
      if (result.added.length) onMcpChange()
      if (target !== userDshHome()) rememberDshDir(target)
      return importSummary(result, { forModel: true })
    },
    listSkills: () => listSkills(roots()).map((skill) => `${skill.id}：${skill.name}${skill.description ? ` — ${skill.description}` : ''}${skill.problem ? `（${skill.problem}）` : ''}`),
    createSkill: (spec) => t("main.main.created.skill.it.will.be.available.for", { value1: createSkill(spec, userRoot()) }),
    installSkill: (source) => t("main.main.installed.skill", { value1: importSkill(source, userRoot()) }),
    removeSkill: async (id) => t("main.main.deleted.skill.it.can.be.recovered.from", { value1: await removeSkill(id, roots(), trash) }),
  }
}
