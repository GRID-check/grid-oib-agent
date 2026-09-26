/**
 * The riso plates, by number: the one place that knows their file names.
 *
 * The files are made by the riso kit and live in `public/art/` as
 * `<name>.png` (720 px, the 1x of a 720 CSS px slot) and `<name>@2x.png`
 * (1440 px). TapedPrint builds both URLs from the base name here, so renaming
 * a plate is one edit in this file.
 *
 * A plate listed here whose file is not (yet) in `public/art/` is skipped at
 * build time with a warning, never rendered as a broken image.
 */
export const PLATES = {
  /** Drei Stützen / Three columns: the Team section. */
  I: 'plate-1',
  /** Schichten / Layers: Datengrundlage, and Journal posts without a cover. */
  II: 'plate-2',
  /** Build-log posts without a cover. */
  III: 'plate-3',
  /** Bauplatz / Building site: the 404 page. */
  IV: 'plate-4',
} as const

export type PlateName = (typeof PLATES)[keyof typeof PLATES]
