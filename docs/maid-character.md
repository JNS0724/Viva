# Viva maid character

[English](maid-character.md) · [简体中文](maid-character.zh-CN.md)

Viva appears as a blue-haired maid, drawn from the V4.1 prop states of dsh-personal-agent. She appears on the home page, beside the conversation's current turn, on cards waiting for your approval or answer, on follow-up details, and on the desktop island. The title-bar island doesn't show her, only a dot in the state's color, because the conversation already does. Colors and component rules are in the [UI guidelines](ui-guidelines.md).

## Identifying features

- Long, curly blue hair that lightens toward the ends, with a looped strand on top.
- A white frilled maid headpiece, with a blue bow on the right side of the picture.
- Large round blue eyes, in chibi proportions: big head, small body.
- A navy maid dress with a white apron, collar and bow.
- Her state is shown by what she holds or wears (see the table), never by overlaid bubbles or symbols.

Her hair and navy dress are exactly Viva's accent and background, so the change of character needs no change to the interface palette.

## Assets

Assets live in `src/assets/maid/`:

- One still per state, `<state>.webp`, 400×400, scaled down from the 512 px originals.
- Greeting, thinking, typing, asking (also used for listening) and confirm also have an animation, `<state>-motion.webp`. Greeting is 400 px and plays once; the others are 256 px and loop.
- The original GIFs, frame sheets and generation prompts stay in the dsh-personal-agent repository, not in Viva.

The pictures come on a cream background, `#FAF7F2`, with no alpha channel. Her disc uses the same cream (`--maid-paper`), so cropping to a circle shows no square edge. This cream is hers alone; nothing else in the interface uses it.

## States

| State | Pose and prop | Animation | Ring | When |
| --- | --- | --- | --- | --- |
| `greeting` | Waving | Yes, plays once | Blue | The first time the home page shows after launch |
| `idle` | Holding a teacup | No | Quiet | Nothing is going on |
| `thinking` | Pencil to her chin, eyes up | Yes | Blue | A question arrived and writing hasn't started |
| `typing` | Square glasses, typing | Yes | Blue | Streaming an answer, running tools |
| `ask` | Hand on her headset, listening | Yes | Orange | The assistant is asking you |
| `listening` | The asking pictures | Yes | Blue | Files are held over the desktop island; nothing waits on you, so blue and no badge |
| `confirm` | Handing over a clipboard | Yes | Orange | Approval cards, the desktop island |
| `done` | Holding up a check card | No | Blue | A turn finished, something is ready |
| `error` | Checking with a wrench | No | Red | An answer failed |
| `offline` | Looking at an unplugged connector | No | Gray | No model connected yet, connecting |
| `sleeping` | Hugging a pillow | No, breathes gently | Quiet | Background preparation runs while you're idle |

Ring colors match the interface's state colors: orange waits on you, red is an error, blue is working or done.

## Display rules

Drawn by `src/renderer/view/maid.ts`:

- **Framing:** `whole` shows the whole half-body picture, used at 200 px on the home page, 96 px on cards, 72 px on the desktop island and 64 px on follow-up details. `face` zooms in 1.6× on her face, used at 48 px in the conversation.
- **Animations** appear only where she is large and in front of you: the home greeting, approval and question cards, the open desktop island, and the conversation's current turn. Everywhere else shows a still. With reduced motion turned on in the system, every place shows a still.
- **In the conversation** she appears only beside the latest answer. Earlier answers keep a 48 px gap without her, so the text above doesn't shift when she moves to a new answer. While a card waits on you she's on the card, not repeated beside the answer.
- **On the desktop island** she's a still while it's folded and moves once it opens. `!`, `?` and `✓` badges say what her props can't at small sizes.
- **On the home page** her disc has an extra faint saucer rim. This is the one bold touch in the whole interface; nothing else gets one.
- All stills are preloaded the first time she's drawn, so changing state never flashes an empty disc.
- After changing assets, check the home page, conversation, approval cards, follow-up details and desktop island, and switch through several states in a row.

## Log

- 2026-11-04: the character changed from the captain cat to the blue-haired maid. The title-bar island lost its avatar for a state-colored dot; the desktop island grew to 80 px tall with a 72 px picture; the conversation's avatar follows only the current turn. The cat's art, overlays and character notes were removed from the repository and remain in git history.
- To do: dedicated 48 px head close-ups (until then the half-body picture is zoomed and cropped); the app icon, tray icon, promo video and screenshots still show the cat.
