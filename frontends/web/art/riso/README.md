# Riso art

Procedural risograph prints for Piloti: the site's picture language, and the
source for decks, email, social posts and printed postcards. Each **work** is a
folder here with one Canvas 2D page (`index.html`) and its design record
(`PRINT.md`). No libraries, fonts, images or network calls in any of it.

This file is how to make a print, how the machinery works, and how a page
shows one.

| Path | Holds |
|---|---|
| `tafeln/` | Plates I–VIII of the first series. Its `PRINT.md` states the series principle every work follows |
| `collateral/` | The founders' kit off the site: email strip and signatures (`signatures/*.html`), a build-log square, deck slides and the thank-you postcard (still lifes on plate VI's tipped table). Its `PRINT.md` maps every piece, including the Tafeln plates reused for LinkedIn and social |
| `lib/engine.js` | The print engine: screens, paper, starvation, the bake, the `window.__riso` contract, `Riso.run` |
| `lib/piloti.js` | The series look: inks, paper, screen angles, registration, camera, sun, projection, props |
| `lib/formats.js` | Every export slot by name, with pixel sizes, pitch, encoding and destination |
| `kit.json` | The pinned riso-windowseat commit. The only place the version is written |
| `setup.mjs`, `new.mjs`, `export.mjs`, `check.mjs`, `verify.mjs` | The commands below; `kit.mjs` is what they share |
| `downloads.mjs` | Publishes every `out` and `app` file into `public/downloads/` with its manifest `src/data/downloads.json`, for the unlisted image page. `export.mjs` runs it |
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
node art/riso/export.mjs --variant page         # only the on-page files (or: paper)
node art/riso/export.mjs --manifest             # rewrite src/data/art.json only
node art/riso/downloads.mjs                     # re-publish out/ and app files to public/downloads/
node art/riso/check.mjs                         # task art:check, also in npm run check
node art/riso/verify.mjs --work tafeln          # task art:verify (minutes)
```

To look at a job, open `<work>/index.html?t=<job>` in Firefox. Views by query
string: `?only=<ink>` one plate in colour, `?sep=<ink>` the press separation,
`?paper=0` the inks alone on white (what the on-page file is made from),
`?debug=lines` where a plate implements it.

## Making a print

**Reuse before you draw.** A new picture is a week of someone's attention; a
reused plate is free. In order:

1. An art id in `src/data/art.json` already fits the slot: place it.
2. An existing plate fits in a format it has no job for yet: add the job (and,
   if needed, a composition for that format to its `draw`), then export.
3. A new plate in an existing work, when it shares that work's subject.
4. A new work (`new.mjs`), when the subject is new: one work per series.

**The series rules** are what make the plates read as one series.
`lib/piloti.js` holds the values and
[`tafeln/PRINT.md`](tafeln/PRINT.md#series-principle) the reasons.

- Paper `#F4F2E8` with the kit's mottle, fibres and flecks, and no frame.
- Real Riso drums only: Mist `#D5E4C0`, Kelly Green `#67B346`, Moss `#68724D`,
  Hunter Green `#407060`, Bright Red `#F15060`. Darks are overprints (Hunter
  over Moss), never black. Kelly means something alive; Red is spent at most
  once per plate, on a meaning.
- Line is Hunter, solid on the line layer: silhouettes 1.9 units, arrises
  1.1–1.4, annotation 0.8–1.0, in 1080-unit space, with colour in screened
  fields beneath it.
- Every plate uses `VIEW_SERIES` and `SUN_SERIES` (low, front-left, shadows
  back-right); west faces stay bare stock, and ground shadows are one union at
  Hunter 0.64 (`groundShadow`).
- The subject sits on a model board or a table, never in a landscape to the
  horizon; a 1:100 figure gives scale where there is a site.
- No text. The engraved roman numeral is the only glyph, so the picture reads
  in both site languages.
- Our own designs: generic architectural vocabulary in our own proportions,
  never a real building, a recognisable signature element, a logo or a
  copyrighted work. Plate I lost a Villa Savoye rooftop screen for this; Le
  Corbusier is in copyright in the EU until 2035.

**The workflow.** Each step ends when its criterion holds, not when the file
saves.

