# Piloti — Tafeln

Request (2026-09-26): a small series of procedural riso prints for the Piloti website.
Piloti is an AI knowledge platform for architecture and planning offices in Vienna. The
name comes from the columns that lift a modernist building off the ground. The prints
should be calm, precise and a little witty, drawn with an architect's sensibility, and
carry no text. They became the site's main visual language, so the series grew from four
plates to eight, with extra formats for plate I.

## Series principle

One construction style across different subjects, as in the kit's Cabinet series. Each
plate is a parallel-projected drawing on bare warm stock:

- **Line.** Form is fine line in the key ink (Hunter Green). Silhouettes run 1.9 units,
  arrises 1.1–1.4 and annotation 0.8–1.0, in 1080-unit drawing space. Line is printed
  solid, never screened (see "Engine changes").
- **Colour.** Colour sits in screened fields under the line. Mist is the sage ground
  tone, Moss the shade on built surfaces, Kelly the living green, and Hunter over Moss
  the darkest note.
- **Light.** The sun always comes from the front-left, low: `SUN ≈ (0.67, 0.47, -0.56)`
  in world metres (x east, y north, z up). West faces are bare stock, south faces
  glancing, and shadows fall back-right.
- **View.** Every plate uses one elevation-oblique camera: x almost horizontal (3°), y
  receding up-left at 37° at half scale (0.52), z true. The long facade reads nearly as
  an elevation, as on a drawing board.
- **Accent.** Kelly Green is the only lime accent, and it always means growth or
  something alive: the roof garden, the lawn that runs on under the house. Bright Red is
  reserved and spent at most once per plate, on a meaning (a correction, a surveyor's
  ribbon).
- **Scale.** A 1:100 figure with a rolled drawing gives scale where a plate has a site.
- **Numbering.** An engraved roman numeral in the key ink, borrowed from Cabinet. It is
  the only glyph, and it reads the same in both site languages.

### Inks

Real Riso drum colours (hex from the `riso-colors` list):

| Ink | Hex | Role | Screen angle |
|---|---|---|---|
| Mist | `#D5E4C0` | Sage ground, sky caught in glass, bounce light; almost the site's tint `#d3ddc0` | 0° |
| Kelly Green | `#67B346` | Lawn and planting; the lime accent | 45° |
| Moss | `#68724D` | Shade on built surfaces; the olive | 76° |
| Hunter Green | `#407060` | Key line, ground shadow, darks | 14° |
| Bright Red | `#F15060` | Reserved, at most one small mark per plate | 26.6° |

Darks are overprints, never black. Hunter at 0.86 over Moss at 0.62 in a window
multiplies to about `#1f3322`, close to the site's ink `#1b1c19`. Paper is `#F4F2E8`
with the kit's mottling, fibres and flecks.

## Formats, size and pitch

Every format is drawn in a 1080-unit-wide space, with height set by the aspect. The
geometry is in world metres, and each format composes its own view: `fit()` scales and
centres a chosen set of world points. The OG card and the banner are recomposed, not
cropped.

| Format | Pixels | Pitch (device px) | Note |
|---|---|---|---|
| `sq` | 720 / 1440 | 3.4 / 6.8 | 1x / 2x of a 720 CSS px slot, same screen at the same CSS size |
| `og` | 1200×630 | 5.0 | Platforms scale it, so it takes a coarser screen that survives reduction |
| `wide` | 800×300 / 1600×600 | 3.4 / 6.8 | 1x / 2x of an 800 CSS px header |

A 1x pitch of 3.4 px is coarser than the kit's film (3.07 CSS px) and finer than
Cabinet's print pitch. Both sizes of a plate are one sheet: paper, starvation flecks
and every mark are placed in units, so the 1440 file is the 720 file re-rasterised,
never enlarged.

## Engine changes (from riso-windowseat workings and cabinet)

- **Non-square formats.** `W` is 1080 units wide and `H` follows the aspect. The paper
  noise tiles, fibre and fleck counts, and starvation scale with the area.
- **Per-job pitch.** Screens are cached per pitch.
- **Line layer per ink.** Each ink has a tone layer, which is screened, and a line layer,
  which is not. They are combined as `max(dot, line alpha)`. At a 720 1x export a key
  line is 1–1.3 px wide. Screened, its antialiased edge falls below 1 and breaks into
  dots, and Cabinet's "coverage 1 prints solid" only saves the line's core. The line
  keeps its antialiased edge, as a scan of a solid printed line would.
- **`own()` clears both layers.** Painter's order hides the lines behind an occluder as
  well as its fields.
- **Integer registration.** The offsets are `REG × K × 0.7`, rounded. A sub-pixel
  `drawImage` of a screened bitmap resamples it, which is the resize the kit forbids.
- **Starvation in units**, so the 720 and 1440 files drop the same flecks.
- **Kept from Cabinet:** pixel-centred dots (`+0.5`), the ±4.5% mid-tone dither, and
  coverage ≥ 1 closing up solid.

The integer time selects a JOB (plate × format × size), not a plate. `window.__riso.jobs`
lists them, and `seek(t)` is pure. Bakes are cached per job and filled lazily.

## Plates

### I. Drei Stützen (three pilotis)

