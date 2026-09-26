# Craft kit

The tactile layer of the drawing-set metaphor. The riso plates are the site's
main picture language; this kit is only what serves them. Pure CSS, SVG and
plain `<img>`: no dependencies, no fonts.

| Piece | What it is | Used on |
|---|---|---|
| `TapedPrint.astro` | A print on a white paper margin, one strip of tape, optional mono caption. Takes a riso print by art id (with `locale`, its declared alt text), or any slot (a photo, a blog cover). A plate hangs straight; only a slot leans (clamped to ±2°). `phone="third"` shows a plate at a third below `sm`. | Every landing section's plate (below), founder photos, the 404, blog covers (`COVER_PLATES`) |
| `plates.ts` | The Tafeln plates by number → their art id, and which blog posts wear one. File names live only in `src/data/art.json`. | wherever a plate is shown |
| `Tape.astro` | The strip of masking tape: translucent crepe with a torn zigzag at both ends. | inside TapedPrint only |
| `craft-in.ts` | Marks a `[data-craft-in]` element `craft-in` when it scrolls into view; a mark drawn on the sheet animates off that class. | The Prüfblatt's ticks (Quellen) |

A stamp ("Pilotphase") and a pencil underline were built for Kontakt and cut
when plate VIII took that section: one object per section. They are in the
repository's history if a section without a plate ever needs one.

## Plates

One plate per section, and no plate twice on a page. The landing page:

| Section | Plate | Desktop | Phone |
|---|---|---|---|
| 03 Nutzung | VI Zeichentisch | third, above the tag, still | hidden: the stories are the picture |
| 04 Quellen und Daten | II Schichten | half, beside the claim, still | third, above the tag |
| 05 Wert | VII Waage | third, above the tag | hidden: the calculator comes first |
| 06 Team | I Drei Stützen | half, beside the intro | third, above the tag |
| 08 Kontakt | VIII Offene Tür | half, beside the invitation | third, above the tag |

`still` where the section already has its moment (the chain, the ticks).
Plate IV Bauplatz is the 404's; V Prüfstand and III Schleife are for the blog.
Captions are `ui.plates`, not the manifest's, which are set with an em dash.

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

- One tactile object per section at most, and that is its plate.
- Nothing that carries text people must read is rotated more than 2°.
- Motion is short (the `quick` and `base` tokens of
  [the motion system](../../../../../docs/ux/motion.md)), happens once, and not at all under
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
