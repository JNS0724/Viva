/** Unified LLM-as-a-Judge aligned verbatim with ReMe plugins/lme-judge/src/judge_lme/llm_judge.yaml. */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEEPSEEK_DEFAULT } from '../../src/backend/model-providers.ts'
import { memorySource } from '../../plugins/memory/lib/source.ts'

const TEMPORAL_PROMPT = [
  'I will give you a question, a correct answer, and a response from a model. Please answer',
  'yes if the response contains the correct answer. Otherwise, answer no. If the response is',
  'equivalent to the correct answer or contains all the intermediate steps to get the correct',
  'answer, you should also answer yes. If the response only contains a subset of the information',
  'required by the answer, answer no. In addition, do not penalize off-by-one errors for the',
  'number of days. If the question asks for the number of days/weeks/months, etc., and the',
  'model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model\'s',
  'response is still correct.',
  'Only output one lowercase word: yes or no.',
].join('\n')

const KNOWLEDGE_UPDATE_PROMPT = [
  'I will give you a question, a correct answer, and a response from a model. Please answer',
  'yes if the response contains the correct answer. Otherwise, answer no. If the response',
  'contains some previous information along with an updated answer, the response should be',
  'considered as correct as long as the updated answer is the required answer.',
  'Only output one lowercase word: yes or no.',
].join('\n')

const PREFERENCE_PROMPT = [
  'I will give you a question, a rubric for desired personalized response, and a response from a',
  'model. Please answer yes if the response satisfies the desired response. Otherwise, answer',
  'no. The model does not need to reflect all the points in the rubric. The response is correct',
  'as long as it recalls and utilizes the user\'s personal information correctly.',
  'Only output one lowercase word: yes or no.',
].join('\n')

const OTHER_PROMPT = [
  'I will give you a question, a correct answer, and a response from a model. Please answer',
  'yes if the response contains the correct answer. Otherwise, answer no. If the response',
  'is equivalent to the correct answer or contains all the intermediate steps to get the correct',
  'answer, you should also answer yes. If the response only contains a subset of the information',
  'required by the answer, answer no.',
  'Only output one lowercase word: yes or no.',
].join('\n')

const ABSTENTION_PROMPT = [
  'I will give you an unanswerable question, an explanation, and a response from a model.',
  'Please answer yes if the model correctly identifies the question as unanswerable (e.g. says',
  'information not found, does not know, or was not mentioned). The model could also ask the',
  'user for clarification or state it cannot answer based on memory. Otherwise, answer no.',
  'Only output one lowercase word: yes or no.',
].join('\n')

const CHINESE_SEMANTIC_PROMPT = [
  '你是一名严格的记忆系统评测裁判。我会提供：用户提问、必须满足的语义要点清单、严禁出现的错误断言清单，以及待测系统的实际回答。',
  '判定规则：',
  '1. 所有 required 要点必须在回答中准确体现（包括归属主体、否定极性、生效时间、前置条件与例外，允许等价中文改写）。',
  '2. 回答不得包含任何 forbidden 错误断言（例如把第三方引文当成本人事实、把旧值当成现状、遗漏法务冻结或安全优先例外）。',
  '3. 若满足全部 required 且无 forbidden 违规，输出 JSON {"verdict":"yes","reason":"简短理由"}；否则输出 {"verdict":"no","reason":"具体缺失或违规点"}。',
  '仅输出合法 JSON，不要输出其他内容。',
].join('\n')

export function lmeJudgePrompt(questionType: string, isAbstention: boolean): { system: string, userTemplate: 'preference' | 'standard' } {
  if (isAbstention) return { system: ABSTENTION_PROMPT, userTemplate: 'standard' }
  if (questionType === 'temporal-reasoning') return { system: TEMPORAL_PROMPT, userTemplate: 'standard' }
  if (questionType === 'knowledge-update') return { system: KNOWLEDGE_UPDATE_PROMPT, userTemplate: 'standard' }
  if (questionType === 'single-session-preference') return { system: PREFERENCE_PROMPT, userTemplate: 'preference' }
  return { system: OTHER_PROMPT, userTemplate: 'standard' }
}

async function callDeepSeekText(ctx: Pick<Context, 'llm'>, system: string, user: string, signal?: AbortSignal): Promise<string> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({
    provider: DEEPSEEK_DEFAULT.provider,
    model: DEEPSEEK_DEFAULT.model,
    system,
    messages: [createUserMessage({ content: [{ type: 'text', text: user }], source: memorySource })],
    maxTokens: 2048,
    signal: signal ?? AbortSignal.timeout(60_000),
  })) {
    assembler.push(chunk)
  }
  return assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()
}

export async function judgeLmeAnswer(
  ctx: Pick<Context, 'llm'>,
  input: { question: string, groundTruth: string, answer: string, questionType: string, isAbstention: boolean },
): Promise<{ verdict: 'yes' | 'no' | 'error', reason: string }> {
  const { system, userTemplate } = lmeJudgePrompt(input.questionType, input.isAbstention)
  const user = userTemplate === 'preference'
    ? `Question: ${input.question}\nRubric for desired personalized response: ${input.groundTruth}\nResponse from a model: ${input.answer}`
    : `Question: ${input.question}\nCorrect answer: ${input.groundTruth}\nResponse from a model: ${input.answer}`
  try {
    const raw = await callDeepSeekText(ctx, system, user)
    const normalized = raw.toLowerCase().replace(/[^a-z]/g, '')
    if (normalized === 'yes' || normalized.startsWith('yes')) return { verdict: 'yes', reason: '' }
    if (normalized === 'no' || normalized.startsWith('no')) return { verdict: 'no', reason: '' }
    return { verdict: 'error', reason: raw }
  } catch (error) {
    return { verdict: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function judgeChineseSemanticAnswer(
  ctx: Pick<Context, 'llm'>,
  input: {
    question: string
    requiredSemantics: readonly string[]
    forbiddenSemantics: readonly string[]
    answer: string
  },
): Promise<{ verdict: 'yes' | 'no' | 'error', reason: string }> {
  const user = JSON.stringify({
    question: input.question,
    required: input.requiredSemantics,
    forbidden: input.forbiddenSemantics,
    modelAnswer: input.answer,
  }, null, 2)
  try {
    const raw = await callDeepSeekText(ctx, CHINESE_SEMANTIC_PROMPT, user)
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    const parsed = JSON.parse(cleaned) as { verdict?: string, reason?: string }
    const v = parsed.verdict?.toLowerCase()
    if (v === 'yes' || v === 'no') return { verdict: v, reason: String(parsed.reason ?? '') }
    return { verdict: 'error', reason: raw }
  } catch (error) {
    return { verdict: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
}
