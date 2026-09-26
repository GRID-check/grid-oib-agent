# Piloti — Tragwerk

Request (2026-09-26): the founders asked for a second riso series, more inventive than
the Tafeln: "what makes Piloti Piloti? Documents, regulations, buildings, pillars. Maybe
build a brick pillar." Mid-way the founder added: "a Greek pillar or something that could
be a staple". So the series is built around one drawing, **the Piloti column**, used as a
plate, a share card, a LinkedIn banner, a deck title slide and a 96 px spot. Art ids:
`tragwerk/saeule/{plate,og,spot,linkedin,deck,social}`, `tragwerk/drei/{plate,og}`,
`tragwerk/ordnung/{plate,og}`, `tragwerk/ziegel/{plate,og}`. Placed (by the lead): II taped in the Team
section, IV on the 404, I's og as the landing share card, III's og for the Journal.

## Series principle

This work follows the Piloti series look in `../lib/piloti.js`, described in
[`../tafeln/PRINT.md`](../tafeln/PRINT.md#series-principle): line in Hunter, colour in
screened fields beneath it, `VIEW_SERIES` and `SUN_SERIES`, paper `#F4F2E8`, Kelly only
for something alive, Bright Red once per plate and only for a meaning, no text.

What it does differently:

- **One column family, drawn once.** `column()` builds every column from parts that
  each carry a piece of what Piloti holds. Every plate reuses it, so the column reads
  as a recurring mark and not as four illustrations.
- **Solid colour where the screen would drown the shape.** Book cloth, brick, the
  inside of a roll and the spot's shade band print solid on the line layer (as plate
  IV's lone column did in Tafeln), so a carved section sign, a mortar joint or a
  spiral gap stays crisp. The 3.4 px screen breaks a paper-coloured knock-out narrower
  than itself into dots; the first proof of the book spines showed it.
- **The section sign.** A § is allowed as a glyph, like the numeral: it reads the same
  in both site languages. It is hand-built from two S strokes (`paragraf()`, the same
  construction as plate V's sign), carved out of solid cloth.
- **Numbering** restarts at I for this series.

## The column (Die Säule)

Generic classical vocabulary in our own proportions, no quotation of a real temple:

- **Plinth: three law books**, stacked and stepped like an Attic base. Their spines face
  the viewer in solid Moss cloth with raised bands, each with a section sign carved out.
  The page block shows on the sunlit west face as fine lines between the boards. The
  building stands on the codes.
- **Shaft: fluted**, 20 flutes, slight entasis (the radius narrows to 0.84 with a
  1.5-power curve). Flutes are fillet lines; in the sun each flute's shadowed wall is a
  Mist field, on the turned side Moss deepens. Below about 45 units of radius the
  half-flute tints turn to speckle, so small columns (plate III) keep the lines only.
- **Capital: a sheaf of drawings rolled up at both ends.** The Ionic volute read as a
  scroll is old; here it is literal. The sheaf's front edge (the canalis) carries two
  sheet lines that run on into both spirals; each roll's end shows the paper spiralling
  into a solid dark core, and the bolster runs back along y. The office's drawings sit
  between the law below and the book above.
- **Abacus: a closed book**, page block to the viewer, with a **red bookmark** hanging
  out: the one red mark, the place in the rules that matters.

## Plates

### I. Säule (Column)

The column alone on the lawn board of Tafeln plate I (it is about 10 m tall). The
series sun throws the shadow long across the lawn to the back right, and it ends in the
capital's silhouette. The board runs out of the frame, so the lawn reads as ground.
Scale comes from a chain dimension in the west margin, as on a drawing: plinth, shaft
and capital between 45° ticks, the extension lines stopping short of the column.

- **Formats.** `sq` (plate), `og`, `linkedin` (column at 0.66 of the width, the board
  starting right of centre so the bottom-left third stays bare paper for the profile
  photo), `deck` (column at 0.7, the upper left open for a title), `social`, and `spot`.
- **Spot.** Its own drawing (`spotColumn`): a near-elevation (`fy` 0.3) with every line
  at `weight()` or more, three solid book spines, a solid shade band on the shaft, two
  flute lines, Mist disks with bold spirals, a solid abacus and the red bookmark. No
  screened tone except the Mist disks. It reads at 96 px as a column with a red mark.
- **Rejected proofs.** A 1:100 figure with a rolled drawing beside the plinth (round
  one). At 7 m it made the figure a toy; at 10 m it still read, in the founders'
  words, as "stupid", and a lone man was wrong for the three founders' section. All
  figures are gone from this work (round two); the chain dimension carries the scale
  instead. The first framing (whole board in
  the square) left the column 250 px tall at 720 and the flutes unreadable.

### II. Drei Säulen (Three columns)

Three columns of the family carry one white slab with a planted roof (Kelly, alive):
law as a shaft of stacked books (every third with its section sign), the office as a
bundle of rolled drawings tied with two strings (some on tracing paper, in Mist; each
roll with its own solid shade band), the project as a brick pier (solid brick, paper
joints). All three stand on the book plinth and wear the scroll capital. The
bookmark hangs only from the law column. Three columns, one slab: it is the Team
plate, the three founders carrying one project. No figure: the long shadows give the
scale (round one had a figure walking between the columns).

- **Rejected.** The first brick shaft had tinted faces with carved joints: at 720 it
  printed as speckle. The first rolls had a screened ramp each and read as one white
  cylinder.

### III. Säulenordnung (The orders)

A textbook plate of the orders, a pun on Säulenordnung and Bauordnung. Left to right,
each taller and richer: brick with a plain book for a capital; a shaft of lever-arch
binders stood round in four tiers (their spines are the flutes, the finger holes and
label fields the ornament); the Piloti column; the planted order, fluted with a bell of
curling Kelly leaves (the Corinthian, alive); rolled drawings under the scroll capital.
A chain dimension with 45° ticks runs along the column axes, and a levelling staff with
alternating metre fields stands at the left as the drawing's scale bar.

- **Formats.** The `og` lines the orders up frontally, as a textbook does. The square
  sets them on a shallow diagonal (3.3 m in x, 1.5 m in y per step) and lets the board
  run off the frame, so the row fills the sheet.
- **Rejected.** A steep diagonal (equal x and y steps) crowded the capitals into each
  other and left the columns 190 px tall. A left-margin height chain with a tick per
  column top clustered its ticks into a hatch: replaced by the staff.
- **Folded in.** Concept 4, the Aktensäule, lives here as the second order rather than
  as its own plate: alone its finger holes read as perforations.

### IV. Ziegelpfeiler (Brick pier)

The founder's brick pillar. A pier of Austrian-format bricks (240 × 115 × 63 mm, 10 mm
joints), three bricks a side, 30 courses in running bond, the ring turning each course.
A bed of mortar is spread on the top course; above it the column's capital hangs level
from a crane hook on four slings, about to be set down. The cable comes from out of
frame. One brick near the top of the west face is a folded plan: paper-white, its folds
as lines. A small stack of loose bricks lies beside the pier; a few tufts of grass grow
along the back edge. No figure: this is 1:20, where the 1:100 figure would be wrong.

- **Rejected.** A racked-back pier with the capital lying on a pallet beside it ("the
  drawings were ready before the pier was"): the capital on the ground read as a coffee
  table and the joke needed explaining. The hook tells the same story in one look.

## Concept sketches not taken further

All sketched as low-effort proofs with the same column parts; the contact sheet is in
the session's scratchpad (`riso-usecases/tragwerk/concept-sketches.png`).

- **Fundament** (a block cut through a foundation whose strata are documents): it
  repeats Tafeln II (Schichten), and the cut face needed text to say which layer is
  which.
- **§-Schatten** (a piloti whose shadow is a section sign): the shadow has to be faked,
  and faked it reads as a gag. The fear of "tacky" applies exactly here.
- **Bewehrung** (pencils as rebar out of the top of a column): the pencils are too thin
  to read at 720 and the joke is a pun on a word.
- **Gleichenbaum** (the column topped out with a small fir and a ribbon): charming, but a
  tree on one free-standing column reads as a monument, not a topping-out. It would
  belong on plate II's slab if the founders want it.

## Formats

| Art id | Format | Composition | Notes |
|---|---|---|---|
| `tragwerk/saeule/plate` | plate (720 / 1440) | sq | the hero of the series |
| `tragwerk/saeule/og` | og 1200×630 | og | |
| `tragwerk/saeule/spot` | spot 96 / 192 | spot | own drawing, `spotColumn()` |
| `tragwerk/saeule/linkedin` | linkedin 1584×396 (out) | linkedin | bottom-left third bare paper |
| `tragwerk/saeule/deck` | deck 1920×1080 (out) | deck | upper left open for a title |
| `tragwerk/saeule/social` | social 1080² (out) | sq | |
| `tragwerk/drei/plate`, `…/og` | plate, og | sq, og | |
| `tragwerk/ordnung/plate`, `…/og` | plate, og | sq, og | square on a diagonal, og frontal |
| `tragwerk/ziegel/plate`, `…/og` | plate, og | sq, og | |

## Inspected

- **I.** Full frame at 720, 1440, og, linkedin, deck, social, spot 96 and 192. 1:1 crops
  at 1440 of the capital (found: the spiral's dark disk showed a crescent outside the
  outer turn, fixed by filling only the first turn; the sheaf band closed up the dark
  gaps, fixed by thinning it after the first quarter turn; the canalis carried no sheet
  lines, added) and of the plinth (found: the carved § vanished into the
  screen, fixed by solid cloth). Earlier, 2x-zoom crops of the whole column.
- **II.** Full frame at 720 and og; a 1:1 crop of all three columns and the slab at 1440
  (found the speckled brick and the single-cylinder rolls, both fixed).
- **III.** Full frame at 720 and og in three layouts; a 1:1 crop of the three right-hand
  capitals at 1440 (the leaves read; the small fluted shafts had turned to speckle,
  fixed with the `small` branch).
- **IV.** Full frame at 720 and og; 1:1 crops at 1440 of the capital, slings, hook and
  pier top (found the hook drawn upside down above its ring, and the folded-plan brick's
  folds on a hidden face; both fixed).

Round two (figures removed): the full frames of I and II in every format again, and a
1:1 crop at 1440 of plate I's chain dimension and capital.

`node art/riso/verify.mjs --work tragwerk` passes (all 17 jobs, Chromium and Firefox).

## Remaining weaknesses

- **Everywhere.** The fluted shaft's Mist half-flutes are still a fine speckle at 720:
  the flutes read as lines, not as grooves. The bolster (the roll seen from the side)
  is a flat Mist shape with a Moss ramp; it does not show the sheets wound round it.
- **I.** The lawn is a large Kelly field and carries more weight than the column in the
  lower half. The chain dimension is faint at 720 and in the LinkedIn banner.
  In the LinkedIn banner the section signs on the spines are two pixels wide and read as
  stripes.
- **II.** The slab is plain and a little heavy; its Mist top screens coarsely. The three
  long shadows plus the slab's merge into one dark band at the back right. The book
  shaft is much darker than the other two, so the row reads unevenly.
- **III.** The binder column is the weakest order: its finger holes read as rivets. The
  leaf capital is a green crown at 720; the leaves only read as leaves at 1440 and in the
  og. The front chain dimension is faint.
- **IV.** The capital is small at 720 (about 150 px wide) and its bookmark is shortened
  to clear the pier; the folded-plan brick is found only by someone who looks. The sand
  is a uniform stipple. The slings attach at the abacus corners with no visible fitting.
- **Spot.** At 96 px the shaft's two flute lines and the shade band merge; the red
  bookmark crosses the right volute.
