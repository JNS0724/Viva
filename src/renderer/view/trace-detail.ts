import { t } from '../../shared/i18n/translate.ts'
import { formatElapsed, traceItems } from '../selectors.ts'
import { objectOf } from '../../shared/unknown-value.ts'
import type { ModelCallSummary } from '../../shared/trace.ts'
import { h } from './dom.ts'
import { icon } from './icons.ts'

export type TraceItem = ReturnType<typeof traceItems>[number]
type DetailState = NonNullable<State['traceDetail']>
export type DetailHandlers = {
  closeTraceDetail: () => void
  openTraceDetail: (item: TraceItem) => void
  copyTraceText: (text: string) => Promise<void> | void
  closeDrawer: () => void
}

const DIMENSION = {
  model: 'trace.dimension.model', thought: 'trace.dimension.model', tool: 'trace.dimension.tool', memory: 'trace.dimension.context',
  permission: 'trace.dimension.request', question: 'trace.dimension.request', secret: 'trace.dimension.request',
  decision: 'trace.dimension.result', answer: 'trace.dimension.result', secret_answer: 'trace.dimension.result',
} as const
const STATUS = { running: 'trace.status.running', completed: 'trace.status.completed', failed: 'trace.status.failed' } as const
type StatusKey = (typeof STATUS)[keyof typeof STATUS] | 'trace.status.waiting'

function json(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value ?? null, null, 2) } catch { return t('trace.no.details') }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(part => {
    const item = objectOf(part)
    if (item && typeof item.text === 'string') return item.text
    const content = objectOf(item?.content)
    if (content && typeof content.text === 'string') return content.text
    return json(part)
  }).filter(Boolean).join('\n\n')
  const item = objectOf(value)
  if (item && Array.isArray(item.content)) return contentText(item.content)
  return json(value)
}

function statusOf(item: TraceItem, model: ModelCallSummary | null): { key: StatusKey, tone: string } {
  if (model) return { key: STATUS[model.status], tone: model.status === 'failed' ? 'error' : model.status === 'running' ? 'working' : 'done' }
  if (item.entry.kind === 'permission' || item.entry.kind === 'question' || item.entry.kind === 'secret') return { key: item.tone === 'waiting' ? 'trace.status.waiting' : 'trace.status.completed', tone: item.tone }
  if (item.entry.kind === 'tool' && (item.tone === 'working' || item.tone === 'pending')) return { key: 'trace.status.running', tone: item.tone }
  if (item.entry.kind === 'tool' && item.tone === 'error') return { key: 'trace.status.failed', tone: 'error' }
  return { key: 'trace.status.completed', tone: item.tone }
}

function section(title: string, body: unknown, meta = '') {
  return h('section', { class: 'trace-detail-section' },
    h('div', { class: 'trace-section-head' }, h('b', { text: title }), meta ? h('span', { text: meta }) : null),
    typeof body === 'string' ? h('pre', { class: 'trace-longtext', text: body }) : body)
}

function relatedItem(state: State, item: TraceItem, kinds: readonly string[]): TraceItem | null {
  const rows = traceItems(state)
  const index = rows.findIndex(row => row.key === item.key)
  if (index < 0) return null
  return rows.slice(0, index).reverse().find(row => kinds.includes(row.entry.kind) && row.entry.ref === item.entry.ref)
    ?? rows.slice(0, index).reverse().find(row => kinds.includes(row.entry.kind)) ?? null
}

function relatedButton(state: State, item: TraceItem, kinds: readonly string[], text: string, handlers: DetailHandlers) {
  const related = relatedItem(state, item, kinds)
  return related ? h('button', { class: 'btn-text trace-related', type: 'button', text, onClick: () => handlers.openTraceDetail(related) }) : null
}

function roleLabel(role: string): string {
  if (role === 'system') return t('trace.role.system')
  if (role === 'developer') return t('trace.role.developer')
  if (role === 'assistant') return t('trace.role.assistant')
  if (role === 'tool') return t('trace.role.tool')
  return t('trace.role.user')
}