1. Write the brief in the work's `PRINT.md`: the request, the slot and art ids,
   the plate's idea in one sentence, the inks and why. Done when someone could
   reject the idea from the brief alone.
2. Prove the hardest frame first: the plate whose readability is in doubt, in
   the format where it is hardest (usually the smallest or the most extreme
   aspect). Done when that frame reads at viewing size; record rejected proofs
   in `PRINT.md`.
3. Inspect. Export with `--only`, then look at the whole frame at viewing size
   in every format, and at 1:1 crops of the 2x file at every junction, contact
   point and small detail and at the screen itself (crop with the sharp in
   `frontends/web/node_modules`; `?only=<ink>` shows one plate at a time). List
   what you looked at under "Inspected" in `PRINT.md`.
4. Export the work. Site files over 1 MB fail the export, which is the commit
   hook's limit.
5. `check.mjs` exits 0, and after any change to a drawing, the engine or
   `lib/`, `verify.mjs --work <work>` does too.
6. Place it by id ([Showing a print](#showing-a-print)), run
   `npm run check && npm run build`, and look at the page at 390 and 1440 px.
7. Write what is still weak under "Remaining weaknesses". An empty list is not
   believed.

The craft depth (composition, tone that prints, construction before detail,
the quality bar) is the kit's own `riso-still` guide, in the pinned clone at
`<kit>/.claude/skills/riso-still/SKILL.md` (setup prints the path), with
`.claude/rules/riso-plates.md` and `docs/quality-bar.md` beside it. Read it
before drawing a new plate.

**Keep a work exportable.**

- `draw(c, compose)` is pure: randomness only from `c.rng`, `c.sr` or
  `rngFor('<stable key>')`. The plate `name` seeds every stream, so freeze it
  once a proof is approved and never rename a shipped plate.
- Top-level code defines constants only and touches the canvas inside `draw`:
  `check.mjs` evaluates the page in Node, without one.
- Changing `lib/engine.js` or `lib/piloti.js` changes every plate of every
  work. Re-export all works and confirm `public/art/` comes back
  byte-identical, unless the change is meant to alter them.

**Adding a format.**

1. Add it to `lib/formats.js`: `compose` (reuse one when the aspect matches),
   `sizes` with density and pitch (3.4 device px per 1x and 6.8 per 2x for a
   slot shown at native size, 5.0 for anything a platform rescales), `encode`,
   `dest` (`site` only for files a page of this site shows) and `file`.
2. Give each plate that should wear it a `FIT` framing, a drawing for the
   composition if the plate branches on it, and the compose in its `composes`.
   Below about 400 px wide, draw with `weight()` so lines stay above 1.25
   device px, and prefer solid shapes to screened tone.
3. If a page will show it bare, give it `onPage: true`, so the export writes the
   on-page twin and `check.mjs` holds the two together.
4. Add the jobs, export, look at the new files, check, and add a row to
   [Formats](#formats) below.

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
| `plate` | 720², 1440², + on page | 3.4 / 6.8 | `sq` | site |
| `og` | 1200×630 PNG | 5.0 | `og` | site |
| `banner` | 800×300, 1600×600 | 3.4 / 6.8 | `wide` | site |
| `cover` | 720×405, 1440×810, + on page | 3.4 / 6.8 | `cover` | site |
| `spot` | 96², 192² | 3.4 / 6.8 | `spot` | site |
| `empty` | 320², 640² | 3.4 / 6.8 | `empty` | app (frontends/ui) |
| `release` | 64², 128², + on page | 2.4 / 4.8 | `stamp` | site |
| `email` | 600×120, 1200×240 PNG | 3.4 / 6.8 | `strip` | site (mail clients load it from piloti.at) |
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
difference 1.6/255), or PNG for formats a scraper or a print shop reads. A
committed PNG (`site`, `app`: the share cards, the email strip) is quantised
to a 256-colour palette to stay under 1 MB; an `out` PNG and every separation
are lossless (truecolour, or 8-bit grayscale).

- `site` files go to `public/art/`, are committed, and are refused by the
  pre-commit hook above 1 MB. Only a file a page of this site shows is `site`.
- `app` files go to the product app, `frontends/ui/public/art/`, committed
  under the same 1 MB limit, with their own manifest at
  `frontends/ui/src/lib/art/art.json`. The app is a second consumer, not a
  second source: the files are exported from a work here like every other,
  and `check.mjs` holds both manifests, both folders (orphans) and both source
  trees (ids, no `/art/` paths) to the JOBS tables. The app reads art through
  `src/lib/art/` and `components/brand/riso-print.tsx`.
- `out` files go to `art/riso/out/<work>/`, gitignored and reproducible from
  the pin. Upload them where they are used.
- **Downloads.** Every export ends with `downloads.mjs`, which copies each
  `out` and `app` file into `public/downloads/` (committed, so the unlisted
  image page can hand them out: `frontends/web/AGENTS.md`, "Unlisted pages")
  and writes `src/data/downloads.json`. A PNG within 1 MB is copied as it is;
  a larger one (the slides, the postcard composite) becomes JPEG q95 4:4:4,
  which every slide tool, LinkedIn and print shop reads (mean error 0.6–1.9
  of 255 against the PNG). Separations are never re-encoded. `check.mjs` fails
  on a job without its download, an orphan there, or a stale manifest.
- **Separations** (formats with `separations: true`) add one grayscale PNG per
  ink, `<stem>-sep-<n>-<ink>.png`, from the page's `?sep=<ink>` view: that
  ink's screened plate, black on white, no paper, no registration offset (the
  press brings its own). `<stem>-separations.json` names the drum, hex and
  order for the print shop. A riso press leaves about 5 mm unprinted at the
  edge, so the `a6` composition keeps the drawing inside it.
- **On page** (formats with `onPage: true`: `plate`, `cover`, `release`) add
  `<file>-page.webp` beside each file: the same inks with no paper, for a
  print shown bare on the page. The job is baked a second time with
  `?paper=0`, which multiplies the registered inks onto white instead of the
  paper, so each pixel holds what the ink stack lets through, T per channel.
  `pageFrom()` in `export.mjs` turns that into straight RGBA: alpha
  `1 − min(T)`, colour `1 − (1 − T) / alpha`, transparent where no ink lies.
  With `mix-blend-mode: multiply` that is exactly `backdrop × T`: the print on
  whatever lies below. Same seek, screens and registration as the paper file,
  which stays byte-identical. The on-page files are about 13 % lighter in
  total (4.9 MB against 5.6 MB), and closer to the lossless bake on ink
  pixels than the paper WebP (plate VII: 4.1 against 7.5 levels), because
  chroma subsampling no longer mixes each dot with the paper around it.

## The manifest

Every export ends by rewriting `src/data/art.json` (and, for `app` formats,
`frontends/ui/src/lib/art/art.json`) from the JOBS tables of all works: one entry per art id (`<work>/<plate>/<format>`) with its CSS size,
alt text and caption in `de` and `en`, and a file per density; an `onPage`
format adds `page`, its on-page twins at the same densities. The site reads
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
an orphan in `public/art/`; an unknown art id or any `/art/` path in `src/`;
an on-page file missing, without alpha, at other densities or sizes than its
paper twin, or out of parity with it. Parity: multiplied onto the flat paper
colour, the on-page file must land within 40 levels of the paper file on all
but 0.5 % of pixels. The paper's mottling and WebP stay inside that (at most
0.03 % beyond it, measured); one pixel out of register puts 3–19 % beyond it.

