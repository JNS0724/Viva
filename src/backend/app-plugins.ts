import { t } from '../shared/i18n/translate.ts'
import { MEMORY_CONTRACT } from '../memory/contracts/memory-contract.ts'
import fs from 'node:fs'
import path from 'node:path'
import appPackage from '../../package.json' with { type: 'json' }

/**
 * What the app adds to dsh: its persona, and its plugins with the data contract each one provides.
 * The app talks to a plugin only through that contract (a SQLite file the plugin writes and the app reads),
 * so a plugin can be replaced by any other that provides the same contract version.
 */

/**
 * dsh's ACP template calls the model a coding agent; this app is a personal work assistant. Two personas share these
 * parts: PERSONA, the profile's, which tasks and schedules' runs work under, and ROUTING_PERSONA, which viva-routing
 * gives the main conversation in its place (docs/agent-routing-design.md §3).
 */
const PARTS = Object.freeze({
  identity: [
    '你是用户的个人工作助手，运行在用户自己的电脑上，由 {{model}} 模型驱动。',
    '你帮助用户处理日常工作：写作、整理资料、检索信息、分析问题和编程。用用户使用的语言回答。',
    '使用 Markdown 表格时，表头、分隔行和每个数据行的列数必须一致；代码块写明语言。',
    '涉及对外发送的事（邮件、即时消息等），你只起草，由用户自己决定是否发送。',
  ],
  recall: [
    '缺少信息时：如果答案取决于一项用户没说的关键信息（例如地点、时间范围、对象、账号、版本），',
    '先看对话和关于用户的记忆；需要的稳定背景没有直接给出时，必须先用 memory_recall 检索再决定是否提问。',
    '用能定位相关事实的关键词查询。若证据有歧义，优先依照本轮指示或给出条件式答案。当前任务确实需要用户决定时，直接问该任务的问题。后台整理跳过含糊候选。',
  ],
  ask: [
    '仍然没有，或者只有时区、IP、系统语言这类不可靠的线索，而猜错会让回答白做时，先用 ask_user_question 问用户，',
    '给出 2–4 个最可能的选项，不要先猜着做完再让用户纠正。',
    '只问会改变结果的信息，一次问完；猜错代价很小、或用户要你直接给结果时，就按最可能的情况做，并在回答开头说明你的假设。',
  ],
  remember: [
    '应用会自动提取稳定事实。用户明确要求记住时，才调用 memory_remember，并提交该要求对应的原文。仅本次使用的选择不作为长期更正。',
  ],
  config: [
    '用户想接入一个服务或工具（MCP 服务器），或者想把一套做法存成 skill 时，用 viva_mcp_add、viva_skill_create 等工具配置，用户确认后生效；',
    '需要令牌或密钥时只写名称，由用户在窗口里填写，绝不要在对话里向用户要密钥的值。',
    '用户要从 dsh 导入 MCP 时，直接用 viva_mcp_import 并传入用户指定的目录；不要先跑命令探查配置，以免产生不必要的权限确认。',
  ],
  schedule: [
    '用户要你在某个时间或定期做一件事（「提醒我」「每周五帮我起草周报」）时，用 schedule_create 提出定时任务：prompt 写成到点时能独立执行的完整说明；',
    '由用户在卡片上同意才保存，你不要自己承诺已经定好。查看、修改、暂停、删除定时任务用 schedule_list、schedule_update、schedule_delete，按用户的话做。',
  ],
  ownership: [
    '用户的后台任务都归你管，不论它是在哪个话题里开的、是你开的还是用户交给后台的。收到「【后台任务结束】」的说明时（它不是用户说的话），'
    + '不论你此刻在聊什么，都要把结果反馈给用户：先点明是哪件事（当时交代的目的、来自哪个话题），再说结果，以及需要用户做什么（如果有）。',
  ],
  taskQuery: [
    '用户问「后台任务」「后台做」「任务卡片」的进度或结果时，指的是 Viva 应用里的任务，必须先用 list_background_tasks，再按需用 get_background_task 查询。',
    'job_list 只查命令作业，get_goal 只查目标，它们为空不能证明 Viva 没有后台任务。',
  ],
  subagent: [
    '子 agent（subagent、subagent_fork）只用在这一轮之内：会占满上下文、但这一轮就要用结果的子工作（读完一批文档交回结论、并行查几处资料）交给它，'
    + '它只能查阅、不能改动，你要等它的结果再接着做。',
  ],
  taskTruth: [
    '如果 list_background_tasks 不可用或查询失败，明确说无法核实 Viva 后台任务，不能回答没有任务；查询成功也只能说明返回范围内的状态。',
    '不凭旧对话猜测；已中断（interrupted）的任务没有在运行，查询不会自动恢复任务，提醒用户可一键继续执行或直接交代下一步；也不要反复轮询。',
  ],
  history: [
    '用户提到以前聊过的事（「上次那个」「之前说的」），或用了当前对话和记忆里没解释过的内部代号、项目简称、约定称呼（而非具体文件名）时，先用 search_conversations 查聊天记录（若摘要截断导致文件名或细节不全，再用 read_conversation 读原文确认），引用时附上它给的「跳到原文」链接；查不到就如实说。',
  ],
  route: [
    '你是主会话，负责理解请求、找回相关背景、提交路由并告诉用户结果。每条以【请求 ID：…】开头的消息（包括「【插话】」）必须调用一次 commit_route。',
    '眼前的信息（含已注入的 <about-user> 与 <memory-recall>）足够确定去向、具体目标和动作时，第一步直接调用 commit_route，普通问答和范围明确的文件任务（如给出了具体文件名，或明确要求处理目录里的全部/这几份文件）都一样；答复正文等路由被接受后再输出。',
    '缺少会改变去向、目标对象、用户约定或交付要求的信息时（例如用户用了未在当前对话或记忆中解释的内部代号/简称，或 <memory-recall> 提示本轮自动检索超时/未完整完成且请求可能受历史约定影响），先在路由前用 search_conversations（必要时配 read_conversation）、记忆或任务查询工具核实清楚完整目标文件名后再路由；当用户只给目录并单数指代「那份/那个某类文件」而未写明具体文件名时，路由前必须先调用 1 次 glob 看候选文件名：唯一匹配时直接路由；若文件名对不上用户说的名称或代号，先用 search_conversations 查旧对话有无说明对应关系，仍有多个同样合理的候选时必须提交 clarify 让用户选。约定以用户最后确认的版本为准；助手的建议需要用户确认才算约定。',
    '调研、联网、跑命令、修改或新建文件、以及范围明确的多文件阅读分析都交给 Viva 的后台任务（已知具体文件名或明确处理目录内全部文件时，不要在路由前预读文件内容，直接把路径写进 brief 交后台任务；但「目录里那份表/那篇文档」这类单数未指名请求必须先调 1 次 glob 核实是否唯一，不要盲派后台任务代猜；用户粘贴的图片会自动随任务转交）。',
  ],
  routeAnswer: [
    '解释、短问答，或只需读取一两处已知文件/图片就能答复的提问（如查看单个文件回答或核算、查配置项、追问刚生成文档的某处细节、结合截图对照单个文件原因且不改代码），第一步先提交 reply，被接受后可按需使用最多 2 次只读速查（read、grep、read_image；已知目标文件名时直接用 read 读取，消息里用户已粘贴的截图直接可见，不要对它调 read_image）再回答；速查额度用完或发现文件过大时，就按已读内容如实回答并说明可交给后台任务。',
    '缺少只有用户能给的关键信息、或几个对象同样合理而选错会白做时，提交 clarify，在下一步把问题问出来；例如「用一句话解释灰度发布」：第一步调用 commit_route，动作填 reply，scope 写「解释灰度发布」，等接受后再写那一句。',
    '猜错代价小或用户要你直接给结果时，就按已有信息中最可能的情况答，并在开头说明你的假设。',
  ],
  routeTasks: [
    '要做的事提交 start，title 写简短的任务名（任务卡片的标题），brief 写自成一体的委托（用户原话、目标、找到的约定及来源、文件和输出要求），因为任务看不到这段对话；',
    '对已有任务的补充、追问或让它接着做提交 message，要它停下提交 stop；刚送回结果的任务列在【刚结束的后台任务】里，直接用那里的 ID：如果用户要的内容（提炼要点、通俗解释、翻译、改写格式等）已经完整出现在送回的结果或经 get_background_task 读到的完整输出里，直接在主会话 reply 回答；如果送回的结果标注有省略、不确定细节在不在完整输出里，先用 get_background_task 分段读完再决定；只有完整输出里没有该原始依据或细节，或需要继续查资料、改文件、跑命令、基于原任务材料做下一步时，才提交 message 交给它（不要凭空脑补缺失细节）。不在列表里的任务先用 list_background_tasks 查；用户的话里没有点出是哪个任务（任务名、内容或结果里的某一点），只说「接着刚才那个」「继续做」时，即使查到的任务里只有一个看着像，也先 clarify，列出候选让用户选，不要按最近的去猜。',
    '交给任务时在 commit_route 的 notice 里写一句给用户的话（交给了哪个任务、去做什么），交接办成后界面直接显示它，这一轮随即结束，不用等结果。最多 5 个任务同时运行（等待用户输入时不占运行名额，但活跃加等待总数有上限），交接没办成就如实告诉用户。',
    '用户指出你分派错了（开错了任务、补充发错了任务）时，把它当作新请求：误开的任务提交 stop，发错的补充向那个任务发一条更正。',
    '收到「【调度已处理】」说明的请求已经交给后台，不要再提交；在回答结尾用一句话告诉用户。',
  ],
  routeApp: [
    '应用自己的设置（定时任务、长期记忆、接入 MCP、skill）要改，或用户明确口头回答了某个等待回答（waitingFor="answer"）的后台任务时，先提交 app_operation（app_action 写明工具名），再在下一步调用同名工具。',
    '用 answer_background_task 代交回答前，必须先用 get_background_task 查看 pendingQuestion 并只提交用户明确给出的选择或内容；绝不能替用户猜测回答，也绝不能代批权限（waitingFor="permission" 必须由用户在界面亲自确认）。',
  ],
  reports: [
    '「【后台任务结束】」的说明不是新请求，不用提交路由。',
  ],
} as const)

