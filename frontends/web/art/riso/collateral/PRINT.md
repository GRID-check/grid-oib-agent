# Piloti — Collateral

Request (2026-09-26): brand collateral for the three founders (Jonathan Uhlemann,
Matthias Bigl, Ferdinand Rubenbauer), all off the website: an email signature
strip with an HTML signature per founder, LinkedIn banners, square social
templates for blog announcements, pitch-deck slide backgrounds, and an A6
thank-you postcard for pilot offices with press separations and a back side.

The founders' steer after two rounds: "it all is just this house". Plate I's
house now appears on the email strip only (and, not yet built, on the
build-log square). The deck and the card are new still lifes drawn for their
formats. The company LinkedIn banner and the deck title slide come from the
Tragwerk series, drawn separately.

## Series principle

This work follows the Piloti series look in `../lib/piloti.js`, described in
[`../tafeln/PRINT.md`](../tafeln/PRINT.md#series-principle). What it does
differently:

- **Two scene kinds.** `sceneDraw(c, spec)` draws plate I's house on a model
  board (ported from `tafeln/index.html`, so the same object); `tableView()`
  sets up plate VI's tipped drawing table under the series camera and sun, on
  which the still lifes lie. Things on the table cast short shadows onto it, a
  Mist and Moss tint as in plate VI; they are unioned, so overlaps do not add.
- **Line scale.** `weight()` keeps key lines above 1.25 device px on the
  600 px strip; the postcard draws 1.45 times heavier, because a 0.08 mm
  hairline at 300 dpi does not survive a riso master.
- **No numerals** (`number: 0`): these are not plates of the series.
- **Red** is spent once in the whole kit: the stamp's pad and its impression.

## The kit, by piece

| Piece | Art id | Motif |
|---|---|---|
| Email strip, 600×120 / 1200×240 | `collateral/signatur/email` (site) | plate I's house, small at the right |
| LinkedIn, company | – | Tragwerk series |
| LinkedIn, Jonathan Uhlemann | `tafeln/zeichentisch/linkedin` | VI, the drafting table |
| LinkedIn, Matthias Bigl | `tafeln/schleife/linkedin` | III, the loop that learns from a correction |
| LinkedIn, Ferdinand Rubenbauer | `tafeln/waage/linkedin` | VII, hours against money |
| Social, build log | `collateral/so-rohbau/social` | the three columns stand, the house is dashed lines in the air |
| Social, journal | `tafeln/zeichentisch/social-titel` | VI, low in the square |
| Social, checking | `tafeln/pruefstand/social-titel` | V, low in the square |
| Deck 1, title | – | Tragwerk series |
| Deck 2, section divider | `collateral/masskette/deck` | Maßkette |
| Deck 3a–c, content | `collateral/ecke-{klammer,massstab,stempel}/deck` | three corner vignettes |
| Deck 4, closing | `collateral/schluessel/deck` | Schlüssel |
| Postcard front | `collateral/kaffee/postcard` | Kaffee |
| Postcard front, alternative | `tafeln/zeichentisch/postcard` | VI |
| Postcard back | `collateral/rueckseite/postcard` | one ink, text set by `rueckseite.mjs` |

Only the strip is a site file: mail clients load it from
`https://piloti.at/art/`. The signatures are `signatures/*.html`.

## Plates

### Rohbau (build-log square)

The three pilotis stand on the lawn with their long shadows; the volume they
will carry is only its twelve edges, dashed in the air, and the 1:100 figure
with the roll looks up at it. Drawn, not built. No box shadow, because nothing
is there yet.

### Maßkette (deck divider)

One chain dimension across the lower third of the slide: six extension lines,
45° ticks, the overall dimension beneath it, and the pencil that drew them
put down just past the last tick. A divider is a pause; the chain says "the
next stretch is measured". Three inks (Mist, Moss, Hunter), almost all line.

### Ecken (content backgrounds)

Quiet paper with one small thing in the bottom-right corner, about a fifth of
the slide wide, so text can take the rest:

- **Klammer:** three loose sheets, the top one with a heading bar and lines,
  a steel paper clip on its corner casting its own shadow.
- **Zollstock:** a folding rule half open in a zigzag, with a pencil.
- **Stempel:** a stamp tin with its lid laid open, the red pad, the stamp
  standing beside it, and the framed red impression it just made. The
  table's tilt is lowered (0.62 rad) so the standing stamp reads as a stamp.

### Schlüssel (deck closing)

The project's keys on a plan folded in four: two keys on a ring, a blank paper
tag on a string. The handover, without a handshake. The tag is blank on
purpose: no text in the art.

### Kaffee (postcard front)

A plan taped to the table after a long meeting. Two coffee rings overlap on
it, one cup each, a pencil and a folding rule lie where they were put down.
A thank-you for time spent together over the drawings. Three drums: Mist,
Moss (rings, shadows), Hunter (all line). The rings are an uneven dried edge
(a nib whose width wanders, one thin place) over a faint wash.

### Rückseite (postcard back)

Hunter only. Stamp box 21 × 25 mm, a rule at 56 % of the height, four address
lines, and the front's two coffee rings, small, bottom left. The words
("Danke.", the founders' names, "Piloti · Wien", "piloti.at") are set by
`rueckseite.mjs` with the site's Instrument Serif and IBM Plex Mono, because a
work draws no text; it writes the preview, the Hunter master with text, and a
two-page A6 proof PDF.

## Rejected proofs

Round 1 (the house everywhere):

- Four house banners (company, and one per founder with the chain dimension,
  lit windows at dawn, plate VIII's stair): read, but were "everything is the
  house". Founders' banners became plates VI, III, VII.
- Structural axes under the house: lost in the lawn stripes at 1:1.
- A banner board running off the right edge: at 4:1 a runway.
- A bare-soil plot redrawn from plate IV: weaker than plate IV itself.
- Postcard close-ups of plate VIII's west end: cut at the card edge, then
  sliced by a clip window.
- Deck slides reframing plates IV, II (in a corner) and VIII: re-framed plates,
  not motifs for the format; replaced in round 2.

Round 2:

- **Triangular scale rule** as a corner vignette: at corner size its three
  faces read as a stick. The folding rule replaced it.
- **Stamp at the table's usual tilt (1.12):** the stamp read as a disc on a
  box from above. Lowered to 0.62.
- **Keys at first size:** lost against the plan's walls; enlarged 1.7× and
  lightened.
- **Kaffee as a social square:** too small low in the square and the plan
  crowded the title space; dropped (the social set keeps Rohbau, V, VI).
- **Pencil graphite at 3.5 % of its length:** a speck at 1:1; now 6 %.

## Formats

| Composition | Format (`../lib/formats.js`) | Pixels | Pitch |
|---|---|---|---|
| `strip` | `email` (site) | 600×120, 1200×240 PNG | 3.4 / 6.8 |
| `sq` | `social` | 1080² PNG | 5.0 |
| `cover` | `deck` | 1920×1080 PNG | 5.0 |
| `a6` | `postcard` | 1240×1748 PNG, 300 dpi, + separations | 5.0 |

The Tafeln jobs that serve the kit (III, VI, VII `linkedin`; V, VI `sqlow`;
VI `a6`) are listed in `../tafeln/PRINT.md`. They change no site file.

## Inspected

Scratch crops live outside the repo (scratchpad `riso-usecases/collateral/`).

- **Strip:** full frame at 1200×240 and 600×120; 1:1 crop of the house at 2x
  and the 1x house magnified 3x. Rendered inside the signature HTML at 1x, 2x.
- **Rohbau:** full frame; 1:1 crop of columns, figure, dashed volume.
- **Maßkette:** full frame; 1:1 crop of the last ticks and the pencil (twice:
  the graphite fix).
- **Ecken:** each full frame; 1:1 crops of each corner, before and after the
  fixes above.
- **Schlüssel:** full frame; 1:1 crop of keys, ring and tag, before and after.
- **Kaffee:** full frame; 1:1 crops of the rings, the rule and pencil, the
  Hunter separation of the same area, the pencil tip magnified 3x.
- **Rückseite:** full frame with text; the PDF proof rasterised page by page.
- **Tafeln reuses:** every banner, square and the VI card at full size; 1:1
  crops of III's stations and VI's card detail.
- `verify.mjs --work collateral,tafeln` (Chromium and Firefox) after the last
  drawing change.

## Remaining weaknesses

- **Strip.** At 1x the house is ~120 px wide and mostly screen: a mark, not a
  picture. Mail apps that shrink it on phones resample the screen.
- **Maßkette.** Deliberately sparse; on a projector the 0.8-unit extension
  lines are faint. The pencil is the only tone on the slide.
- **Ecken.** The clip is a line drawing without tone; the folding rule's
  hinges are dots that read only at 1:1. Each vignette is about 300 px wide
  on a 1920 slide, which is right for a corner and small on a phone.
- **Schlüssel.** The keys are drawn flat on the paper (no thickness), and
  their shadow is the key outline offset, not a projection of a solid.
- **Kaffee.** The plan is the same generic plan as the closing slide's; the
  folding rule's end runs under the tape of the sheet's corner without
  interacting with it. The rings are regular for real coffee.
- **Rückseite.** The names at 7 pt are near the smallest a riso master holds;
  ask the shop for a proof.
- **VI postcard alternative.** Plate VI was drawn for 720 px: its annotation
  lines are 0.08 mm at 300 dpi and may drop out on the press.
- **Separations** carry antialiased line edges (grey), as the engine keeps
  them; a shop's driver screens those greys.
