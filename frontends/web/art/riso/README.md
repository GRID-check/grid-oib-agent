# Riso art

Procedural risograph prints for Piloti: the site's picture language, and the
source for decks, email, social posts and printed postcards. Each **work** is a
folder here with one Canvas 2D page (`index.html`) and its design record
(`PRINT.md`). No libraries, fonts, images or network calls in any of it.

The workflow, the series rules and the placement rules are the
`aiq-piloti-riso` skill (`skills/aiq-piloti-riso/SKILL.md`). This file is how
the machinery works.

| Path | Holds |
|---|---|
| `tafeln/` | Plates I–VIII of the first series. Its `PRINT.md` states the series principle every work follows |
| `lib/engine.js` | The print engine: screens, paper, starvation, the bake, the `window.__riso` contract, `Riso.run` |
| `lib/piloti.js` | The series look: inks, paper, screen angles, registration, camera, sun, projection, props |
| `lib/formats.js` | Every export slot by name, with pixel sizes, pitch, encoding and destination |
| `kit.json` | The pinned riso-windowseat commit. The only place the version is written |
| `setup.mjs`, `new.mjs`, `export.mjs`, `check.mjs`, `verify.mjs` | The commands below; `kit.mjs` is what they share |
| `template/` | What `new.mjs` copies |
| `out/` | Non-site exports. Gitignored |
| `LICENSE-NOTICE.md` | The kit's MIT notice, which ships with the adapted engine |

## Commands

From `frontends/web`, with `npm ci` done (the exporter uses the site's sharp):

```bash
node art/riso/setup.mjs                         # task art:setup
node art/riso/new.mjs karten --title "Karten"   # task art:new -- karten
node art/riso/export.mjs                        # task art:export (all works)
node art/riso/export.mjs --work tafeln --only 0,tafeln/stuetzen/og
node art/riso/export.mjs --manifest             # rewrite src/data/art.json only
node art/riso/check.mjs                         # task art:check, also in npm run check
node art/riso/verify.mjs --work tafeln          # task art:verify (minutes)
```

To look at a job, open `<work>/index.html?t=<job>` in Firefox. Views by query
string: `?only=<ink>` one plate in colour, `?sep=<ink>` the press separation,
`?debug=lines` where a plate implements it.

## The kit

`setup.mjs` clones [sevenevesai/riso-windowseat](https://github.com/sevenevesai/riso-windowseat)
at `kit.json`'s commit into `~/.cache/piloti-riso/riso-windowseat-<commit>`
(`RISO_KIT_DIR` overrides), outside the repo so every worktree shares one clone
and a new pin never reuses an old one. It runs `npm ci --ignore-scripts` in the
kit's `tools/`: stills need playwright-core, not the ffmpeg the film tools
download. Then it finds a browser, in this order, and records the result in
`<kit>/.piloti-setup.json`:

1. Firefox as playwright-core finds it (honouring `PLAYWRIGHT_BROWSERS_PATH`);
2. Firefox after `playwright-core install`;
3. Firefox under `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`;
4. Chromium, with a warning.

Firefox is the kit's primary engine and made every committed file. Chromium
antialiases differently, so a Chromium export does not reproduce them: fine
for a proof, not for a commit. To move the pin, edit `kit.json`, run setup,
re-export every work and read the diff.

## One engine, shared by classic scripts

Every work loads `../lib/formats.js`, `../lib/engine.js` and `../lib/piloti.js`
with `<script src>`, then declares its plates and calls `Riso.run`. The kit's
tools open a work over `file://` and abort only non-file requests, so relative
classic scripts load there and in a browser opened on the file. Module scripts
would not (blocked on `file://`), and a build step that inlined `lib/` into
each work would leave a generated copy to drift. The cost of classic scripts
is one shared global scope: a work must not redeclare a `lib/` name.

`lib/` was cut out of `tafeln/index.html` without changing a line of the
drawing. All 19 Tafeln jobs render byte-identical PNGs before and after, and
the committed WebP and PNG files re-export byte for byte.

## Formats

A work's JOBS table names a format, never a size. `lib/formats.js` is the
registry (it is JavaScript, not JSON, because the page reads it over
`file://`). A job expands to one export per density of its format, and each
export is one integer time of the page.

| Format | Pixels | Pitch | Composition | Goes to |
|---|---|---|---|---|
| `plate` | 720², 1440² | 3.4 / 6.8 | `sq` | site |
| `og` | 1200×630 PNG | 5.0 | `og` | site |
| `banner` | 800×300, 1600×600 | 3.4 / 6.8 | `wide` | site |
| `cover` | 720×405, 1440×810 | 3.4 / 6.8 | `cover` | site |
| `spot` | 96², 192² | 3.4 / 6.8 | `spot` | site |
| `empty` | 320², 640² | 3.4 / 6.8 | `empty` | site |
| `email` | 600×120, 1200×240 PNG | 3.4 / 6.8 | `strip` | out |
| `social` | 1080² PNG | 5.0 | `sq` | out |
| `linkedin` | 1584×396 PNG | 5.0 | `linkedin` | out |
| `deck` | 1920×1080 PNG | 5.0 | `cover` | out |
| `postcard` | 1240×1748 PNG, 300 dpi, + separations | 5.0 | `a6` | out |

**Pitch** is the halftone cell in device pixels. A 2x file doubles pixels and
pitch, so both densities show the same screen at the same CSS size. Files a
platform rescales (share cards, social, slides, print) take a coarser 5.0 that
survives some reduction; at 300 dpi that is a 60 lpi screen. The screen stays
the same size in CSS px whatever the format, so in small formats it dominates:
draw those with `weight()` and solid shapes.

**Compositions** are the aspects a plate draws. A plate lists the ones it
handles in `composes`, and a job for a format whose composition is missing
fails before anything is baked. Nothing is ever cropped or resized after the
bake: every format is re-rasterised from the drawing.

## Export

`export.mjs` evaluates each work's JOBS in Node, then opens the work once in
the kit's own browser harness (`tools/lib/browser.mjs`, the one `still.mjs`
uses). Per job it seeks, reads the canvas backing store as PNG, seeks
elsewhere and back and requires identical bytes (the check `still.mjs`
makes), checks the pixel size, and encodes: WebP at quality 95 with sharp-YUV
(compared against the PNG at 2x zoom, it keeps the dot screen: mean absolute
difference 1.6/255), or PNG at maximum compression for formats a scraper or a
print shop reads.

- `site` files go to `public/art/`, are committed, and are refused by the
  pre-commit hook above 1 MB. Only a file a page of this site shows is `site`.
- `out` files go to `art/riso/out/<work>/`, gitignored and reproducible from
  the pin. Upload them where they are used.
- **Separations** (formats with `separations: true`) add one grayscale PNG per
  ink, `<stem>-sep-<n>-<ink>.png`, from the page's `?sep=<ink>` view: that
  ink's screened plate, black on white, no paper, no registration offset (the
  press brings its own). `<stem>-separations.json` names the drum, hex and
  order for the print shop. A riso press leaves about 5 mm unprinted at the
  edge, so the `a6` composition keeps the drawing inside it.

