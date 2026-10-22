/**
 * viva_offer_background: the model says, before it starts, that a job will take long. Nothing happens in
 * dsh; the app's window sees the call (a tool call in the turn) and offers 放到后台 beside it, and the turn
 * goes on at once. Its description is what tells the model when to call it.
 */
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'

const PARAMETERS: ParameterSchemaSpec = {
  why: { type: 'string', required: true, description: '一句话说为什么要很久，会显示给用户，例如「要逐个读完 40 份文档」' },
}

export const OFFER_TOOL: Readonly<{ name: string, description: string, parameters: ParameterSchemaSpec }> = Object.freeze({
  name: 'viva_offer_background',
  description: '当你判断这件事要做很久（例如要读或改很多文件、跑很长的命令或测试、做大范围的调研，预计超过一分钟）时，'
    + '在开始动手前调用一次：Viva 的窗口会给用户一个「放到后台」按钮，用户可以让这件事在后台接着做、先去聊别的。'
    + '调用后立刻照常接着做，不要等用户回应，也不要在回答里提这个按钮。一轮最多调用一次；很快能做完的事不要调用。',
  parameters: PARAMETERS,
})

export const OFFERED = '已经告诉用户这件事要一会儿，可以放到后台；接着做，不用等。'
