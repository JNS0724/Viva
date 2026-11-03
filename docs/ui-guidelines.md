# UI guidelines

English | [简体中文](ui-guidelines.zh-CN.md)

These are the visual and interaction rules of Viva's current interface, taken from `src/renderer/styles.css`, `island.css`, `personal.css` and `src/renderer/view/` (2026-11-03, main `27de6f4`). If this page and the code disagree, the code wins and this page gets fixed. New UI follows this page. Development conventions (layers, DOM, i18n, verification) are in the "Frontend" section of [AGENTS.md](../AGENTS.md). The cat's look is in [Cat character](cat-character.md).

## Direction

The code calls it "Plan A · industrial saturated Bento · deep-sea blue":

- **Dark only.** `color-scheme: dark`. There is no light theme, and it does not follow the system setting.
- **One accent.** Blue-tinted dark surfaces with a single bright blue, `--accent`. Orange and red appear only when there is a state to show; normally you don't see them.
- **Flat and geometric.** Depth comes from surface steps and 1px borders. Only things that float (menus, tips, toasts, the open island) get shadows. No gradient backgrounds and no frosted glass: `backdrop-filter` made every repaint behind it stutter, so scrims are translucent solid colors.
- **The only warm color is the cat.** Its speech bubbles are warm paper (`--cat-bubble*`), matching its cap. Don't reuse that color elsewhere.

## Color

Everything is defined on `:root` in `styles.css`. Use only tokens. If you need a new color, add a token first and say what it is for.

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#060B16` | Window background; also the inside of fields (`.field`), one step below the card they sit on |
| `--panel` | `#0D1526` | Cards, the composer, icon buttons |
| `--panel-2` | `#111B30` | Menus, tab group backgrounds, hovered rows |
| `--raised` | `#15203A` | Small raised pieces: chips, badges, tips, toasts, code blocks |
| `--line` | `#1B2742` | Default borders and dividers |
| `--line-2` | `#263557` | One step stronger: secondary buttons, menu edges, hovered borders |
| `--ink` | `#EEF3FF` | Primary text |
| `--ink-2` | `#A3B0CC` | Secondary text, unselected controls |
| `--ink-3` | `#7686A6` | Help text, metadata, placeholders, disabled items |
| `--mute` | `#3C4A68` | The faintest marks (turn rail ticks and the like) |
| `--accent` | `#5AA9FF` | Actionable, selected, focused, done |
| `--orange` | `#FF8A3D` | **Waiting on the user**: confirmation cards, waiting tasks, a nearly full context |
| `--red` | `#FF4D5E` | Errors and destructive actions |
| `--white` | `#EEF3FF` | The send button's busy background |

Each color has one meaning, and it stays the same wherever it appears:

- **Blue = you can act / it's ready.** Main buttons, selected tabs, focus rings, `data-tone="done"`.
- **Orange = waiting on you.** The island's rim, the cat's disc, the confirmation card's edge and pulse dot, and `.btn-primary`. Use an orange button only on a card that waits for the user's decision. A page's ordinary main action is blue, `.btn-accent`.
- **Red = something went wrong.** Use it for borders, a 3px left bar, or a faint background mixed with `color-mix`. Error text is light red, `#FF9AA4`; plain `--red` text doesn't have enough contrast.

Write alpha variants with `color-mix(in srgb, var(--orange) 16%, var(--panel))`, not `rgba(90, 169, 255, .12)`.

**Known values that aren't tokens yet.** When you touch nearby code, move them into `:root`, and don't add more: error text `#FF9AA4`, dashed and outline borders `#2E3D5E`, the composer's focus border `#3A4C72`, the drawer background `#0A1120`, the island background `#070C18`, and scattered `rgba(90, 169, 255, …)` / `rgba(255, 138, 61, …)`. Syntax highlighting (`.hljs-*`) has its own palette and is a deliberate exception.

## Type

| Token | Font | Use |
| --- | --- | --- |
| `--font-sans` | Space Grotesk → Noto Sans SC → PingFang SC → Microsoft YaHei | Interface and body text |
| `--font-mono` | JetBrains Mono → SF Mono / Cascadia Mono / Consolas | Labels, paths, shortcuts, keys, code, times |
| `--font-dot` | Doto | Large dot-matrix figures, used only for the key status in settings |

Web fonts load from Google Fonts with `display=optional`: if a font can't load, the system font is used and nothing flashes. The CSP allows only fonts.googleapis.com and fonts.gstatic.com, so any new font has to come from there too.

Sizes:

| Size | Use |
| --- | --- |
| 11px | `.label`, times, shortcuts, metadata |
| 12px | Secondary notes, chips, menu annotations |
| 13px | Control text, menu items, help text, toasts |
| 14px | Body text, fields, topic titles |
| 15–16px | Buttons and the composer (the composer is 16px) |
| 22px | Card titles, questions, the home subtitle |
| 28px | Page titles, confirmation titles |
| 48px | The home greeting |

