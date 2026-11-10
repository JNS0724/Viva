/**
 * The commit_route tool as the model sees it: what it is for and its parameters (docs/agent-routing-design.md §8.1).
 * What is accepted is the host's to decide (src/shared/request-routing/protocol.ts parsePlan).
 */
import { APP_OPERATIONS, DISPOSITIONS } from '../../../src/shared/request-routing/protocol.ts'

export const COMMIT_DESCRIPTION = [
  '当前请求的唯一处理出口，每个【请求 ID】都要提交一次。先把用户这句话里的每个目标列进 goals，并给出去向：',
  'answer=你在主会话里直接回答（解释、短问答）；delegate=交给新的独立任务完成（调研、整理资料、完整报告、写文件、命令）；',
  'update_task=补充或修改已有任务；stop_task=停止已有任务；needs_input=缺少只有用户能给的信息或必须由用户在多个对象中选择；',
  `app_operation=改应用自己的设置（定时任务、长期记忆、接入 MCP、skill），用 app_action 写明 operation（${APP_OPERATIONS.join('、')}），`,
  '提交后在下一步直接调用同名工具并按它的参数填写；每个 app_action 只能调用一次该工具，同一个工具要调用几次就提交几个 app_action，需要确认的由卡片确认。',
  'actions 必须与 goals 一一对应：answer→reply，delegate→start，update_task→message，stop_task→stop，needs_input→clarify，app_operation→app_action。',
  '需要用户回答才能继续时，必须提交 clarify 并把问题写进 question；不要用 reply 把问题写在正文里。',
  '找回旧标准、读历史只是准备步骤，不是目标；用户要求的交付仍要 delegate。start 的 brief 第一行只写一个简短的任务名（十来个字，任务卡片的标题就是它），从第二行起写自成一体的委托：用户原话、目标、找到的约定及来源、文件和输出要求。',
  'reply、clarify、app_action 被接受后在下一步回答、提问或调用工具；交给任务（start、message、stop）时在 notice 里写一句直接给用户看的话，',
  '说明交给了哪个任务、去做什么（用用户的语言，不写请求 ID），交接办成后界面就显示这句话并结束本轮，任务卡片随之出现。',
].join('')

/** The longest notice shown for a handover. */
export const MAX_NOTICE_CHARS = 300

const text = (description: string) => ({ type: 'string' as const, description })

export const COMMIT_PARAMETERS = {
  requestId: { type: 'string' as const, required: true as const, description: '要处理的【请求 ID】' },
  notice: text('交给任务时：交接办成后直接显示给用户的一句话，例如「已经交给后台整理会议纪要，做完会告诉你」'),
  goals: { type: 'array' as const, required: true as const, items: { type: 'object' as const, additionalProperties: false, properties: {
    goal: { type: 'string' as const, required: true as const }, disposition: { type: 'string' as const, required: true as const, enum: [...DISPOSITIONS] },
  } } },
  actions: { type: 'array' as const, required: true as const, items: { type: 'object' as const, additionalProperties: false, properties: {
    kind: { type: 'string' as const, required: true as const, enum: ['reply', 'start', 'message', 'stop', 'clarify', 'app_action'] },
    scope: text('reply：本次回答的范围'),
    brief: text('start：第一行是简短任务名（卡片标题），第二行起是自成一体的完整委托'),
    taskId: text('message/stop：后台任务 ID（先用 list_background_tasks 查）'),
    text: text('message：给任务的补充或修改'),
    question: text('clarify：问用户的问题'),
    operation: { type: 'string' as const, enum: [...APP_OPERATIONS], description: 'app_action：要调用的应用工具' },
  } } },
}
