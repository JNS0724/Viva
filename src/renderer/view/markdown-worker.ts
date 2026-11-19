import { lexMarkdown } from './markdown-lexer.ts'

interface MarkdownWorker {
  addEventListener(type: 'message', listener: (event: MessageEvent<string>) => void): void
  postMessage(value: ReturnType<typeof lexMarkdown>): void
}

const worker = self as unknown as MarkdownWorker
worker.addEventListener('message', event => {
  worker.postMessage(lexMarkdown(event.data))
})
