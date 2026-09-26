# Craft kit

The tactile layer of the drawing-set metaphor. The riso plates are the site's
main picture language; this kit is only what serves them, plus one stamp and
one pencil line. Pure CSS, SVG and plain `<img>`: no dependencies, no fonts.

| Piece | What it is | Used on |
|---|---|---|
| `TapedPrint.astro` | A print on a white paper margin, one strip of tape, a little off square (clamped to ±2°), optional mono caption. Takes a riso plate by base name, or any slot (a photo, a blog cover). | Team (plate I, founder photos), blog posts (cover, or the plate `POST_PLATES` assigns: II on "Wie Piloti funktioniert") |
| `plates.ts` | The riso plates by number → their base name in `public/art/`, and which blog posts wear one. The one place that knows file names. | wherever a plate is shown |
| `Tape.astro` | The strip of masking tape: translucent crepe with a torn zigzag at both ends. | inside TapedPrint only |
| `Stamp.astro` | A rubber stamp in olive ink with uneven coverage, optionally "thudding" in once (260 ms). Decorative, `aria-hidden`. | Kontakt: "Pilotphase" |
| `PencilUnderline.astro` | A two-stroke hand-drawn line under a few words, drawn in once (300 ms). | Kontakt: under "Pilotbüro" |
| `craft-in.ts` | Marks a `[data-craft-in]` element `craft-in` when it scrolls into view; Stamp and PencilUnderline animate off that class. | imported by those two |

## Plates

Files come from the riso kit: `public/art/<name>-720.webp` and
`public/art/<name>-1440.webp`. They are screened bitmaps, so they are
never resampled by an odd factor (that is what makes moiré):

- `size="full"`: 720 CSS px, 1440 px file on 2x screens.
- `size="half"` / `"third"`: 360 / 240 CSS px, the 720 px file at exactly 1/2
  or 1/3.
- On a phone narrower than the print, `max-width: 100%`, and nothing else.

A plate whose file is missing is left out at build time with a warning
(`[TapedPrint] public/art/… not found`), so a missing file never ships as a
broken image. List a plate in `plates.ts` only once its file exists; renaming
one is one edit there.

Photos are not screened, so a photo goes into the slot as an `astro:assets`
`<Image>`; resizing it is fine.

## Restraint

The rule, from the person who asked for all this: playful, never overdone.

- One tactile object per section at most. A taped print is the default; a
  stamp or a pencil line only where no print competes with it.
- One stamp on the whole landing page. Whatever a stamp says, the text around
  it must already say, because it is `aria-hidden`.
- Nothing that carries text people must read is rotated more than 2°.
- Motion is short (≤ 300 ms), happens once, and not at all under
  `prefers-reduced-motion`: the object is then in its final state from the
  start, as it is when the script never runs.
- No textures on cards, no sticky notes, no pins, no dog-ears. They were tried
  and cut; the prints carry the character.
- Anything rotated or offset can overflow a phone: the containing section gets
  `overflow-x-clip`, and `document.documentElement.scrollWidth` must equal the
  viewport at 390 and 1440.

## Styling note

Scoped Astro styles are unlayered and beat every Tailwind utility, so a
component that takes layout from its caller's `class` (width, margin) puts its
own defaults in `@layer components`, as TapedPrint does.
