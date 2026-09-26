/**
 * The riso plates: the one place that knows their file names.
 *
 * The files are made by the riso kit and live in `public/art/` as
 * `<name>-720.webp` (the 1x of a 720 CSS px slot) and `<name>-1440.webp`
 * (the 2x). TapedPrint builds both URLs from the base name here, so renaming
 * a plate is one edit in this file. List a plate only once its file exists; a
 * listed plate whose file is missing is left out at build time with a warning.
 */
export const PLATES = {
  /** Drei Stützen / Three columns: the Team section. */
  I: 'piloti-i-stuetzen',
  /** Schichten / Layers: the post on how Piloti works. */
  II: 'piloti-ii-schichten',
} as const

export type PlateName = (typeof PLATES)[keyof typeof PLATES]

/** Blog posts (by slug, both locales) that wear a plate as their cover. */
export const POST_PLATES: Record<string, PlateName | undefined> = {
  'wie-piloti-funktioniert': PLATES.II,
  'how-piloti-works': PLATES.II,
}
