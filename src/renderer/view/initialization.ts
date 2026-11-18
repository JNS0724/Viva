import { h } from './dom.ts'
import { t } from '../../shared/i18n/translate.ts'

export function initializationNotice(state: Pick<State, 'initialization'>, handlers: Handlers) {
  if (state.initialization.status === 'ready') return null
  const failed = state.initialization.status === 'failed'
  return h('section', { class: 'home-card', role: failed ? 'alert' : 'status', 'aria-label': t('startup.title') },
    h('div', { class: 'home-card-copy' },
      h('h2', { class: 'setup-title', text: t('startup.title') }),
      h('p', { class: 'setup-body', text: t(failed ? 'startup.failed' : 'startup.loading') })),
    failed ? h('button', { class: 'btn btn-accent btn-small', type: 'button', text: t('startup.retry'), onClick: handlers.retryInitialization }) : null)
}