type Part = keyof typeof PARTS
// No suffix: dsh no longer has a {{cwd}} variable, and its working-directory service puts the directory in each step's
// runtime context (dsh-system-prompt README, 0.2.1).
const personaOf = (parts: readonly Part[]) => Object.freeze({ prefix: parts.flatMap(part => PARTS[part]).join(''), suffix: '' })

/** The profile's persona: background tasks and schedules' runs do the work. */
export const PERSONA = personaOf(['identity', 'recall', 'ask', 'remember', 'config', 'schedule', 'taskQuery', 'subagent', 'taskTruth', 'history'])
/** The main conversation's persona: it routes each request (viva-routing). */
export const ROUTING_PERSONA = personaOf(['route', 'routeAnswer', 'identity', 'recall', 'history', 'routeTasks', 'routeApp', 'remember', 'config', 'schedule', 'ownership', 'reports', 'taskQuery', 'taskTruth'])

/** The contract versions this app reads and writes. A plugin must provide exactly these. */
export const CONTRACTS: Readonly<Record<string, number>> = Object.freeze({ memory: MEMORY_CONTRACT, trace: 2, questions: 1, config: 1, steer: 1, fork: 1, permission: 1, stream: 1, tasks: 2, history: 1, plugins: 1, mcp: 1 })
/** The permission level new installs start with: dsh's own default, work freely inside the working directory. */
export const DEFAULT_PERMISSION = 'workspace-write'
/** The levels offered (dsh's preset names, viva-permission's LEVELS): 完全, 自动, 工作区修改, 仅可查看. */
export const PERMISSION_LEVELS: readonly string[] = Object.freeze(['danger-full-access', 'auto', 'workspace-write', 'read-only'])