function modelBody(detail: DetailState): HTMLElement[] {
  if (detail.loading) return [h('div', { class: 'empty', role: 'status', text: t('trace.loading') })]
  if (detail.error || !detail.request?.request) return [h('div', { class: 'empty', text: detail.error && detail.error !== 'unavailable' ? detail.error : t('trace.unavailable') })]
  const request = detail.request.request
  return [h('div', { class: 'trace-model-overview' },
    h('span', { text: t('trace.model.request') }),
    h('b', { text: `${t('trace.message.count', { count: request.messages.length })} · ${t('trace.tool.count', { count: request.tools.length })}` })),
    ...request.messages.map((raw: unknown, index: number) => {
    const message = objectOf(raw)
    const role = String(message?.role ?? 'user')
    return h('section', { class: 'trace-message' },
      h('div', { class: 'trace-message-head' },
        h('span', { class: 'trace-role', 'data-role': role, text: roleLabel(role) }),
        h('span', { class: 'trace-message-index', text: `${String(index + 1).padStart(2, '0')} · ${role}` })),
      h('pre', { class: 'trace-longtext', text: contentText(message?.content) }))
  })]
}

function genericBody(state: State, item: TraceItem, handlers: DetailHandlers): Array<HTMLElement | null> {
  const entry = item.entry
  if (entry.kind === 'model') return []
  if (entry.kind === 'thought') {
    const thought = state.thoughts.find(row => row.id === entry.ref)
    return [section(t('trace.full.thought'), thought?.text ?? ''), relatedButton(state, item, ['model'], t('trace.related.model'), handlers)]
  }
  if (entry.kind === 'tool') {
    const tool = state.tools[entry.ref]
    if (!tool) return []
    const output = contentText(tool.rawOutput)
    return [section(t('trace.tool.input'), json(tool.rawInput), String(tool.kind ?? '')),
      section(t('trace.tool.output'), output || t('trace.tool.no.output'), tool.status ?? ''),
      tool.locations?.length ? section(t('trace.tool.files'), tool.locations.map(location => h('div', { class: 'trace-file-row', text: location.path }))) : null]
  }
  if (entry.kind === 'memory') {
    const injection = entry.injection
    return [section(t('trace.memory.reason'), injection.fixed ? t('selectors.profile.preferences.and.memory.rules.session.start') : t('selectors.updated.profile.and.preferences')),
      injection.fixed ? section(t('trace.memory.profile'), injection.fixed) : null,
      section(t('trace.memory.recalled'), injection.pushed?.length
        ? injection.pushed.map(memory => h('article', { class: 'trace-memory-card' }, h('b', { text: memory.names.join('、') }), h('p', { text: memory.text })))
        : h('div', { class: 'empty', text: t('trace.memory.none') }))]
  }
  if (entry.kind === 'permission') {
    return [section(t('trace.request'), entry.title), section(t('trace.request.scope'), json(entry.request?.rawInput)),
      relatedButton(state, item, ['decision'], t('trace.result.view.result'), handlers)]
  }
  if (entry.kind === 'question') {
    return [section(t('trace.request'), entry.questions?.map(question => h('article', { class: 'trace-question' },
      h('b', { text: question.header ?? question.question }),
      question.header ? h('p', { text: question.question }) : null,
      question.options.length ? h('ul', {}, question.options.map(option => h('li', { text: option.description ? `${option.label} · ${option.description}` : option.label }))) : null)) ?? entry.title),
      relatedButton(state, item, ['answer'], t('trace.result.view.result'), handlers)]
  }
  if (entry.kind === 'secret') {
    return [section(t('trace.request'), `${entry.server ?? ''}\n${(entry.names ?? []).join('\n')}`),
      h('div', { class: 'trace-privacy-note', text: t('trace.credentials.protected') }),
      relatedButton(state, item, ['secret_answer'], t('trace.result.view.result'), handlers)]
  }
  if (entry.kind === 'decision') {
    return [section(t('trace.result.choice'), entry.choice), section(t('trace.request.original'), entry.title),
      relatedButton(state, item, ['permission'], t('trace.result.view.request'), handlers)]
  }
  if (entry.kind === 'answer') {
    return [section(t('trace.result.answer'), entry.answered ? entry.title : t('trace.result.unanswered')),
      relatedButton(state, item, ['question'], t('trace.result.view.request'), handlers)]
  }
  return [section(t('trace.result.credentials'), entry.provided ? t('selectors.credentials.provided') : t('selectors.no.credentials.provided')),
    h('div', { class: 'trace-privacy-note', text: t('trace.credentials.protected') }),
    relatedButton(state, item, ['secret'], t('trace.result.view.request'), handlers)]
}

