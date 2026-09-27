# Piloti — Baustelle

Request (2026-09-26): a small riso stamp beside every release on the changelog
(`/changelog`, `/en/changelog`), next to its date: unique per release, obviously
one family, restrained enough to read as a printed stamp rather than decoration.
Releases arrive on every merge to `develop`, and their grouping may change (a
day today, perhaps a week or a tag later), so the pipeline must not need a new
export per release. Art ids: `releases/bau-01/release` … `releases/bau-30/release`.

The idea in one sentence: every release adds one part to plate I's house, and
the stamp shows the building site with that part marked in red, the way a
revision is marked on a drawing.

## Pipeline: a fixed set, picked by hash

Two options were on the table:

- **(a) Export per release.** `scripts/release_notes.py publish` runs in
  `.github/workflows/release-notes.yml` on a bare `ubuntu-latest` with only
  `uv`. An export there would need Node, the site's `npm ci` (for sharp), the
  pinned kit clone, its `npm ci`, and a Firefox download, on every merge that
  touches a note, and it would commit two binary files per release forever.
  Rejected: heavy, and it ties the art to the release data's shape.
- **(b) A fixed set, handed out in publishing order.** Chosen. Thirty stamps,
  one per building step, exported once. `src/lib/release-stamp.ts` gives the
  oldest release step one and each later release the next step, so the
  changelog shows the house going up release by release; after step thirty the
  next release starts a new plot. It works for any id (a date, a week, a tag),
  costs nothing per release, and the whole set is about 205 KB. (The first cut
  picked by a hash of the id, which scattered the steps and lost the story.)

Thirty, not 48: every step had to be a part you can see at 64 px. The list ran
out of honest parts at 30; padding it with near-duplicates would only have
made neighbours look alike. Every thirtieth release repeats a step, on a new plot.

## Series principle

This work follows the Piloti series look in `../lib/piloti.js`, described in
[`../tafeln/PRINT.md`](../tafeln/PRINT.md#series-principle): the one camera
(`VIEW_SERIES`) and sun (`SUN_SERIES`), paper `#F4F2E8`, Hunter key line, the
five drums, no text.

What differs, and why:

- **Solid fields, not screened tone.** At 64 CSS px a screened field of a few
  cells is noise (the first proof's lawn was green polka dots, its shadows a
  checkerboard). Every small field prints at coverage 1: shadows are Moss over
  Mist, glass Hunter over Moss, the roof bed Moss then Kelly, the tree Kelly.
  Two large fields stay screened as texture: the bare site (Mist 0.45, which
  reads like the site's own drawing grid) and the lawn (Kelly 0.3 over solid
  Mist).
- **A finer screen**: the `release` format's pitch is 2.4 / 4.8 device px
  (1x / 2x), against 3.4 / 6.8 for the plates, so the two screened fields read
  as texture rather than as dots.
- **Red once per plate, always for the same meaning**: the part this step
  added. A red outline over parts already drawn knocks the other inks out
  beneath it (`redLine`), because red over the Hunter key line overprinted to
  maroon in the first proof. Two steps take something away (the crane, the
  hut) and print no red.
- **Line weights through `weight()`**: 1.25 device px at 64 px, finer at 128.

## Plates

### Baustelle (building site), 30 steps

Plate I's house, on the same kind of model board: a bar 16 × 9 × 3.4 m on three
pilotis 4 m tall (two under the west end, one under the east), ribbon windows,
a roof garden bed and a roof pavilion under a projecting plate. A tower crane
stands at the back right, a site hut at the front right.

Steps, in building order: a stake with a red ribbon; the staked-out footprint;
the site hut; the crane; three footings; three pilotis; four floor bays; four
wall bays; the ribbon window in three pieces (south, south, west); the roof
bed; its planting; the pavilion; its roof; the crane leaves; the lawn (the hut
leaves with it); the path; a tree where the crane stood; the first visitor.

- **The crane.** Its jib swings toward the part being set and its hook hangs
  over it, so a mid-build stamp says where the work is without any red at all.
  Steps with no part to lift turn the jib by `rngFor('releases:jib:<n>')`.
- **The bar.** Bays go in west to east, so what stands is a walled run and a
  bare deck run: two boxes with fine joint lines, never four boxes (the first
  proof drew each bay with a silhouette and the bar read as a caterpillar).
- **One place.** The framing is fixed (board plus crane apex), so the site sits
  still across all thirty and the family reads at a glance down the page.
- **Rejected proofs.** A 12 × 6 bar on eight pilotis and a 20 m board: the
  pilotis read as a comb, the crane dominated and the house was a sliver.
  Plate I's tripod replaced it, which also makes the finished stamp the house
  of plate I.

## Formats

| Art id | Format | Composition | Notes |
|---|---|---|---|
| `releases/bau-NN/release` (30) | `release` (64 / 128) | `stamp` | Shown at 64 CSS px with `1x, 2x`; about 2 KB + 6 KB each |

## Inspected

- Contact sheets of all thirty at 2x zoomed 2x, and at native 1x and 2x, after
  every change (proofs v1–v6 kept in the session's scratchpad).
- 1x files at 5x nearest-neighbour, steps 18–25: ribbon windows, roof bed,
  pavilion; the red outline on dark glass reads, the key line holds at
  1.25 px.
- 2x files at 4x, steps 29–30: lawn screen (a fine gingham at 4x, texture at
  1:1), the tree's red outline (no maroon after the knockout), the figure (a
  red speck, as a 1:100 figure is at this size).
- 2x, steps 11–16: floor and wall bays with the knockout red outline.
- The changelog page at 390 and 1440 px, German and English.

## Remaining weaknesses

- The upper third of each stamp is empty once the crane is gone: the frame is
  fixed to leave room for the crane apex, so the finished house sits low.
- The first visitor (step 30) is a speck at 64 px; she reads only as "something
  red on the path".
- The tree stands half behind the house's east end and reads as a green half
  disc.
- Steps 5–10 (footings, pilotis) are sparse: a board, a crane and a few red
  marks. They are the weakest stamps of the set.
- Hash mapping repeats stamps (21 distinct among the 29 current releases), and
  adding a step would reshuffle every release's stamp.
