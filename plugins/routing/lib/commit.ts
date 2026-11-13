/**
 * The commit_route tool as the model sees it: what it is for and its parameters (docs/agent-routing-design.md §7.1).
 * What is accepted is the host's to decide (src/shared/request-routing/protocol.ts parsePlan). The wording was chosen
 * by replaying the main agent's real request on the live model (docs/agent-routing-design.md §15).
 */
import { APP_OPERATIONS, DISPOSITIONS } from '../../../src/shared/request-routing/protocol.ts'

export const COMMIT_DESCRIPTION = [
  '处理当前请求的唯一出口：每个【请求 ID】提交一次。',
  '',
  '怎么填：',
  '1. goals：用户这句话里每个目标列一项，disposition 写去向。',
  '2. actions：每个 goal 写一个对应的动作，kind 按去向取，同时填该 kind 的字段：',
  '   answer → reply（scope）',
  '   delegate → start（title、brief）',
  '   update_task → message（taskId、text）',
  '   stop_task → stop（taskId）',
  '   needs_input → clarify（question）',
  '   app_operation → app_action（operation）',
  '   每个动作单独一个对象：不要把 reply 的 scope、message 的 taskId 和 text 写进 start 里。goals 有几种去向，actions 就要有几种对应的 kind。',
  '3. 交给任务（start、message、stop）时，notice 写一句给用户看的话：交给了哪个任务、去做什么。',
  '',
  '去向怎么选：',
  '- answer：你在主会话里直接回答，用于解释和短问答。',
  '- delegate：交给新的后台任务，用于调研、联网、整理资料、写文件、跑命令。',
  '- update_task、stop_task：补充、追问、修改或停止已有任务。taskId 用【刚结束的后台任务】里的；不在那里的先用 list_background_tasks 查。',
  '- needs_input：缺少只有用户能给的信息，或几个对象同样合理、选错会白做。问题写进 question，不要用 reply 在正文里问。',
  '- app_operation：改应用自己的设置（定时任务、长期记忆、MCP、skill、消息源）。提交后下一步调用与 operation 同名的工具，一个 app_action 只调用一次，要调几次就写几个；需要确认的由卡片确认。',
  '找回旧标准、读聊天记录只是准备，不算目标。',
  '',
  '示例：用户说「整理一下今天的国际大事，顺便讲讲 G20 是什么」',
  '{"requestId":"r-…","notice":"已经交给后台整理今天的国际大事，做完告诉你",',
  ' "goals":[{"goal":"整理今天的国际大事","disposition":"delegate"},{"goal":"解释 G20 是什么","disposition":"answer"}],',
  ' "actions":[{"kind":"start","title":"整理今日国际大事","brief":"用户原话：「…」。任务：…"},{"kind":"reply","scope":"解释 G20 是什么"}]}',
  '',
  '被接受之后：有 reply、clarify、app_action 时，在下一步回答、提问或调用工具；只交给了任务时，界面显示 notice，本轮结束，任务卡片随之出现。',
].join('\n')

/** The longest notice shown for a handover. */
export const MAX_NOTICE_CHARS = 300

const text = (description: string) => ({ type: 'string' as const, description })

/*
 * dsh checks a call against these parameters before the plugin sees it, and refuses a field not declared or a
 * required one missing: each would cost the model the whole plan, brief and all, written again. So only requestId and
 * actions are required and no object is closed; the host reads what it needs, drops the rest, and lists goals left
 * out from the actions (parsePlan).
 */

export const COMMIT_PARAMETERS = {
  requestId: { type: 'string' as const, required: true as const, description: '要处理的【请求 ID】' },
  notice: text('交给任务时：交接办成后直接显示给用户的一句话，用用户的语言，不写请求 ID，例如「已经交给后台整理会议纪要，做完会告诉你」'),
  goals: { type: 'array' as const, description: '用户这句话里的每个目标，各写一个去向', items: { type: 'object' as const, additionalProperties: true, properties: {
    goal: text('一个目标，用一句话写'),
    disposition: { type: 'string' as const, enum: [...DISPOSITIONS], description: '这个目标的去向' },
  } } },
  actions: { type: 'array' as const, required: true as const, description: '与 goals 对应的动作：每种去向一个对应的 kind', items: { type: 'object' as const, additionalProperties: true, properties: {
    kind: { type: 'string' as const, enum: ['reply', 'start', 'message', 'stop', 'clarify', 'app_action'], description: '动作种类：answer→reply，delegate→start，update_task→message，stop_task→stop，needs_input→clarify，app_operation→app_action' },
    scope: text('reply：本次回答的范围'),
    title: text('start：十来个字的任务名，任务卡片的标题'),
    brief: text('start：自成一体的委托：用户原话、目标、找到的约定及来源、文件和输出要求。任务看不到这段对话。'),
    taskId: text('message、stop：后台任务 ID（【刚结束的后台任务】里有的直接用，否则先用 list_background_tasks 查）'),
    text: text('message：给任务的补充或修改'),
    question: text('clarify：问用户的问题'),
    operation: { type: 'string' as const, enum: [...APP_OPERATIONS], description: 'app_action：要调用的应用工具' },
  } } },
}
