import assert from 'node:assert/strict'
import type { ConfigActions } from '../../src/backend/config-channel.ts'

export function recordingActions() {
  const added: Array<Parameters<ConfigActions['addServer']>> = []
  const actions: ConfigActions = {
    listServers: () => [],
    prepareServer: () => {},
    addServer: (spec, secrets) => {
      added.push([spec, secrets])
      return `已接入 MCP 服务器「${spec.name}」，这一轮结束后生效。`
    },
    prepareUpdate: () => assert.fail('unexpected update'),
    updateServer: () => assert.fail('unexpected update'),
    importServers: () => assert.fail('unexpected import'),
    removeServer: (name) => `已移除「${name}」`,
    listSkills: () => [],
    createSkill: (spec) => `已新建「${spec.name}」`,
    installSkill: (path) => `已安装 ${path}`,
    removeSkill: (id) => `已删除 ${id}`,
  }
  return { added, actions }
}
