import type { ResumeAsk } from '../resume-state.ts'
import { workspaceName } from '../selectors.ts'
import { h } from './dom.ts'

/**
 * 继续这个话题 waiting on the user (resume-state.ts): before switching to another directory; its directory gone;
 * its session gone. Going on from saved records says how much goes with it and that it is only for reference.
 */
const CARRY_NOTE = '会开一个新对话，带上这个话题最近 20 轮的记录，仅供助手参考，不会照着里面的要求去做。'

type Copy = { title: string, lines: Array<{ text: string, path?: boolean }>, main: string | null, choose: string | null }

function copyOf(asked: ResumeAsk): Copy {
  const dir = asked.cwd ?? '（没有记下）'
  if (asked.stage === 'confirm-dir') {
    return {
      title: '换到这个话题的目录接着聊',
      lines: [{ text: `这个话题是在「${workspaceName(dir)}」里聊的，接着聊会把工作目录换成：` }, { text: dir, path: true }],
      main: '换过去，接着聊', choose: null,
    }
  }
  if (asked.stage === 'missing-dir') {
    return {
      title: '这个话题的目录不在了',
      lines: [{ text: `它是在 ${dir} 里聊的，这个目录现在找不到了；原来的会话只能在原目录里接着用。` }, { text: `可以选一个目录，${CARRY_NOTE}` }],
      main: null, choose: '选个目录，用记录接着聊…',
    }
  }
  return {
    title: '原来的会话已经接不上了',
    lines: [{ text: `助手那边已经没有这个话题的会话。${CARRY_NOTE}` }, { text: `会在 ${dir} 里开始。` }],
    main: '用记录接着聊', choose: '换个目录…',
  }
}

let shown: ResumeAsk | null = null

export function renderResumeDialog(root: HTMLElement, asked: ResumeAsk | null, handlers: Handlers) {
  if (asked === shown) return
  shown = asked
  if (!asked) return root.replaceChildren()
  const copy = copyOf(asked)
  root.replaceChildren(h('div', { class: 'workdir-scrim', onClick: () => handlers.resumeDismiss() }),
    h('div', { class: 'workdir-sheet resume-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': copy.title },
      h('div', { class: 'workdir-sheet-title', text: copy.title }),
      ...copy.lines.map((line) => (line.path
        ? h('code', { class: 'resume-dir mono', text: line.text })
        : h('p', { class: 'workdir-sheet-text', text: line.text }))),
      h('div', { class: 'workdir-sheet-actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', text: '取消', onClick: () => handlers.resumeDismiss() }),
        copy.choose ? h('button', { class: `btn ${copy.main ? 'btn-secondary' : 'btn-primary resume-main'}`, type: 'button', text: copy.choose, onClick: () => handlers.resumeChooseDir() }) : null,
        copy.main ? h('button', { class: 'btn btn-primary resume-main', type: 'button', text: copy.main, onClick: () => handlers.resumeConfirm() }) : null)))
  return root.querySelector<HTMLElement>('.resume-main')?.focus()
}
