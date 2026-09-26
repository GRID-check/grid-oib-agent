---
name: aiq-piloti-riso
description: Use when the Piloti site, blog, deck, email, social or print needs a picture, illustration, share image, banner, cover, spot icon or empty state, and for any change to the riso art under frontends/web/art/riso (a new work or plate, a re-export, a new format, placing art on a page by id).
license: Apache-2.0
compatibility: Claude Code, Codex, Cursor, OpenCode, and Agent Skills-compatible tools.
metadata:
  version: "0.1.0"
  source-repo: "NVIDIA-AI-Blueprints/aiq"
  tags: "aiq piloti web riso art illustration"
allowed-tools: Read Bash Edit Write
---

# Piloti riso art

Piloti's picture language is a series of procedural risograph prints: Canvas 2D
drawings, screened into real Riso ink plates on warm paper, exported at the
exact pixel size of the slot they fill. Everything runs from `frontends/web`:

| Command | Task | Does |
|---|---|---|
| `node art/riso/setup.mjs` | `task art:setup` | Clone the pinned kit (`art/riso/kit.json`) into `~/.cache/piloti-riso/`, find a browser. Idempotent |
| `node art/riso/new.mjs <work>` | `task art:new -- <work>` | Scaffold `art/riso/<work>/index.html` + `PRINT.md` |
| `node art/riso/export.mjs [--work w] [--only i,id]` | `task art:export -- …` | Bake, check repeatability, encode, write files, rewrite `src/data/art.json` |
| `node art/riso/check.mjs` | `task art:check` | The fast gate; part of `npm run check` |
| `node art/riso/verify.mjs [--work w]` | `task art:verify` | The kit's determinism check, both engines, minutes |

How the pieces fit (engine, series look, formats, manifest, cache busting):
`frontends/web/art/riso/README.md`. Read it before your first export.

## Reuse before you draw

A new picture is a week of someone's attention on the site; a reused plate is
free. In order:

1. An existing art id in `src/data/art.json` already fits the slot: place it.
2. An existing plate fits, in a format it has no job for yet: add the job
   (and, if needed, a composition for that format to its `draw`), export.
3. A new plate in an existing work, when it shares that work's subject.
4. A new work (`new.mjs`), when the subject is new: one work per series.

## The series rules

These are what make eight plates read as one series. `lib/piloti.js` holds
their values; `art/riso/tafeln/PRINT.md#series-principle` holds the reasons.

- **Paper** `#F4F2E8` with the kit's mottle, fibres and flecks. No frame.
- **Inks** are real Riso drums only: Mist `#D5E4C0`, Kelly Green `#67B346`,
  Moss `#68724D`, Hunter Green `#407060`, Bright Red `#F15060`. Darks are
  overprints (Hunter over Moss), never black.
