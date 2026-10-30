import type { BlockAssembler } from '@deepseek-ai/dsh-llm'

/** Drafts can use partial text; structured judgments must finish before any messages are marked judged. */
export function preparationText(assembler: Pick<BlockAssembler, 'finish' | 'blocks'>, requireComplete = false): string {
  const finish = assembler.finish?.kind
  if (finish !== 'stop' && finish !== 'max-tokens') throw new Error(`模型停在了 ${finish ?? '中途'}`)
  if (requireComplete && finish === 'max-tokens') throw new Error('模型判断达到生成上限，消息保留待重试')
  const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim()
  if (!text && finish === 'max-tokens') throw new Error('模型在输出正文前已用完生成额度')
  return text
}