`verify.mjs` runs the kit's `verify.mjs` on every job, in Chromium and
Firefox: repeated, reordered and cold seeks, and a fresh page drawn in
reverse, must all give identical pixels. Run it after changing a drawing,
`lib/` or the pin. It takes about two minutes for Tafeln and is not in CI.

## Showing a print

**Two modes, and only two.**

- **On page**, the default, for every print shown bare: a section plate, the
  changelog's stamps, a blog cover on a Journal card or a post. The
  on-page file, `art(id, { onPage: true })`, with `mix-blend-mode: multiply`,
  so the inks print into the page and its drawing grid and no sheet stands on
  it. `PagePrint` (`src/components/craft/`) does this for a plate. On a dark
  panel multiply sinks the inks, so `<PagePrint tone="dark">` shows the print
  reversed, a negative in its own hues, with `screen`.
- **Taped print**, `TapedPrint`: the print keeps its paper, because it is an
  object lying on the page, with tape and a white margin. At most one per
  page: the Team section's Tragwerk II, and an uploaded photographic post
  cover. A riso post cover is on page, at every width.

A paper file shown bare is a beige box a shade darker than the canvas (the
paper is `#F4F2E8` and mottled to about 225–250; the canvas is `#f7f7f3`):
exactly what the founders objected to. `multiply` on a paper file cannot fix
it without washing the inks, which is why the on-page file exists.

