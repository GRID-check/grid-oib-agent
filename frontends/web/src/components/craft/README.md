# Craft kit

The tactile layer of the drawing-set metaphor. The riso plates are the site's
main picture language; this kit is only what serves them, plus one stamp and
one pencil line. Pure CSS, SVG and plain `<img>`: no dependencies, no fonts.

| Piece | What it is | Used on |
|---|---|---|
| `TapedPrint.astro` | A print on a white paper margin, one strip of tape, a little off square (clamped to ±2°), optional mono caption. Takes a riso print by art id (with `locale`, its declared alt text and caption), or any slot (a photo, a blog cover). | Team (plate I, founder photos), blog posts (cover, or the plate `POST_PLATES` assigns: II on "Wie Piloti funktioniert") |
| `plates.ts` | The Tafeln plates by number → their art id, and which blog posts wear one. File names live only in `src/data/art.json`. | wherever a plate is shown |
| `Tape.astro` | The strip of masking tape: translucent crepe with a torn zigzag at both ends. | inside TapedPrint only |
| `Stamp.astro` | A rubber stamp in olive ink with uneven coverage, optionally "thudding" in once (260 ms). Decorative, `aria-hidden`. | Kontakt: "Pilotphase" |
| `PencilUnderline.astro` | A two-stroke hand-drawn line under a few words, drawn in once (300 ms). | Kontakt: under "Pilotbüro" |
| `craft-in.ts` | Marks a `[data-craft-in]` element `craft-in` when it scrolls into view; Stamp and PencilUnderline animate off that class. | imported by those two |

## Plates

Prints come from the riso works in `art/riso/` and reach a page only by art id
through `src/data/art.json` (`src/lib/art.ts`); the file names and their
`?v=` hashes live there. They are screened bitmaps, so they are never
resampled by an odd factor (that is what makes moiré):

- `size="full"`: the print's own CSS size (720 px for a plate), the 2x file on
  2x screens.
- `size="half"` / `"third"`: 1/2 or 1/3 of it, the 1x file.
- On a phone narrower than the print, `max-width: 100%`, and nothing else.

An unknown id fails `astro check` (`ArtId` is the manifest's keys) and
`npm run check`. How to make, export and place a new print: the
`aiq-piloti-riso` skill and `art/riso/README.md`.

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