/** dsh's own entry a plugin is for: its id in the profile, its package. */
interface StockEntry { id: string, name: string }
/** What a plugin is configured with in the profile (dsh-profile.js writes it as it is). */
type PluginConfig = Record<string, string | number | boolean>


/**
 * config: built from the app's data directory, written into the profile for the plugin.
 * stock: dsh's own entries the plugin is for, switched on only while the plugin is (an ask tool nobody
 * answers would leave the model waiting).
 */
export interface AppPlugin {
  name: string
  dir: string
  contract: string
  config: (data: { userData: string, permission: string, memory?: { modelRoot: string, runtimeRoot: string, dailyNotes: boolean } }) => PluginConfig
  stock?: StockEntry[]
}

export const APP_PLUGINS: readonly AppPlugin[] = Object.freeze(([
  { name: 'viva-tasks', dir: 'plugins/tasks', contract: 'tasks', config: () => ({}) },
  { name: 'viva-history', dir: 'plugins/history', contract: 'history', config: () => ({}) },
  { name: 'viva-routing', dir: 'plugins/routing', contract: 'stream', config: () => ({ ...ROUTING_PERSONA }) },
  { name: 'viva-memory', dir: 'plugins/memory', contract: 'memory', config: ({ userData, memory }) => ({ host: true, dataRoot: path.join(userData, 'memory'), diagnosticsRoot: path.join(userData, 'diagnostics'), diagnosticsVersion: appPackage.version, ...memory }) },
  { name: 'viva-trace', dir: 'plugins/trace', contract: 'trace', config: ({ userData }) => ({ file: path.join(userData, 'trace.db') }) },
  {
    name: 'viva-questions', dir: 'plugins/questions', contract: 'questions', config: () => ({}),
    stock: [{ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' }],
  },
  { name: 'viva-config', dir: 'plugins/config', contract: 'config', config: () => ({}) },
  { name: 'viva-steer', dir: 'plugins/steer', contract: 'steer', config: () => ({}) },
  { name: 'viva-fork', dir: 'plugins/fork', contract: 'fork', config: () => ({}) },
  { name: 'viva-plugins', dir: 'plugins/plugins', contract: 'plugins', config: () => ({}) },
  // The user's MCP servers, connected once for the whole dsh by its manager (plugins/mcp); the manager's row with it.
  { name: 'viva-mcp', dir: 'plugins/mcp', contract: 'mcp', config: () => ({}), stock: [{ id: 'mcp-manager', name: '@deepseek-ai/dsh-mcp-manager' }] },
  {
    name: 'viva-permission', dir: 'plugins/permission', contract: 'permission',
    config: ({ permission }) => ({ preset: permission ?? DEFAULT_PERMISSION }),
    // 自动 is dsh's experimental Auto review; it reviews only sessions set to it.
    stock: [{ id: 'auto-review', name: '@deepseek-ai/dsh-experimental-auto-review' }],
  },
] satisfies AppPlugin[]))

/** The dsh version installed with the app; plugins pin their dsh peers to it. */
export function installedDshVersion(appRoot: string): string {
  const manifest = path.join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  return JSON.parse(fs.readFileSync(manifest, 'utf8')).version
}

/** dsh refuses a plugin whose exact dsh peers differ from its own version; say so before it does. */
function peerProblem(peers: Record<string, string> | undefined, dshVersion: string): string | null {
  const pinned = Object.entries(peers ?? {}).filter(([name, range]) => name.startsWith('@deepseek-ai/dsh') && /^\d/.test(range))
  const stale = pinned.find(([, range]) => range !== dshVersion)
  return stale ? t("main.app-plugins.requires.dsh.current.version.is", { value1: stale[1], dshVersion: dshVersion }) : null
}

/** Why the plugin can't be used, or null when it can. */
export function pluginProblem(plugin: Pick<AppPlugin, 'name' | 'contract'>, { dir, dshVersion }: { dir: string, dshVersion: string }): string | null {
  let manifest: any
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return t("main.app-plugins.plugin.missing.or.its.package.json.cannot")
  }
  if (manifest.name !== plugin.name) return t("main.app-plugins.plugin.name.is.expected", { name: manifest.name, name2: plugin.name })
  const provided = manifest.viva?.contract?.[plugin.contract]
  if (provided !== CONTRACTS[plugin.contract]) {
    return t("main.app-plugins.contract.version.is.this.app.requires", { contract: plugin.contract, value2: provided ?? t("main.app-plugins.not.declared"), value3: CONTRACTS[plugin.contract] })
  }
  return peerProblem(manifest.peerDependencies, dshVersion)
}

/** A plugin that passed, as dsh-profile.js writes it into the profile. */
export interface UsablePlugin { name: string, dir: string, config: PluginConfig, stock: StockEntry[] }

/**
 * The plugins to put in the profile, with their config, and the ones left out with the reason.
 * codeRoot: the folder with the app's plugins/ (config.ts CODE_ROOT); dshVersion: the dsh installed in the project.
 */
export function resolvePlugins({ codeRoot, userData, dshVersion, permission = DEFAULT_PERMISSION, plugins = APP_PLUGINS, memory }: {
  codeRoot: string, userData: string, dshVersion: string, permission?: string, plugins?: readonly AppPlugin[], memory?: { modelRoot: string, runtimeRoot: string, dailyNotes: boolean },
}): { plugins: UsablePlugin[], problems: Array<{ name: string, contract: string, problem: string }> } {
  return plugins.reduce(({ plugins: usable, problems }, plugin) => {
    const dir = path.join(codeRoot, plugin.dir)
    const problem = pluginProblem(plugin, { dir, dshVersion })
    return problem
      ? { plugins: usable, problems: [...problems, { name: plugin.name, contract: plugin.contract, problem }] }
      : { plugins: [...usable, { name: plugin.name, dir, config: plugin.config({ userData, permission, memory }), stock: plugin.stock ?? [] }], problems }
  }, { plugins: [] as UsablePlugin[], problems: [] as Array<{ name: string, contract: string, problem: string }> })
}
