import { createScrollFollower } from './view/scroll-follow.ts'

/** Bind the main page once; views share this contract without importing the executable app entry. */
export function createPageElements(page: Document, platform: string) {
  /** A part of the page (index.html): one missing is a broken page, said at once rather than at its first use. */
  function byId(id: string): HTMLElement {
    const el = page.getElementById(id)
    if (!el) throw new Error(`index.html has no #${id}`)
    return el
  }
  /** The fields and buttons the page reads or switches, as what they are. */
  const fieldById = (id: string) => byId(id) as HTMLTextAreaElement & HTMLInputElement
  const buttonById = (id: string) => byId(id) as HTMLButtonElement
  /** The title bar makes room for the system window buttons: traffic lights on macOS, caption buttons elsewhere. */
  page.documentElement.dataset.platform = platform

  const elements = {
    turnRail: byId('turn-rail'),
    leftGrip: byId('col-grip-left'),
    rightGrip: byId('col-grip-right'),
    island: byId('island'),
    scroll: byId('scroll'),
    home: byId('home'),
    earlier: byId('earlier'),
    thread: byId('thread'),
    drawer: byId('drawer'),
    composer: byId('composer'),
    input: fieldById('composer-input'),
    /** Pictures pasted or dropped into the input, above the words (draft-images.js). */
    draftPics: byId('draft-pics'),
    sendBtn: buttonById('send-btn'),
    context: buttonById('composer-context'),
    workdirArea: page.querySelector<HTMLElement>('.workdir-area'),
    /** 本话题 · N 条 · 已用 X% by the input, and its menu (view/topic-label.js). */
    ctxArea: byId('ctx-area'),
    /** What the assistant may do without asking, by the input (view/permission-picker.js). */
    permArea: byId('perm-area'),
    workdirMenu: byId('workdir-menu'),
    workdirConfirm: byId('workdir-confirm-root'),
    rewindConfirm: byId('rewind-confirm-root'),
    resumeDialog: byId('resume-root'),
    toggleDrawer: byId('toggle-drawer'),
    settings: byId('settings-root'),
    modelArea: byId('model-area'),
    modelBtn: buttonById('model-btn'),
    modelMenu: byId('model-menu'),
    jumpLatest: byId('jump-latest'),
    historySearch: fieldById('history-search'),
    historyList: byId('history-list'),
    toast: byId('toast-root'),
    openProfile: byId('open-profile'),
    openFeed: byId('open-feed'),
    feedCount: byId('feed-count'),
    profile: byId('profile-root'),
    /** 搜索 · 关于你 · 设置, one page under the title bar (view/hub.js). */
    hub: byId('hub'),
    hubBack: byId('hub-back'),
    hubNavs: [...page.querySelectorAll<HTMLElement>('.hub-nav')],
    hubPages: [...page.querySelectorAll<HTMLElement>('.hub-page')],
    hubSearchKey: byId('hub-search-key'),
    /** 后台: every background task and the one picked (view/tasks-page.js). */
    tasksPage: byId('tasks-page'),
    feedPage: byId('feed-page'),
    main: byId('main'),
  }
  /** The page's elements, and what keeps the thread scrolled to the latest (view/scroll-follow.ts). */
  return { ...elements, follower: createScrollFollower(elements.scroll, elements.jumpLatest) }
}

export type Dom = ReturnType<typeof createPageElements>
