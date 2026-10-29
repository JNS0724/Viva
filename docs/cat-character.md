# Viva cat character

[English](cat-character.md) · [简体中文](cat-character.zh-CN.md)

The app has two separate compositions. Head close-ups appear on the home page (64 px above the greeting), conversation avatars, title-bar island, and desktop island. Busts are currently reserved for larger future scenes. Before adding assets, check these rules and compare silhouette, expression, and alignment against the same circular background.

## Identity

- Warm charcoal-black fur, clear geometric silhouettes, restrained shading. No white chest/belly patch or decorative collar/strap lines.
- Large, elongated almond eyes, amber-gold irises, black pupils, and cream highlights.
- Small triangular nose; muted terracotta-pink nose and inner ears.
- Facing the viewer, the right ear has a small folded notch and the left front paw is cream-white; the other paws are charcoal. Preserve the same physical ear and paw when turning, rather than mirroring.
- A broad, slightly wedge-shaped head and tall triangular ears; busts keep a short chest and a recognizably large face.
- Cream captain’s cap with an ocean-blue band, short brim, and small gold compass emblem. Place it between the ears, exposing the notched ear and eyebrows.
- Flat geometric 2D picture-book illustration: clean color areas and restrained warm outlines; no paper texture, speckles, or fine fur lines.

## Assets

`src/assets/cat/bust/` contains two compositions per state:

- Seven 512×512 busts such as `idle.png`. Typing combines `typing-base.png` (body with keyboard), `typing-paw-left.png`, and `typing-paw-right.png`.
- Seven 256×256 close-ups such as `idle-head.png`, with only hat, ears, and face; the face occupies over 70% of the image.
- Reserved `sleeping.png` / `sleeping-head.png`; see History below.

All are transparent PNGs scaled proportionally from 1024×1024 originals, without background or white fringe. Head images support up to 128 px on a 2× display. Designers retain originals, generation prompts, and process drafts outside the repository.

### Composition

Align all seven bust silhouettes to idle, and all seven heads to each other, so switching states does not jump. Center the circular background; the body ends in an arc against it, with only ear tips extending beyond. The typing keyboard is deliberately wider than the head and extends outside the circle. Busts display keyboard and paws at 1.65×; heads use the same keyboard below them.

`src/renderer/view/cat.ts` overlays thinking dots, approval `!`, question `?`, and completion sparkles. The error sweat drop is painted into the image.

## States

| State | Bust | Close-up | Overlay |
|---|---|---|---|
| `idle` | Faces viewer, relaxed smile, paws below chin | Calm open eyes, smile | None |
| `thinking` | Looks up, white paw on chin | Clearly raised gaze | Three-dot bubble |
| `typing` | Alternating paws on large keyboard | Squints downward | Keyboard and paws below |
| `confirm` | White paw beside face, pad outward | Focused eyes, raised brows | `!` |
| `ask` | Folded ear, scratches head, mouth slightly open | Raised brows, open mouth | `?` |
| `done` | Smiles with eyes closed, mouth open, paws raised | Closed-eye smile | Sparkles; one at top right at small sizes |
| `error` | Slightly crooked cap, “oops” expression, white paw at chest | Wide eyes, open mouth | Painted sweat drop |

## Display

Use heads automatically at 48 px or smaller, busts above that. `drawCat` can override the variant; the 64 px home image explicitly uses a head. Only the newest answer avatar follows current activity; older answers stay still in idle. While text is being revealed, show typing.

Preload all assets when first drawing the cat to prevent empty-circle flashes. The character itself does not rotate or scale; only typing paws and overlays animate. Respect reduced-motion settings by stopping all motion. After asset changes, inspect the home page, 36 px conversation avatar, 36 px title-bar island, and desktop island while switching states repeatedly.

## History

- **2026-10-24:** introduced the geometric black cat with captain’s hat; seven aligned bust/head pairs; removed paper texture; split typing into keyboard and alternating paws; enlarged the title-bar cat from 24 to 36 px (48 px island, 56 px title bar).
- **2026-10-26:** replaced the large home bust and glow with a 64 px head above the greeting; reduced greeting text from 64 to 48 px to focus the home page on greeting and input.
- **Prepared but unused:** sleeping. `sleeping.png` (512 px) and `sleeping-head.png` (256 px) both show the whole curled-up cat with paws and tail. Small sizes scale the whole cat rather than using a head close-up. It is not wired to any state and is absent from `CAT_MOODS`. When enabled, add a cream “zzz” bubble at top right, matching the thinking bubble, floating slowly; keep it still when requested or under reduced motion.