- Weights are 400 / 500 / 700. Use 600 for titles inside lists (topic names, subheadings). 800 is only for Doto.
- Line height: 1.6 for body text, 1.7 for help text, 1.2–1.3 for headings, 1 for single-line controls.
- `.label` is a small uppercase monospace label: mono 11px, weight 500, `letter-spacing: .14em`, `text-transform: uppercase`. Create it with `label()` from `view/dom.ts`.
- Half sizes such as 12.5px, 13.5px and 14.5px exist but shouldn't be added. Use the nearest whole size.

## Spacing and radius

Spacing roughly follows a 2px step. The most common `gap` values, in order, are 8, 10, 12, 6 and 4. Use 6–10px inside lists and control groups, 14–16px between blocks inside a card, and 28px between messages in the conversation.

| Radius | Use |
| --- | --- |
| 2–3px | Thin bars, ticks, progress bars |
| 6–8px | Badges, chips, small tags, `kbd` |
| 9–10px | Menu items, tabs, icon buttons, small buttons |
| 12px | Buttons and fields |
| 14px | Cards, menus, topics, code blocks |
| 16–18px | Empty states and drop zones |
| 20–22px | The composer, confirmation cards, home cards, key status |
| 999px | Pills: toasts, jump to latest, the timeline's working directory |
| 50% | Dots and avatars |

Nested corners should be concentric: inner radius = outer radius − padding. The island's cat head lines up this way (`.isl-cat` in `island.css`). `--radius-tile` (28px) is defined but not used yet.

## Layout

- **Title bar.** `--titlebar-h` is 56px and the island is `--island-h` 48px, with 4px above and below. It must match `TITLEBAR_HEIGHT` in the main process's `window-options.ts`.
- **Room for window buttons.** On macOS, `--reserve-left` keeps 84px on the left for the traffic lights. On Windows and Linux, `env(titlebar-area-width)` gives how much to leave on the right. This value is set only on `.titlebar`, so resizing the window doesn't invalidate the inherited style of every message.
- **Status capsule.** It is always centered on the whole window. When space runs out it shrinks first, so it never covers the buttons on either side.
- **Conversation column.** `--col` defaults to 760px and can be resized by dragging its edges. On the left, `--rail-lane` keeps 40px free for the turn rail; the right side is the task dock's.
- **Drawer.** `--drawer-width` is 440px. At 1100px and narrower, it floats over the conversation instead of squeezing it.
- **Breakpoints.** 720px (pages go to one column), 760px (home cards stack), 1100px (the drawer floats). The minimum window size is 880×600.
- **Layers (z-index):**

| Value | Layer |
| --- | --- |
| 1–10 | Inside a region: column grips 6, task dock 8, turn rail 9, dropdowns 10 |
| 29–30 | Menus over content and their scrims, the drawer on narrow windows |
| 32 | Hub pages (Search · About you · Settings · Background) |
| 35 | Title bar (the island unfolds over the conversation) |
| 50 | Modal dialogs, `.overlay` |
| 60 | Toasts, the working-directory sheet's scrim |
| 61 | The first-time working-directory sheet |
| 90 | The full-window hint while a folder or images are held over the window |

For a new layer, pick one of these existing levels. Don't add new numbers.

## Components

Reuse existing components before writing similar styles of your own.

- **Buttons, `.btn`.** 46px tall, 12px radius, 15px / 700. Add one role class:
  - `.btn-accent`: blue fill, a page's ordinary main action (save, connect)
  - `.btn-primary`: orange fill, the main action on a card that waits for the user's decision (allow, confirm)
  - `.btn-secondary`: transparent with a 1.5px `--line-2` border, an option beside the main action
  - `.btn-outline`: 40px with a 1px border, ordinary actions in lists and settings
  - `.btn-text`: no border, the least important action
  - Size modifiers: `.btn-small` (34px), `.btn-field` (48px, the same height as a field beside it)
  - A card has only one filled main button; the others are outlined or text buttons. See `prompt-card.ts`.
