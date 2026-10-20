/**
 * The tools the model configures the app with. Each names the operation the app performs (config contract,
 * lib/channel.js); `mutating` ones are asked of the user first through dsh's approval card, with `reason`
 * as what the card says. Parameters use dsh's schema DSL; the app checks them again before acting.
 */
const NAME = { type: 'string', required: true, description: '服务器名称：字母、数字、- 或 _，例如 github' }

export const CONFIG_TOOLS = Object.freeze([
  {
    name: 'viva_mcp_list',
    op: 'mcp_list',
    mutating: false,
    description: '列出用户已经接入的 MCP 服务器。',
    parameters: {},
  },
  {
    name: 'viva_mcp_add',
    op: 'mcp_add',
    mutating: true,
    description: '为用户接入一个 MCP 服务器（本地命令，或 HTTP 地址），让你获得它提供的工具。'
      + '服务需要令牌或密钥时，只在 secrets 里写变量名（本地服务器写环境变量名，HTTP 服务器写请求头名），用户会在窗口里的安全输入框填写；'
      + '绝不要在对话里向用户要密钥的值，也不要把密钥写进参数。用户确认后才会接入，这一轮结束后生效。',
    parameters: {
      name: NAME,
      command: { type: 'string', description: '本地服务器的启动命令，例如 npx；和 url 二选一' },
      args: { type: 'array', items: { type: 'string' }, description: '启动参数，例如 ["-y", "@modelcontextprotocol/server-github"]' },
      url: { type: 'string', description: 'HTTP 服务器的地址（https://…）；和 command 二选一' },
      secrets: { type: 'array', items: { type: 'string' }, description: '需要用户填写的密钥名，例如 ["GITHUB_TOKEN"]；不需要就不写' },
    },
    reason: (args) => `接入 MCP 服务器「${args.name ?? ''}」`,
  },
  {
    name: 'viva_mcp_remove',
    op: 'mcp_remove',
    mutating: true,
    description: '移除用户的一个 MCP 服务器。',
    parameters: { name: NAME },
    reason: (args) => `移除 MCP 服务器「${args.name ?? ''}」`,
  },
  {
    name: 'viva_skill_list',
    op: 'skill_list',
    mutating: false,
    description: '列出用户的 skill（教你按用户的方式做某类事的说明）。',
    parameters: {},
  },
  {
    name: 'viva_skill_create',
    op: 'skill_create',
    mutating: true,
    description: '把一套做法存成用户的新 skill，以后遇到同类事就按它做。用户说「以后都这样做」「存成 skill」时使用。',
    parameters: {
      name: { type: 'string', required: true, description: '英文小写字母、数字和连字符，例如 weekly-report' },
      description: { type: 'string', required: true, description: '一句话，用用户的语言：这个 skill 做什么、什么时候用' },
      instructions: { type: 'string', required: true, description: '具体做法，Markdown，写清步骤和要求' },
    },
    reason: (args) => `新建 skill「${args.name ?? ''}」`,
  },
  {
    name: 'viva_skill_install',
    op: 'skill_install',
    mutating: true,
    description: '安装用户电脑上已有的 skill：含 SKILL.md 的文件夹，或一个 .md 文件。',
    parameters: { path: { type: 'string', required: true, description: '文件夹或文件的完整路径' } },
    reason: (args) => `安装 skill：${args.path ?? ''}`,
  },
  {
    name: 'viva_skill_remove',
    op: 'skill_remove',
    mutating: true,
    description: '删除用户的一个 skill（移到废纸篓，可以找回）。',
    parameters: { id: { type: 'string', required: true, description: 'viva_skill_list 列出的 id' } },
    reason: (args) => `删除 skill「${args.id ?? ''}」`,
  },
])
