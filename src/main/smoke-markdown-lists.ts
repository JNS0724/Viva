import { run, type SmokeWindow } from './smoke-kit.ts'

/** The real page DOM: list text and inline semantics survive without an extra wrapper around each item. */
export async function checkMarkdownLists(win: SmokeWindow): Promise<string[]> {
  const seen = await run(win, `(async () => {
    const { renderMarkdown, caretHost } = await import('./view/markdown.js')
    const inputs = [
      '- **重点** 和 \u0060code\u0060 [链接](https://example.com/)\\n- 下一项',
      '- 父项\\n  1. 子项一\\n  2. 子项二',
      '- 第一段\\n\\n  第二段\\n\\n- 末项',
      '- [x] done\\n- [ ] todo',
    ]
    return inputs.map(text => {
      const root = renderMarkdown(text, { openLink: () => {} }), host = caretHost(root)
      host.append(document.createTextNode('▏'))
      return { text: root.textContent, host: host.tagName, tail: host.textContent, strong: root.querySelector('strong')?.textContent ?? null,
        code: root.querySelector('code')?.textContent ?? null, href: root.querySelector('a')?.href ?? null,
        nested: root.querySelectorAll('ul > li > ol > li').length, paragraphs: root.querySelectorAll('li > p').length,
        tasks: [...root.querySelectorAll('input')].map(input => input.checked) }
    })
  })()`) as Array<{ text: string, host: string, tail: string, strong: string | null, code: string | null, href: string | null, nested: number, paragraphs: number, tasks: boolean[] }>
  const failures: string[] = []
  const check = (ok: boolean, label: string) => { if (!ok) failures.push(`Markdown list: ${label}: ${JSON.stringify(seen)}`) }
  check(seen[0]?.text === '重点 和 code 链接下一项▏' && seen[0].host === 'LI' && seen[0].tail === '下一项▏', 'inline list and caret')
  check(seen[0]?.strong === '重点' && seen[0].code === 'code' && seen[0].href === 'https://example.com/', 'inline semantics')
  check(seen[1]?.nested === 2 && seen[1].tail === '子项二▏', 'nested list caret')
  check(seen[2]?.paragraphs === 3 && seen[2].host === 'P' && seen[2].tail === '末项▏', 'loose list paragraphs')
  check(JSON.stringify(seen[3]?.tasks) === '[true,false]' && seen[3].tail === 'todo▏', 'task list and caret')
  return failures
}
