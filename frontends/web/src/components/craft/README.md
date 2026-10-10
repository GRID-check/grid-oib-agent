# Craft kit

The tactile layer of the drawing-set metaphor. The riso plates are the site's
main picture language; this kit is only what serves them. Pure CSS, SVG and
plain `<img>`: no dependencies, no fonts.

| Piece | What it is | Used on |
|---|---|---|
| `PagePrint.astro` | A riso plate printed straight onto the page: the on-page file (inks as alpha, no paper), `mix-blend-mode: multiply`, no sheet, tape, caption or frame. `tone="dark"` reverses it onto a dark panel. `phone="third"` as TapedPrint's. The default for a plate. | Every landing section's plate but Team's (below), the subpage headings (`PageHead`), blog covers (`RisoCover`), the 404 |
| `TapedPrint.astro` | A print on a white paper margin, one strip of tape, optional mono caption. Takes a riso print by art id (with `locale`, its declared alt text), or any slot (a photo, a blog cover). A plate hangs straight; only a slot leans (clamped to ±2°). `phone="third"` shows a plate at a third below `sm`. The print keeps its paper: it is an object on the page, so at most one per page. | Team's Tragwerk II, an uploaded (photographic) blog cover |
| `plates.ts` | The Tafeln plates by number → their art id, and which blog posts wear one. File names live only in `src/data/art.json`. | wherever a plate is shown |
| `Tape.astro` | The strip of masking tape: translucent crepe with a torn zigzag at both ends. | inside TapedPrint only |
| `craft-in.ts` | Marks a `[data-craft-in]` element `craft-in` when it scrolls into view; a mark drawn on the sheet animates off that class. | The Prüfblatt's ticks (Quellen) |

A stamp ("Pilotphase") and a pencil underline were built for Kontakt and cut
when plate VIII took that section: one object per section. They are in the
repository's history if a section without a plate ever needs one.

## Plates

One plate per section, and no plate twice on a page. Two modes, and only two
(`art/riso/README.md`, "Showing a print"): **on page** (`PagePrint`), the
default, where the inks print into the page and its grid; and **taped**
(`TapedPrint`), where the print keeps its paper as an object on the page, at
most once per page. Five taped sheets in a row read as stuck on and
repetitive, and each bare paper file was a beige box on the grid: that is why
the sections moved to on page. The landing page:

| Section | Plate | Mode | Desktop | Phone |
|---|---|---|---|---|
| 03 Nutzung | VI Zeichentisch | on page | half, closing the text column beside the chain, still | hidden: the stories are the picture |
| 04 Quellen und Daten | II Schichten | on page, on the sage panel | half, beside the claim, still | third, after the source rows |
| 05 Wert | VII Waage | on page, `tone="dark"` | half, above the heading | third, after the claim |
| 06 Team | Tragwerk II Drei Säulen (three columns, three founders, one slab) | taped, the page's one taped object; the founder photos beside it are plain | half, beside the intro | third, after the intro |
| 07 FAQ | Tragwerk III Säulenordnung | on page | half, under the heading, sticky beside the questions | third, under the heading |
| 08 Kontakt | VIII Offene Tür | on page | half, beside the invitation, its bled right edge on the screen's edge | third, after the buttons, on the right edge |

On a phone the heading always comes first: a section's plate follows its
heading and text, never stands above them.

The Wert plate sits on the dark olive panel. Multiplied there, the inks
vanish into the dark; moved off the panel onto the light page above it, it
floated apart from the section it illustrates. It is reversed instead: a
negative in its own hues (`invert(1) hue-rotate(180deg)`), screened onto the
panel, so the key ink's lines are the brightest, as a light ink on dark
stock. The sage Quellen panel keeps plain multiply: the inks darken the sage
as they darken the page, and every layer still reads.

`still` where the section already has its moment (the chain, the ticks).
Tragwerk IV Ziegelpfeiler is the 404's, on page; Tafeln V Prüfstand and III
Schleife are for the blog. The Tragwerk plates are `TRAGWERK` in `plates.ts`,
the Tafeln `PLATES`.
On-page plates carry no caption; the taped Team plate keeps `ui.plates.I`
(not the manifest's caption, which is set with an em dash).

Prints come from the riso works in `art/riso/` and reach a page only by art id
through `src/data/art.json` (`src/lib/art.ts`); the file names and their
`?v=` hashes live there. They are screened bitmaps, so they are never
resampled by an odd factor (that is what makes moiré):

- `size="full"`: the print's own CSS size (720 px for a plate), the 2x file on
  2x screens (both components).
- `size="half"` / `"third"`: 1/2 or 1/3 of it, the 1x file.
- On a phone narrower than the print, `max-width: 100%`, and nothing else.

An unknown id fails `astro check` (`ArtId` is the manifest's keys) and
`npm run check`. How to make, export and place a new print:
[`art/riso/README.md`](../../../art/riso/README.md#making-a-print).

Photos are not screened, so a photo goes into the slot as an `astro:assets`
`<Image>`; resizing it is fine.

## Restraint

The rule, from the person who asked for all this: playful, never overdone.

- One tactile object per section at most, and that is its plate. Before adding
  one, name what the page loses without it; if the answer is nothing, leave it
  out.
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
