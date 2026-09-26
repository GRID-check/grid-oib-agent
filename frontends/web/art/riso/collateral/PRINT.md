# Piloti — Collateral

Request (2026-09-26): brand collateral for the three founders (Jonathan Uhlemann,
Matthias Bigl, Ferdinand Rubenbauer), all off the website: an email signature
strip with an HTML signature per founder, LinkedIn banners (company and one per
founder), square social templates for blog announcements, pitch-deck slide
backgrounds, and an A6 thank-you postcard for pilot offices with press
separations and a back side. The founders' one steer after the first round:
"everything uses the house image". So the kit is spread across the whole
series, and only the pieces that need plate I's house in a new arrangement are
drawn here.

## Series principle

This work follows the Piloti series look in `../lib/piloti.js`, described in
[`../tafeln/PRINT.md`](../tafeln/PRINT.md#series-principle). What it does
differently:

- **One scene function.** `sceneDraw(c, spec)` draws plate I's house (and plate
  VIII's stair and door) on a model board from a spec: what stands on the board
  and how it is framed. House, columns, stair, stones, chain dimension and
  figure are ported line for line from `tafeln/index.html`, so they are the
  same objects, not look-alikes.
- **Line scale.** `lw` scales every weight: 1.25 on the 600 px strip (with
  `weight()` keeping a key line above 1.25 device px), 1.5 on the postcard (a
  0.08 mm hairline at 300 dpi does not survive a riso master).
- **No numerals** on this work's plates (`number: 0`). They are not plates of
  the series; the Tafeln jobs that serve collateral keep their numeral.

## The kit, by piece

| Piece | Art id | Plate | Where the job lives |
|---|---|---|---|
| Email strip, 600×120 / 1200×240 | `collateral/signatur/email` (site) | I, the house small at the right | here |
| LinkedIn, company | `collateral/li-piloti/linkedin` | I, with the next plot staked out beside it | here |
| LinkedIn, Jonathan Uhlemann | `tafeln/zeichentisch/linkedin` | VI Zeichentisch | tafeln |
| LinkedIn, Matthias Bigl | `tafeln/schleife/linkedin` | III Schleife | tafeln |
| LinkedIn, Ferdinand Rubenbauer | `tafeln/waage/linkedin` | VII Waage | tafeln |
| Social, build log | `collateral/so-rohbau/social` | I not yet built (below) | here |
| Social, journal | `tafeln/zeichentisch/social-titel` | VI, low in the square | tafeln |
| Social, how it works | `tafeln/pruefstand/social-titel` | V, low in the square | tafeln |
| Deck 1, title | `collateral/dk-titel/deck` | I, house right, title space left | here |
| Deck 2, section divider | `tafeln/bauplatz/deck` | IV Bauplatz | tafeln |
| Deck 3, content | `tafeln/schichten/deck-ecke` | II, small in the bottom-right corner | tafeln |
| Deck 4, closing | `tafeln/tuer/deck` | VIII Offene Tür | tafeln |
| Postcard front | `collateral/karte/postcard` | VIII's house, whole, at dawn | here |
| Postcard front, alternative | `tafeln/zeichentisch/postcard` | VI | tafeln |
| Postcard back | `collateral/rueckseite/postcard` | one ink: stamp box, rule, address lines, the house small | here |

Why each founder's plate: VI is the architect's table (architecture and
product), III the loop that learns from a correction (software and AI), VII
the balance of hours against money (business). Only the strip is a site file:
mail clients load it from `https://piloti.at/art/`. The signatures that use it
are `signatures/*.html`.

### Rohbau (build-log square)

The three pilotis stand on the lawn with their long shadows; the volume they
will carry is only its twelve edges, dashed in the air above them, and the
1:100 figure with the roll looks up at it. Drawn, not built: the build log is
the house under construction. No box shadow, because nothing is there yet.

### Karte (postcard front)

Plate VIII's house at dawn, whole on its board: stair, open door with its lime
light, stones across the lawn. The model sits on bare stock, every edge more
than 5 mm inside the card.

### Rückseite (postcard back)

Hunter only, so it is one drum. Stamp box 21 × 25 mm, a rule at 56 % of the
height, four address lines, and the house as a one-colour vignette in the
bottom left. The words ("Danke.", the founders' names, "Piloti · Wien",
"piloti.at") are set by `rueckseite.mjs` with the site's Instrument Serif and
IBM Plex Mono, because a work draws no text. It writes the preview, the
Hunter master with text, and a two-page 105 × 148 mm proof PDF.

## Rejected proofs

- **Three more house banners** for the founders (the house with the chain
  dimension; at dawn with the ribbon windows lit Kelly; with plate VIII's stair
  and stones). Each read, but four banners of one house were the "everything
  is the house" the founders named. Replaced by plates VI, III, VII.
- **Structural axes** under the house (dash-dot grid, blank bubbles) for the
  software banner: lost in the lawn stripes at 1:1.
- **Banner board running off the right edge** (plate I's `og` framing): at 4:1
  it became a runway. The board now sits whole in the frame.
- **A bare-soil plot** (plate IV redrawn here) for a social square and the
  divider slide: pale, small and weaker than plate IV itself. The square became
  the Rohbau; the slide is plate IV.
- **A small house in the corner** of the content slide: a third house in one
  deck. Plate II's stack of sheets took the corner.
- **Postcard close-up** of VIII's west end, first cut at the card edge (inside
  the press's unprinted 5 mm), then clipped to an image window: the window
  sliced the house and the pavilion roof into a stray sliver. The whole model
  replaced it.

## Formats

| Composition | Format (`../lib/formats.js`) | Pixels | Pitch |
|---|---|---|---|
| `strip` | `email` (site) | 600×120, 1200×240 PNG | 3.4 / 6.8 |
| `linkedin` | `linkedin` | 1584×396 PNG | 5.0 |
| `sq` | `social` | 1080² PNG | 5.0 |
| `cover` | `deck` | 1920×1080 PNG | 5.0 |
| `a6` | `postcard` | 1240×1748 PNG, 300 dpi, + separations | 5.0 |

The Tafeln jobs add compositions `linkedin` (III, VI, VII), `cover` (IV,
VIII), `sqlow` (V, VI: the `social` format drawn low in the square),
`corner` (II, a `deck` job) and `a6` (VI). They change no site file: the
Tafeln site exports come back byte-identical.

## Inspected

Scratch crops are kept outside the repo (scratchpad `riso-usecases/collateral/`).

- **Strip:** full frame at 1200×240 and 600×120; 1:1 crop of the house at 2x,
  and the 1x house magnified 3x (nearest neighbour). All three columns, the
  roof bed and the ribbon window read at 1x; the screen dominates the tone.
  Rendered in the signature HTML at 1x and 2x.
- **LinkedIn:** every banner at full size (native, 1x only). Crops: the first
  Rubenbauer stair (stones smeared into a row at the board edge), the first
  Bigl axes (lost), the company banner at 1:1. VI's cards touched the top edge
  and VII's pointer was cut: both reframed and re-looked at.
- **Social:** all three at full size; 1:1 crop of the Rohbau columns and figure.
- **Deck:** all four at full size; 1:1 crops of the title's dimension and
  figure, the plate II corner, the plate VIII stair.
- **Postcard:** front at full size in three framings; 1:1 crop of stair and
  door in colour and in the Hunter separation; each separation of the front
  viewed whole (Kelly shown); the back with text at full size and a 1:1 crop of
  the names and vignette; plate VI's alternative at full size and a 1:1 crop
  of its finest lines.
- `verify.mjs --work collateral,tafeln` (both engines) after the last change.

## Remaining weaknesses

- **Strip.** At 1x the house is ~120 px wide and mostly screen; it is a mark,
  not a picture. Mail clients that shrink the 600 px image on phones resample
  the screen (mild moiré).
- **Company banner.** The staked plot to the right is small and its strings
  are thin at 1584 px; LinkedIn shows the banner smaller still.
- **Founders' banners.** They are plates VI, III, VII recomposed, with the
  plates' own weaknesses (VI's thin pencil, III's high key, VII's plain table).
  III's numeral and loop sit left of centre-right; nothing tells the viewer
  which founder chose which plate, which is intended.
- **Rohbau.** The dashed volume's hidden back edges are drawn like the front
  ones; a stricter drawing would dash only the hidden ones.
- **Title slide.** The figure is ~40 px tall at 1920.
- **Postcard front.** The model fills the middle 40 % of the card; the lit
  door, the card's point, is small (about 3 × 8 mm). The stones are a tight
  row.
- **Postcard back.** The names at 7 pt in Plex Mono are near the smallest a
  riso master holds cleanly; ask for a proof.
- **VI postcard.** Plate VI was drawn for 720 px: its annotation lines are
  0.08 mm at 300 dpi and may drop out on the press. Use the house card unless a
  test print holds them.
- **Separations** carry antialiased line edges (grey), as the engine keeps
  them; a shop's driver screens those greys. Hunter carries all line work, so
  its registration governs the card.