## The manifest

Every export ends by rewriting `src/data/art.json` from the JOBS tables of all
works: one entry per art id (`<work>/<plate>/<format>`) with its CSS size,
alt text and caption in `de` and `en`, and a file per density. The site reads
art only through it (`src/lib/art.ts`), so no page names a file.

Every `src` carries `?v=<first 8 hex of the file's sha256>`. `/art/` is served
with a week's `max-age` (`runtime/cache-control.mjs`) under stable file names,
so a file re-exported in place would otherwise reach a returning visitor up to
eight days late. The query changes whenever the bytes do, and `check.mjs`
fails when a hash in the manifest no longer matches its file.

## Checks

`check.mjs` (fast, no browser, in `npm run check`) fails on: a work without
`PRINT.md`; a missing `LICENSE-NOTICE.md`; a JOBS table that does not
evaluate; a site file not exported; a manifest that differs from what the JOBS
tables and the files give; a file missing, of other pixel size than declared
or over 1 MB; alt text or a caption missing in a locale or still saying TODO;
an orphan in `public/art/`; an unknown art id or any `/art/` path in `src/`.

`verify.mjs` runs the kit's `verify.mjs` on every job, in Chromium and
Firefox: repeated, reordered and cold seeks, and a fresh page drawn in
reverse, must all give identical pixels. Run it after changing a drawing,
`lib/` or the pin. It takes about two minutes for Tafeln and is not in CI.

## Showing a print

The pairs are 1x and 2x of one CSS slot. Show a file only at its CSS size
(`art(id).width`), or at exactly 1/2 or 1/3 of it, with the densities in
`srcset`:

```astro
---
import { art, artFile, artSrcset } from '../lib/art'
const a = art('tafeln/stuetzen/plate')
---
<img src={artFile(a).src} srcset={artSrcset(a)} sizes="(min-width: 768px) 720px, 360px"
     width={a.width} height={a.height} alt={a.alt[locale]} />
```

A 720 CSS px slot on a 1x screen takes the 720 file and on a 2x screen the
1440 file, both one image pixel per device pixel; a 360 slot on a 2x phone
takes the 720 file, also 1:1. Any other slot size resamples the screen into
moiré. It is mild on 3x phones, which get the 1440 file at about 1170 px. No
`object-fit`, and no width that differs from these slots. The paper `#F4F2E8`
is close to the site canvas `#f7f7f3`, so the sheet edge stays quiet without a
frame. `TapedPrint` does all of this for a plate (`src/components/craft/`).

## Tafeln files

| Art id | Plate | Used on |
|---|---|---|
| `tafeln/stuetzen/plate` | I Drei Stützen | Team section |
| `tafeln/stuetzen/og` | I Drei Stützen | Default share image (`defaultOgImage`) |
| `tafeln/stuetzen/banner` | I Drei Stützen | Bautagebuch / blog header |
| `tafeln/schichten/plate` | II Schichten | Cover of "Wie Piloti funktioniert" |
| `tafeln/schleife/plate` | III Schleife | Cover of "Ein System, das aus Ihrem Frust lernt" |
| `tafeln/bauplatz/plate` | IV Bauplatz | 404 page |
| `tafeln/pruefstand/plate` | V Prüfstand | Section "Daten & Transparenz" |
| `tafeln/zeichentisch/plate` | VI Zeichentisch | Section "Nutzung" |
| `tafeln/waage/plate` | VII Waage | Value calculator |
| `tafeln/tuer/plate` | VIII Offene Tür | Contact / become a pilot office |

The "Used on" column is the intended slot. `grep -rn "tafeln/" src` shows where
each one is placed today. About 5.2 MB for 19 files, but a page loads only the
one or two it shows. The heaviest is plate VIII at 2x (957 KB), because its
screened lawn covers most of the frame.