- **Icon buttons, `.icon-btn`.** 40px (36px in the title bar), 10px radius, `--panel` background. They must have an `aria-label`. The pressed state is `aria-pressed="true"`, which turns the border and icon blue.
- **Icons.** Use `icon(name, size)` from `view/icons.ts`: 24-unit viewBox, 1.9 stroke, round caps, color from `currentColor`, `aria-hidden`. Add new icons to `ICONS` in the same line style. Don't bring in an icon library.
- **Fields, `.field`.** 48px, 12px radius, `--bg` background, `--line-2` border, blue border on focus. They use the monospace font by default (keys, paths, model names); `textarea.field` and `select.field` switch to sans. Put fields side by side with `.field-row`.
- **Switches.** A native checkbox, `.switch`, with `accent-color: var(--accent)`. Make the whole row a `.pref-row` label, with the title and description in `.pref-copy`.
- **Segmented controls, `.seg`.** The selected item has `aria-pressed="true"` and becomes bold on `--raised`.
- **Tabs, `.tabs` / `.tab`.** The selected tab has `aria-selected="true"`: dark text on blue.
- **Chips and badges.** `.chip` is 28px with 12px monospace text; `.badge` is 20px with 11px text. Both sit on `--raised`.
- **Menus.** Follow `.ctx-menu`: `--panel-2` background, `--line-2` border, 14px radius, 6px padding. Items (`.ctx-item`) have a 9px radius and turn `--raised` on hover. Put an item's shortcut in `kbd` and its note in `small`.
- **Cards.** `--panel` background, `--line` border, 14px radius. A card that needs the user to act gets a 22px radius and a state-colored border: the confirmation card `.confirm` is orange, the home to-do card is blue.
- **Empty states, `.empty`.** Dashed border, 16px radius, centered 13px `--ink-3` text that says what will appear here and how to make it appear.
- **Toasts.** A pill at the bottom center, with at most one blue action. While a dialog or a hub page is open it moves to the top so it doesn't cover their buttons. Show one with `showToast`; don't build banners page by page.
- **Modal dialogs, `.overlay`.** A solid `rgba(6, 11, 22, .82)` scrim with no blur. Needs `aria-modal`; Esc closes it.
- **Errors and notices.** Under a form, use `.form-error` (light red) or `.form-notice` (blue), 13px. Help text is `.help`.

## State lives in attributes

Express state with attributes and select on them in CSS. Don't add state classes like `.is-active`:

- When an accessibility attribute says it, use that attribute: `aria-pressed`, `aria-selected`, `aria-current`, `aria-expanded`, `disabled`, `hidden`.
- For everything else, use `data-*`: `data-open`, `data-busy`, `data-status`, `data-form`, and the tone, `data-tone`.
- Existing `data-tone` values and their colors: `pending` (`--line-2`), `working`, `waiting` / `waits` (orange), `done` / `ok` (blue), `error` (red), `full` (orange, the context is nearly full), `quiet` / `off` (subdued). Fit a new state into one of these first.
- `[hidden]` is `display: none !important` everywhere, so components don't need their own hidden class.

## Shadows and motion

Elevation (only for things that float):

| Where | Shadow |
| --- | --- |
| Tips | `0 10px 28px rgba(0, 0, 0, .45)` |
| Toasts | `0 16px 40px rgba(0, 0, 0, .5)` |
| Menus, the composer | `0 20px 50px rgba(0, 0, 0, .5)` (.45 for the composer) |
| The open island | `0 24px 60px rgba(0, 0, 0, .6)` |
| Focus or drop glow | `0 0 0 3–6px` of the accent at .08–.18 opacity |

Motion:

- Hover, opacity and small moves: 0.1–0.15s. Color, border and shadow: 0.3s.
- The island resizes on a spring curve, `cubic-bezier(.3, 1.3, .5, 1)`, over 0.5s. Don't use springs anywhere else.
- Looping animation only means "in progress" or "waiting on you": pulse dots, spinners, breathing, the typing caret, the cat's moves.
- `prefers-reduced-motion: reduce` turns off all animation and transitions globally. A new looping animation still gets its own reduce rule, with a still state where one is needed (for example, breathing rests at `opacity: .8`).

## Accessibility and keyboard

- Focus rings always use `:focus-visible`: a 2px `--accent` outline at a 2px offset. Write `outline: none` only when the element draws its own focus style (turn rail ticks, column grips).
- Buttons that show only an icon must have an `aria-label`. Decorative graphics get `aria-hidden`.
- Regions whose changes screen readers should announce use `aria-live="polite"`: the conversation, the input routing hint, toasts.
- Give custom controls their full role and keyboard behavior. For example, a column grip is `role="separator"` with `tabindex="0"`: arrow keys resize, Home restores the default.
- Before handling Enter or Esc, check the input method: when `event.isComposing || event.keyCode === 229`, return immediately.
- Never turn off or weaken Chromium's accessibility tree (AX). Solve performance problems another way.

## Copy

- Every piece of interface text, including `aria-label`, `title`, placeholders, empty states and errors, goes into both the English and Chinese resources in `src/shared/i18n/messages/`. Don't put text in CSS `content`.
- In plain language, say three things: **what happened, what became of the user's work, and what to do next.** For example: "This message is too long. The limit is 20,000 characters. Shorten it and try again; your draft has been kept."
- Don't blame the user. Don't show error codes or stack traces. Avoid empty phrases like "Operation failed".
- Action buttons are verbs and match what they do ("Start again here", "Edit and resend", "Run in background").
- Brand names, tool and protocol ids, paths, user input and model output stay as they are and aren't translated.

**Known issue:** the full-window hints shown while a folder or images are held over the window (the `content` of `body.drop-folder::after` and `body.drop-images::after` in `styles.css`) are hard-coded Chinese, so they show in Chinese even in the English UI. They should come from an attribute set by script, for example `content: attr(data-drop-hint)`, with the text taken from the resources.

## Platforms

Both platforms share one interface. The only difference is the room left on either side of the title bar (see [Layout](#layout)). When you change the title bar, the island or window sizing, check both macOS and Windows, and on Windows check both 100% and 150% scaling.
