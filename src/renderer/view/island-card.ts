import { h } from './dom.ts'
import { icon } from './icons.ts'
import type { DeskButton, DeskPart, DeskRole } from '../island-desk-card.ts'

/** The DOM of a desktop island card (view/island-dom.ts createDesktopIsland), from its plain data (island-desk-card.ts). */

/** Buttons by role, as on the thread's cards (prompt-card.ts): orange for what waits on the user, blue for the next step. */
const ROLE_CLASS: Readonly<Record<DeskRole, string>> = Object.freeze({
  primary: 'isl-btn-primary', blue: 'isl-btn-blue', secondary: 'isl-btn-secondary', text: 'isl-btn-text',
})
const HEAD_ICON = 16
const INLINE_ICON = 13
const CHOICE_ICON = 14

/** One of the head's icon buttons (↗ opens the window, × folds the card): named for assistive tech and on hover. */
export function iconButton(name: 'close' | 'external', onClick: () => void): HTMLButtonElement {
  return h('button', { type: 'button', class: 'isl-icon', onClick }, icon(name, HEAD_ICON))
}

/** Names an icon button in the language now shown. */
export function nameIcon(button: HTMLButtonElement, name: string): void {
  button.setAttribute('aria-label', name)
  button.title = name
}

/** A button below the card; one that leaves for the window carries ↗ after its words. */
export function cardButton(button: DeskButton, act: IslandAct): HTMLButtonElement {
  return h('button', { type: 'button', class: `isl-btn ${ROLE_CLASS[button.role]}${button.push ? ' isl-push' : ''}`, onClick: () => act(button.act) },
    h('span', { text: button.text }), button.external ? icon('external', INLINE_ICON) : null)
}

/** A part of the card's body; the background list is the island's own section, drawn by its owner. */
export function cardPart(part: Exclude<DeskPart, { kind: 'background' }>, act: IslandAct): HTMLElement {
  switch (part.kind) {
    case 'title': return h('div', { class: 'isl-title', text: part.text })
    case 'text': return h('p', { class: 'isl-text', 'data-clamp': part.clamp ? 'true' : null, text: part.text })
    case 'code': return h('pre', { class: 'isl-detail', text: part.text, title: part.text })
    case 'hint': return h('p', { class: 'isl-choice-hint', text: part.text })
    case 'choices': return h('div', { class: 'isl-choices' }, part.options.map(option => h('button', {
      type: 'button', class: 'isl-btn isl-btn-secondary', onClick: () => act(option.act),
    }, h('span', { text: option.text }), icon('forward', CHOICE_ICON))))
    case 'tips': return h('ul', { class: 'isl-tips' }, part.items.map(item => h('li', null,
      h('span', { class: 'isl-kbd', text: item.key }), h('span', { text: item.text }))))
  }
}