The pairs are 1x and 2x of one CSS slot. Show a file only at its CSS size
(`art(id).width`), or at exactly 1/2 or 1/3 of it, with the densities in
`srcset`:

```astro
---
import { art, artFile, artSrcset } from '../lib/art'
const a = art('tafeln/stuetzen/plate', { onPage: true })
---
<img src={artFile(a).src} srcset={artSrcset(a)} sizes="(min-width: 768px) 720px, 360px"
     width={a.width} height={a.height} alt={a.alt[locale]} class="mix-blend-multiply" />
```

A 720 CSS px slot on a 1x screen takes the 720 file and on a 2x screen the
1440 file, both one image pixel per device pixel; a 360 slot on a 2x phone
takes the 720 file, also 1:1. Any other slot size resamples the screen into
moiré. It is mild on 3x phones, which get the 1440 file at about 1170 px. No
`object-fit`, and no width that differs from these slots. `PagePrint` and
`TapedPrint` do all of this for a plate (`src/components/craft/`).

The 2x file is never the default `src`, and a riso file never goes through
`astro:assets`. Take `alt` from the manifest wherever the picture carries
meaning; leave it empty only where the text beside it already says all of it.

## Tafeln files

| Art id | Plate | Used on |
|---|---|---|
| `tafeln/stuetzen/plate` | I Drei Stützen | Not placed (Team wears `tragwerk/drei/plate`) |
| `tafeln/stuetzen/og` | I Drei Stützen | Not placed (the landing card is `tragwerk/saeule/og`) |
| `tafeln/stuetzen/banner` | I Drei Stützen | Bautagebuch / blog header |
| `tafeln/schichten/plate` | II Schichten | Section "Quellen und Daten", on the page |
| `tafeln/schichten/og`, `…/cover` | II Schichten | "Wie Piloti funktioniert": share card and cover; the Bautagebuch share card |
| `tafeln/schleife/plate` | III Schleife | Not on a page yet (its cover and share card are) |
| `tafeln/schleife/og`, `…/cover` | III Schleife | "Ein System, das aus Ihrem Frust lernt": share card and cover |
| `tafeln/bauplatz/plate` | IV Bauplatz | Changelog, beside the heading (the 404 wears `tragwerk/ziegel/plate`) |
| `tafeln/bauplatz/og` | IV Bauplatz | Changelog share card |
| `tafeln/pruefstand/plate` | V Prüfstand | Rechenweg, beside the heading |
| `tafeln/pruefstand/og` | V Prüfstand | Share card of the legal pages |
| `tafeln/zeichentisch/plate` | VI Zeichentisch | Section "Nutzung" |
| `tafeln/zeichentisch/og` | VI Zeichentisch | Share card of the blog index (the Journal's is `tragwerk/ordnung/og`) |
| `tafeln/waage/plate` | VII Waage | Value calculator |
| `tafeln/waage/og` | VII Waage | Rechenweg share card |
| `tafeln/tuer/plate` | VIII Offene Tür | Contact / become a pilot office |
| `tafeln/tuer/og`, `…/cover` | VIII Offene Tür | "Willkommen im Piloti-Blog": share card and cover |

Share cards are mapped per page type in `SHARE_ART` (`src/lib/seo.ts`) and per
post by its `plate` frontmatter field (`COVER_PLATES` in
`src/components/craft/plates.ts`). No two page types share one: every preview
showing plate I's house was the founders' complaint.

The "Used on" column is the intended slot. `grep -rn "tafeln/" src` shows where
each one is placed today. About 5.2 MB for 19 files, but a page loads only the
one or two it shows. The heaviest is plate VIII at 2x (957 KB), because its
screened lawn covers most of the frame.