- **Kelly** means something alive (lawn, planting, a lit doorway). **Red** is
  spent at most once per plate, on a meaning (a correction, a surveyor's ribbon).
- **Line** is Hunter, printed solid on the line layer: silhouettes 1.9 units,
  arrises 1.1–1.4, annotation 0.8–1.0, in 1080-unit space. Colour sits in
  screened fields beneath it.
- **Camera and light**: `VIEW_SERIES` (elevation oblique) and `SUN_SERIES`
  (low, front-left, shadows back-right) on every plate; west faces bare stock.
  Ground shadows are one union at Hunter 0.64 (`groundShadow`).
- **Horizon and scale**: the subject sits on a model board or table, never in
  a landscape to the horizon; a 1:100 figure gives scale where there is a site.
- **No text**. The engraved roman numeral is the only glyph; the picture must
  read in both site languages.
- **Our own designs.** Draw generic architectural vocabulary (pilotis, ribbon
  windows, roof gardens) in our own proportions. Never a real building, a
  recognisable signature element, a logo or a copyrighted work: plate I lost a
  Villa Savoye rooftop screen for exactly this (Le Corbusier is in copyright
  in the EU until 2035).

## Workflow

Each step ends when its criterion holds, not when the file saves.

1. **Brief in `PRINT.md`.** Request, slot and art ids, the plate's idea in one
   sentence, inks and why. Done when someone could reject the idea from the
   brief alone.
2. **Prove the hardest frame first.** Draw the plate whose readability is in
   doubt, in the format where it is hardest (usually the smallest or the most
   extreme aspect), before any other plate. Done when that frame reads at
   viewing size; record rejected proofs in `PRINT.md`.
3. **Inspect.** Export (`--only`), then open with Read: the whole frame at
   viewing size in every format, and 1:1 crops of the 2x file at every
   junction, contact point, small detail and the screen itself (crop with
   sharp from `frontends/web/node_modules`). Use `?only=<ink>` in the page for
   one plate at a time. Done when every crop has been looked at and each fix
   re-exported and re-looked at; list what you looked at under "Inspected".
4. **Export** everything: `node art/riso/export.mjs --work <work>`. Done when
   it exits 0; site files over 1 MB fail it (the commit hook's limit).
5. **Check**: `node art/riso/check.mjs` exits 0, and after any change to a
   drawing, the engine or `lib/`, `node art/riso/verify.mjs --work <work>` too.
6. **Place by id** (below), then `npm run check && npm run build` and look at
   the page at 390 and 1440 px wide.
7. **Write down what is still weak** under "Remaining weaknesses". An empty
   list is not believed.

Craft depth (composition, tone that prints, construction before detail, the
quality bar) lives in the kit's own `riso-still` skill, in the pinned clone:
`~/.cache/piloti-riso/riso-windowseat-<commit>/.claude/skills/riso-still/SKILL.md`
(setup prints the path), with `.claude/rules/riso-plates.md` and
`docs/quality-bar.md` beside it. Read it before drawing a new plate.

## Keep a work exportable

- `draw(c, compose)` is pure: randomness only from `c.rng`, `c.sr` or
  `rngFor('<stable key>')`. The plate `name` seeds every stream; freeze it once
  a proof is approved, and never rename a shipped plate.
- Top-level code defines constants only; the canvas is touched inside `draw`.
  `check.mjs` evaluates the page in Node without one.
- Do not redeclare a `lib/` name (`W`, `K`, `INK`, `line`, `own` ...): the
  scripts share one scope.
- Changing `lib/engine.js` or `lib/piloti.js` changes every plate of every
  work. Re-export all works and confirm the committed files come back
  byte-identical (`git status` on `public/art/` stays clean), unless the change
  is meant to alter them.

## Placing art

Pages reach art only by id (`<work>/<plate>/<format>`) through
`src/lib/art.ts`, or `PLATES` in `src/components/craft/plates.ts`; `check.mjs`
fails on a `/art/` path in `src/`. URLs carry `?v=<hash>` from the manifest,
because `/art/` is cached for a week under stable names.

- **Native size only.** Show a file in a slot of its CSS size (`art.width`),
  or exactly 1/2 or 1/3 of it: a plate is 720 CSS px (`size="full"`), 360
  (`half`) or 240 (`third`). Any other width resamples the halftone screen
  into moiré.
- Densities as `srcset` (`artSrcset` gives `720w, 1440w`; TapedPrint uses
  `1x, 2x`). The 2x file is never the default `src`.
- No `object-fit`, no CSS width of your own, no `astro:assets` for riso files.
- `alt` from the manifest (`locale` prop) wherever the picture carries meaning;
  empty alt only where the text beside it already says it all.

## Restraint

One print per section at most, and not in every section. Prints sit beside
text, never behind it, and nothing is laid over a print. A print is never
rotated more than 2°. Before adding one, name what the page loses without it;
if the answer is "nothing", leave it out. `src/components/craft/README.md` has
the rest of the craft rules.

## Adding a format

1. Add it to `art/riso/lib/formats.js`: `compose` (reuse one when the aspect
   matches), `sizes` with density and pitch (3.4 device px per 1x, 6.8 per 2x
   for a slot shown at native size; 5.0 for anything a platform rescales),
   `encode`, `dest` (`site` only for files a page of this site shows), `file`.
2. Give each plate that should wear it a `FIT` framing and, if the plate
   branches on composition, a drawing for it; add the compose to `composes`.
   Below ~400 px wide, draw with `weight()` so lines stay above 1.25 device px,
   and prefer solid shapes to screened tone: the screen is fixed in CSS px, so
   in a small file it dominates.
3. Add the jobs, export, look at the new files, check.
4. Add a row to the formats table in `art/riso/README.md`.
