# Riso plates: Piloti — Tafeln

Procedural risograph prints for the public site. The source is one self-contained
Canvas 2D page, `tafeln/index.html`: no libraries, fonts, images or network calls.
Design decisions, measurements and known weaknesses are in
[`tafeln/PRINT.md`](tafeln/PRINT.md). Third-party code: [`LICENSE-NOTICE.md`](LICENSE-NOTICE.md).

The exported files live in `public/art/`, not `src/assets/`. Astro's image pipeline
would resize them, and resizing a halftone screen makes moiré. Every file is baked at
the exact pixel size it is shown at; see "Showing them" below.

## Re-export

The exports use the `tools/` harness of the MIT kit
[sevenevesai/riso-windowseat](https://github.com/sevenevesai/riso-windowseat)
(built against commit `1275fdaf`). Clone it anywhere outside this repo; the
commands below assume `/tmp/claude-0/riso-windowseat`.

```bash
git clone https://github.com/sevenevesai/riso-windowseat /tmp/claude-0/riso-windowseat
cd /tmp/claude-0/riso-windowseat/tools && npm install && npm run setup && npm test

cd frontends/web                   # needs node_modules (npm ci): export.mjs uses sharp
node art/riso/export.mjs --kit /tmp/claude-0/riso-windowseat/tools            # all jobs
node art/riso/export.mjs --kit /tmp/claude-0/riso-windowseat/tools --only 0,1 # some jobs
```

`export.mjs` reads the `JOBS` table in `tafeln/index.html`. Each job is one integer
time of the page and one output file. For each job it runs the kit's `still.mjs` in
Firefox, which fails if the frame changes after another seek. Then it checks the pixel
size and encodes the file: `.webp` at quality 95 with sharp-YUV, or `.png` at maximum
compression for the OG card, because not every link-preview scraper reads WebP.
Quality 95 was compared against the PNG at 2x zoom and keeps the dot screen (mean
absolute difference 1.6/255).

Determinism check, after any change to the source:

```bash
cd /tmp/claude-0/riso-windowseat/tools
node verify.mjs <repo>/frontends/web/art/riso/tafeln/index.html --times 0,1,2,3,4
```

To look at one job in a browser, open `tafeln/index.html?t=<job>`. Debug views:
`?only=<ink>` bakes a single plate (`mist`, `kelly`, `moss`, `hunter`, `red`).

## Files and where they go

| File | Size | Plate | Intended use |
|---|---|---|---|
| `piloti-i-stuetzen-720.webp` / `-1440.webp` | 720² / 1440² | I Drei Stützen | Team section |
| `piloti-i-stuetzen-og-1200x630.png` | 1200×630 | I Drei Stützen | Social share (`og:image`) |
| `piloti-i-stuetzen-banner-800x300.webp` / `-1600x600.webp` | 800×300 / 1600×600 | I Drei Stützen | Bautagebuch / blog header |
| `piloti-ii-schichten-720.webp` / `-1440.webp` | 720² / 1440² | II Schichten | Cover of "Wie Piloti funktioniert" / "How Piloti works" |
| `piloti-iii-schleife-720.webp` / `-1440.webp` | 720² / 1440² | III Schleife | Cover of "Ein System, das aus Ihrem Frust lernt" |
| `piloti-iv-bauplatz-720.webp` / `-1440.webp` | 720² / 1440² | IV Bauplatz | 404 page ("Nicht im Plan") |
| `piloti-v-pruefstand-720.webp` / `-1440.webp` | 720² / 1440² | V Prüfstand | Section "Daten & Transparenz" |
| `piloti-vi-zeichentisch-720.webp` / `-1440.webp` | 720² / 1440² | VI Zeichentisch | Section "Nutzung" |
| `piloti-vii-waage-720.webp` / `-1440.webp` | 720² / 1440² | VII Waage | Value calculator "Wert" |
| `piloti-viii-tuer-720.webp` / `-1440.webp` | 720² / 1440² | VIII Offene Tür | "Kontakt / Pilotbüro werden" |

## Showing them

The pairs are 1x and 2x of one CSS slot: 720 CSS px for the squares, 800 CSS px wide
for the banner. Serve them so the browser picks a file it can show without resizing:

```html
<img src="/art/piloti-i-stuetzen-720.webp"
     srcset="/art/piloti-i-stuetzen-720.webp 720w, /art/piloti-i-stuetzen-1440.webp 1440w"
     sizes="(min-width: 768px) 720px, 360px"
     width="720" height="720" alt="…">
```

A 720 CSS px slot on a 1x screen takes the 720 file, and on a 2x screen the 1440 file,
both at one image pixel per device pixel. A 360 CSS px slot on a 2x phone takes the
720 file, also 1:1. Any other slot size makes the browser resample the screen and some
moiré will show. It is mild at 3x phones, which get the 1440 file shrunk to about 1170
px. Do not set `object-fit: cover` or a width that differs from these slots. The
paper colour is `#F4F2E8`, close to the site canvas `#f7f7f3`, so the sheet edge stays
quiet without a frame.
