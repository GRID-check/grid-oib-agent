/* ─────────────────────────────────────────────────────────────────────────────
   Every slot a riso work can be exported for, by name. A work's JOBS table
   names a format; it never states a pixel size.

   A classic script, because the page must read it over file:// (where fetch
   of a .json is blocked); export.mjs and new.mjs read the same file in Node.

   Per format:
     compose    the composition a plate draws for it (its aspect). Plates
                declare which compositions they draw; several formats share one
     sizes      one entry per density: exact pixels and screen pitch in device
                px. A 2x twin doubles pixels and pitch, so both show the same
                screen at the same CSS size. Nothing is ever resized after
                the bake: resampling a halftone screen makes moiré
     encode     'webp' (quality 95, sharp-YUV) or 'png' (max compression)
     dest       'site' -> frontends/web/public/art/, committed, in the manifest
                'out'  -> art/riso/out/<work>/, gitignored, reproducible
     file       name template: {base} {w} {h}
     numeral    false leaves the plate numeral off (tiny formats)
     separations  also write one grayscale PNG per ink for a riso print shop
     use        where it goes; the pitch reasoning is in art/riso/README.md

   Adding a format: add it here, give the plates that should wear it a
   composition of that name, then export and check. See the aiq-piloti-riso skill.
   ───────────────────────────────────────────────────────────────────────── */
'use strict';

const FORMATS = {
  plate: {
    use: 'Section plate: 720 CSS px (or 360/240 at half/third) square',
    compose: 'sq', encode: 'webp', dest: 'site', file: '{base}-{w}',
    sizes: [{ density: 1, w: 720, h: 720, pitch: 3.4 }, { density: 2, w: 1440, h: 1440, pitch: 6.8 }],
  },
  og: {
    use: 'Open Graph / Twitter share card. Platforms scale it, so a coarser screen that survives reduction; PNG because not every scraper reads WebP',
    compose: 'og', encode: 'png', dest: 'site', file: '{base}-og-{w}x{h}',
    sizes: [{ density: 1, w: 1200, h: 630, pitch: 5.0 }],
  },
  banner: {
    use: 'Page or blog-category header, 800 CSS px wide',
    compose: 'wide', encode: 'webp', dest: 'site', file: '{base}-banner-{w}x{h}',
    sizes: [{ density: 1, w: 800, h: 300, pitch: 3.4 }, { density: 2, w: 1600, h: 600, pitch: 6.8 }],
  },
  cover: {
    use: 'Blog post cover, 720 CSS px wide, 16:9',
    compose: 'cover', encode: 'webp', dest: 'site', file: '{base}-cover-{w}x{h}',
    sizes: [{ density: 1, w: 720, h: 405, pitch: 3.4 }, { density: 2, w: 1440, h: 810, pitch: 6.8 }],
  },
  spot: {
    use: 'Spot illustration or icon, 96 CSS px square. Needs its own composition with heavy lines',
    compose: 'spot', encode: 'webp', dest: 'site', file: '{base}-spot-{w}', numeral: false,
    sizes: [{ density: 1, w: 96, h: 96, pitch: 3.4 }, { density: 2, w: 192, h: 192, pitch: 6.8 }],
  },
  empty: {
    use: 'Empty state in the product UI, 320 CSS px square. A quiet vignette, not a full plate',
    compose: 'empty', encode: 'webp', dest: 'site', file: '{base}-empty-{w}', numeral: false,
    sizes: [{ density: 1, w: 320, h: 320, pitch: 3.4 }, { density: 2, w: 640, h: 640, pitch: 6.8 }],
  },
  email: {
    use: 'Email signature strip, 600 CSS px wide. Hosted by whoever sends the mail, so not a site asset',
    compose: 'strip', encode: 'png', dest: 'out', file: '{base}-email-{w}x{h}', numeral: false,
    sizes: [{ density: 1, w: 600, h: 120, pitch: 3.4 }, { density: 2, w: 1200, h: 240, pitch: 6.8 }],
  },
  social: {
    use: 'Social post, square (Instagram, LinkedIn feed). Platforms recompress, so PNG and the og pitch',
    compose: 'sq', encode: 'png', dest: 'out', file: '{base}-social-{w}',
    sizes: [{ density: 1, w: 1080, h: 1080, pitch: 5.0 }],
  },
  linkedin: {
    use: 'LinkedIn page/profile banner, 4:1',
    compose: 'linkedin', encode: 'png', dest: 'out', file: '{base}-linkedin-{w}x{h}',
    sizes: [{ density: 1, w: 1584, h: 396, pitch: 5.0 }],
  },
  deck: {
    use: 'Full-bleed slide, 16:9 (shares the blog cover composition)',
    compose: 'cover', encode: 'png', dest: 'out', file: '{base}-deck-{w}x{h}',
    sizes: [{ density: 1, w: 1920, h: 1080, pitch: 5.0 }],
  },
  postcard: {
    use: 'A6 portrait postcard at 300 dpi (105 x 148 mm), 60 lpi screen; plus one separation per ink for a riso print shop',
    compose: 'a6', encode: 'png', dest: 'out', file: '{base}-a6-{w}x{h}', separations: true, dpi: 300,
    sizes: [{ density: 1, w: 1240, h: 1748, pitch: 5.0 }],
  },
};
