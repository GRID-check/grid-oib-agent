# Piloti — Vignetten

Request (2026-09-26): bring the riso language into the product app
(`frontends/ui`), restrained. Three places where the app shows nothing and says
so, and where a picture explains the moment better than an icon disc:

| Art id | Slot in the app | What it has to say |
|---|---|---|
| `vignetten/bauplatz/empty` | not-found page (`app/not-found.tsx`) | "Not in the plan": there is nothing built here |
| `vignetten/abstecken/empty` | projects home, no projects yet | A project starts here: the plot is staked out, nothing built yet |
| `vignetten/planschrank/empty` | a project's documents, none uploaded | The drawer where the drawings go is open and empty |

Everything else in the app keeps its icon discs. These three are first-run or
dead-end moments, seen rarely and read at leisure, which is where a quiet print
earns its space; a filter with no match or a failed search is a moment to act,
and a picture there would be in the way.

## Series principle

This work follows the Piloti series look in `../lib/piloti.js`, described in
[`../tafeln/PRINT.md`](../tafeln/PRINT.md#series-principle): line in Hunter,
colour in screened fields beneath it, the one camera and the low sun from the
front-left, paper `#F4F2E8`, Kelly only for something alive, Bright Red at most
once per plate and only for a meaning, no text in the picture.

What this work does differently, and why:

- **One size, drawn for it.** Every plate has one composition, `empty`
  (320 CSS px; 320 and 640 files), and is drawn for that slot rather than
  reduced from a plate. Line weights are fixed units (`LW`: 6.2, 4.8 and 4.3 in
  1080-unit space), which print 1.84, 1.42 and 1.27 px in the 320 file and the
  same CSS width in the 640 file. `weight()` was not used: it floors a line at
  1.25 *device* px, so the 2x file would get lines half as wide in CSS px as
  the 1x file.
- **Solid where it is small.** At 320 the screen (3.4 px) is coarse against the
  subject, so anything only a few cells wide is a solid shape on the line
  layer: the column's shade side, the stakes' south faces, the figure. A
  screened stake printed as a column of dots.
- **Mist, not a sparse Moss, on glancing faces of the plan chest.** Moss at
  0.16 prints as isolated dark specks at this size and made the drawer fronts
  busy; Mist at 0.38 carries the same value quietly.
- **No numeral** (`empty` sets `numeral: false`): a vignette is not a plate of
  the series, it is a spot in a product.

## Plates

### I. Bauplatz (building plot)

Plate IV of Tafeln brought down to a vignette, for the app's not-found page, as
plate IV is the site's 404. A small plot is pegged out on a bare model board at
dawn (the series azimuth, sun `z = -0.34`, so the shadows run long). Inside it
stands one piloti, 2.9 m, with three rebar ends out of its head: a column that
was never given a house. A surveyor's stake in front carries the plate's one red
mark, a painted head and a ribbon. Kelly grass only along the back and west
edges, where nobody walked; a Mist haze at the back of the board thins to bare
stock at the front.

- Batter boards from plate IV were left out: at 320 their boards and strings
  are sub-pixel clutter. Four short pegs at the plot corners carry the same
  meaning.
- First proof: a 10.4 × 7.6 board with the column at 3.2 m. The board filled
  the frame's lower half and the column was a small mark; the board was cut to
  7.7 × 6.2 and the framing raised. The soil had a Moss 0.08 field under the
  Mist, which printed as dark specks over the whole board; removed.

### II. Abstecken (setting out)

For the projects home with no projects yet. A mown model board, and on it a
plot staked out with four stakes and a string: the first act of any building
project. A 1:100 figure with a rolled drawing stands in front of the plot,
looking in. No red, because nothing is wrong; Kelly for the lawn.

- The figure is the one from plate I (`figure()`), filled solid on the line
  layer and stroked 5 units. `figure()` unions its parts in one path, and the
  overlaps that wind against each other open slivers under a nonzero fill; at
  68 px tall they read as white shorts and a white collar. The stroke closes
  them.
- Rejected positions for the figure: at the plot's near-left corner its rolled
  drawing touched the front stake and its head sat on the back stake (two
  tangencies); at the front centre its head touched the back-right stake. It
  now stands left of centre, clear of all four.
- First proof: a board 9.8 × 7.6 with a 6 × 3.6 plot. The figure was 30 px tall
  and read as a blot; the board was cut to 5.2 × 4.9.

### III. Planschrank (plan chest)

For a project's documents when none are uploaded. A plan chest of five shallow
drawers stands on a low platform. The top drawer is pulled out almost its full
depth, and it is empty: a bare tray, the shade of the carcass top lying across
its back, the dark mouth of the carcass behind it. The drawer is where the
drawings go.

- The series camera foreshortens depth to about 0.31, so a drawer pulled out
  0.62 m showed its inside as a sliver. It is pulled out 0.9 m.
- In the first proof the whole tray was tinted dark: its inside part was
  clipped to the carcass mouth, which on the sheet covers most of the pulled
  tray too. The shade is now the carcass top's (over the part still inside)
  and the rims' (front panel, west wall), each a separate hull; one hull over
  both rims filled the whole tray.
- The carcass silhouette was first drawn after the drawer and ran across it.

## Formats

| Art id | Format | Composition | Notes |
|---|---|---|---|
| `vignetten/bauplatz/empty` | empty (320 / 640) | empty | goes to `frontends/ui/public/art/` |
| `vignetten/abstecken/empty` | empty (320 / 640) | empty | goes to `frontends/ui/public/art/` |
| `vignetten/planschrank/empty` | empty (320 / 640) | empty | goes to `frontends/ui/public/art/` |

The `empty` format's destination is `app` (`lib/formats.js`): its files go to
the product app and its manifest is `frontends/ui/src/lib/art/art.json`.

## Inspected

- All three at 320 and 640, full frame, after every change.
- I: 1:1 crops at 640 (2× and 3× nearest-neighbour zoom) of the column and its
  rebar, and of the red stake, its ribbon and shadow. The crop found the stake's
  south face screened into a column of dots; it is now solid.
- II: 1:1 crops at 640 of the figure and the stakes around it, at three figure
  positions (tangencies, above), and after the solid fill and the closing
  stroke.
- III: 1:1 crops at 640 of the pulled drawer and the drawer fronts, before and
  after the south faces moved from Moss to Mist.
- `verify.mjs --work vignetten`: all six jobs repeat in Chromium and Firefox.

## Remaining weaknesses

- **I.** The upper third of the frame is bare paper: the board is flat under the
  series camera and the column is the only height. Next to the page's heading
  that reads as calm; on its own the vignette is bottom-heavy, as plate IV is.
  The dashed plot is faint at 320.
- **II.** The lawn stripes are a screen of Kelly and Mist dots over the whole
  board, busier than the other two. Two single pixels at the figure's hips are
  still paper at 640. The figure faces the viewer, not the plot (the figure
  has one pose).
- **III.** The west face of the carcass is a large bare panel, and the chest's
  top is a plain Mist field: the left half of the picture carries nothing. The
  closed drawers are all alike. The drawer's west wall throws almost no shadow
  into the tray, so the tray's own depth reads mainly from its rim lines.
- **All.** At the app's phone size the vignettes show at 160 CSS px (half), where
  a 1x screen downsamples the 320 file 2:1 and the screen goes grey. Only a
  1x phone sees it.