function rawDetail(item: TraceItem, state: State, detail: DetailState): unknown {
  const entry = item.entry
  if (entry.kind === 'model') return detail.request?.request ?? { error: detail.error ?? 'unavailable' }
  if (entry.kind === 'tool') {
    const tool = state.tools[entry.ref]
    return { kind: entry.kind, id: entry.ref, title: tool?.title, status: tool?.status, input: tool?.rawInput, output: tool?.rawOutput }
  }
  if (entry.kind === 'thought') return { kind: entry.kind, at: entry.at, text: state.thoughts.find(row => row.id === entry.ref)?.text ?? '' }
  if (entry.kind === 'secret_answer') return { kind: entry.kind, at: entry.at, provided: entry.provided }
  if (entry.kind === 'secret') return { kind: entry.kind, at: entry.at, server: entry.server, names: entry.names }
  return entry
}

export function renderTraceDetail(state: State, item: TraceItem, handlers: DetailHandlers): HTMLElement {
  const detail = state.traceDetail!
  const entry = item.entry
  const model = entry.kind === 'model' ? state.modelCalls[entry.ref] : null
  const title = model ? `${t('selectors.model.call')} ${model.step}` : item.title
  const status = statusOf(item, model)
  const structured = h('div', { class: 'trace-structured' })
  const raw = h('pre', { class: 'trace-raw trace-longtext', hidden: true, text: json(rawDetail(item, state, detail)) })
  const content = model ? modelBody(detail) : genericBody(state, item, handlers)
  structured.append(...content.filter((node): node is HTMLElement => Boolean(node)))
  const body = h('div', { class: 'trace-detail-body', tabindex: 0, 'aria-label': t('trace.details') }, structured, raw)
  const root = h('section', { class: 'trace-detail-view', 'data-view': 'structured', 'aria-label': title },
    h('div', { class: 'trace-detail-head' },
      h('button', { class: 'icon-btn trace-back', type: 'button', 'aria-label': t('trace.back'), onClick: () => handlers.closeTraceDetail() }, icon('back', 16)),
      h('div', { class: 'trace-detail-heading' },
        h('span', { class: 'trace-dimension', text: t(DIMENSION[entry.kind]) }),
        h('b', { text: title }),
        h('span', { text: `${item.time}${model ? ` · ${t('trace.call.position', { value: model.step })}` : ''}` })),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('drawer.close.panel'), onClick: () => handlers.closeDrawer() }, icon('close', 16))),
    h('div', { class: 'trace-detail-meta' },
      h('span', { class: 'chip', text: model?.model || entry.kind }),
      model?.attempts && model.attempts > 1 ? h('span', { text: t('trace.attempts', { count: model.attempts }) }) : null,
      model?.durationMs !== null && model ? h('span', { text: t('trace.duration', { value: formatElapsed(model.durationMs) }) }) : null,
      h('span', { class: 'trace-detail-status', 'data-tone': status.tone, text: t(status.key) })),
    h('div', { class: 'trace-detail-tools' },
      h('div', { class: 'seg' },
        h('button', { type: 'button', 'aria-pressed': 'true', 'data-detail-tab': 'structured', text: model ? t('trace.prompt') : t('trace.details') }),
        h('button', { type: 'button', 'aria-pressed': 'false', 'data-detail-tab': 'json', text: t('trace.raw.json') })),
      h('span', { class: 'trace-local', role: 'img', 'aria-label': t('trace.copy.local.only'), title: t('trace.copy.local.only') }, icon('lock', 16)),
      h('button', { class: 'btn-text trace-copy', type: 'button', text: model ? t('trace.copy.prompt') : t('trace.copy.details') })),
    body,
    model ? h('div', { class: 'trace-detail-privacy', text: t('trace.privacy') }) : null)
  const copy = root.querySelector<HTMLButtonElement>('.trace-copy')!
  copy.addEventListener('click', () => {
    void handlers.copyTraceText(root.dataset.view === 'json' ? raw.textContent ?? '' : structured.innerText)
    copy.classList.add('copied')
    setTimeout(() => copy.classList.remove('copied'), 1600)
  })
  root.querySelectorAll<HTMLButtonElement>('[data-detail-tab]').forEach(button => button.addEventListener('click', () => {
    const view = button.dataset.detailTab!
    root.dataset.view = view
    structured.hidden = view === 'json'
    raw.hidden = view !== 'json'
    root.querySelectorAll<HTMLButtonElement>('[data-detail-tab]').forEach(peer => peer.setAttribute('aria-pressed', String(peer === button)))
    copy.textContent = view === 'json' ? t('trace.copy.json') : model ? t('trace.copy.prompt') : t('trace.copy.details')
    body.scrollTop = 0
  }))
  return root
}