The hero of the series, used in the team section, as the OG image and as the build-log
banner. A white volume, 16 × 9 × 3.4 m, stands on exactly three pilotis 4.0 m tall and
0.38 m across: two under the west end and one under the east. Three points fix a plane,
so three legs is the least a table needs to stand, one for each founder. The cantilevers
are generous on purpose. The lawn runs on under the house, the first of Le Corbusier's
five points. The footprint of the lifted volume is dashed on the ground, a drawing
convention for what hangs overhead, and it reads as the witty line: drawn, not built.

- **Parts.**
  - Ribbon windows on both visible faces (the fenêtre en longueur).
  - A roof garden: a lime planted bed and a curved solarium screen, after Villa Savoye.
  - A chain dimension in the west margin with 45° architect's ticks: clear height, then
    the storey.
  - A figure with a rolled drawing on a gravel walk, casting its own shadow.
- **Shadows.** Ground shadows are true projections along `SUN`: the hull of the box
  corners and one strip per column. They are unioned on a scratch layer so overlaps do
  not add up, clipped to the board, and printed as a single Hunter screen at 0.64. With
  Hunter plus Moss the shadow went busy and camouflage-like at 1:1.
- **References.** The Villa Savoye (pilotis, ribbon windows, roof-garden screen) from
  general knowledge, not an inspected photograph. The building is an invented tripod
  house, not a reconstruction, and its proportions were not measured from a source.
- **First proof, rejected.** An isometric view (x and y at 30°). The plan depth hid the
  gap under the volume, so the house read as sitting on the ground and the three
  pilotis, the subject, were invisible. The oblique camera replaced it. This was the
  hardest frame, and it was proved before any other plate was drawn.
- **Formats.**
  - `sq` frames the whole board.
  - `og` frames the house and lets the lawn run off to the right.
  - `wide` stretches that lawn and stakes out the next house on it (dashed footprint,
    four stakes, a string line). This ties the build-log header to plate IV.

### II. Schichten (layers)

The cover for the post "Wie Piloti funktioniert". It shows the six layers of that post's
own diagram, read top to bottom: sources, preparation, index, search, check, answer.
Each layer is a 12 × 8.2 sheet in exploded axonometry, 2.35 apart, with the same camera
and sun as plate I. The dashed guides at the corners run between the sheets, and every
sheet shades the one below it.

- **Sources.** A building-code booklet (a thick block with page lines on its edge), a
  floor plan with walls as poché, a site plan with contours, and a web page card.
- **Preparation.** The same kinds of document cut into fifteen tiles: text bars, table
  grids, wall fragments.
- **Index.** The accent sheet, tinted Kelly. Seventy solid lime points gather in four
  clusters, as embeddings of related tiles do, over a faint text grid. The points are
  on the line layer, so they print crisp and unscreened.
- **Search.** Two parallel lanes (the two channels), with three tiles caught in each.
- **Check.** Four tiles. Three carry a tick, and one is struck through in Bright Red,
  the plate's single red mark: a quotation that is not in its source.
- **Answer.** One clean page of text bars, with two citation tiles pinned beside the
  lines they carry.

Details:

- **Sheet shadows.** The shadow of the sheet above prints after a sheet's own drawing,
  so it lies over the content, as a shadow does. It is a Mist wash, 0.55. In the first
  proof it was Moss, which went dirty and flattened the sheets, and it was drawn before
  the content, whose `own()` cleared it.
- **Table.** Only the bottom sheet casts onto a table 1.2 below. The first proof cast
  all six sheets onto a far table, which gave a stepped shadow bigger than the stack.
- **Ticks.** Drawn on the sheet with their depth exaggerated. Foreshortening at 0.31
  otherwise flattens a tick into a V.
- **Labels.** No words: text is bars. The post's diagram carries the labels.

## Inspected

Plate II: the full frame at 720 and 1440, and a 1:1 crop of the index, search and check
sheets at 1440.

Plate I, all five files:

- the full frame at 720, 1440, 1200×630 and 1600×600;
- a blurred greyscale value view of the 720;
- 1:1 crops under the house (columns, figure, dimension, shadow edges) at 720 and 1440;
- a 2x-zoom crop comparing PNG and WebP q95.

`verify.mjs --times 0,1,2,3,4` passes in Chromium and Firefox. The engines are not
pixel-identical to each other, as expected; exports use Firefox. `still.mjs` repeats
every job.

## Remaining weaknesses

- **I.**
  - The curved solarium screen is a thin surface without wall thickness, so its top edge
    reads as a line, not a coping.
  - The west column's contact ring is lost in the shadow.
  - The figure is about 15 px tall in the 800 banner and reads only as a mark.
  - The column shading ramp is hard to see at 720.
  - Shadows fall only on the ground: nothing is cast onto the columns or the figure.
  - The mown stripes are faint at 720.
- **II.**
  - The content is small at 720: the booklet and the site plan read as objects, but
    their detail only shows at 1440.
  - The index sheet stacks three screens (Kelly, Mist, the shadow) and is busier than
    the others.
  - The ticks have a long right arm.
  - The 1440 WebP is 535 KB, because the screened fields cover most of the frame.
