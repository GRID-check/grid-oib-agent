/**
 * The riso plates of the Tafeln series by number, as art ids.
 *
 * Files, sizes, alt text and captions live in `src/data/art.json`, which
 * `art/riso/export.mjs` generates (see `src/lib/art.ts`). Pages name a plate
 * here or by its id, never by file path.
 */
import type { ArtId } from '../../lib/art'

export const PLATES = {
  /** Drei Stützen / Three columns: the Team section. */
  I: 'tafeln/stuetzen/plate',
  /** Schichten / Layers: the sources section, and the post on how Piloti works. */
  II: 'tafeln/schichten/plate',
  /** Schleife / Loop: the post on learning from corrections. */
  III: 'tafeln/schleife/plate',
  /** Bauplatz / Building plot: the 404 page. */
  IV: 'tafeln/bauplatz/plate',
  /** Prüfstand / Test bench: for the blog (the sources section wears II). */
  V: 'tafeln/pruefstand/plate',
  /** Zeichentisch / Drafting table: how Piloti is used. */
  VI: 'tafeln/zeichentisch/plate',
  /** Waage / Balance: the value calculator. */
  VII: 'tafeln/waage/plate',
  /** Offene Tür / Open door: contact, become a pilot office. */
  VIII: 'tafeln/tuer/plate',
} as const satisfies Record<string, ArtId>

export type PlateName = (typeof PLATES)[keyof typeof PLATES]

type CoverArtId = Extract<ArtId, `${string}/cover`>
type OgArtId = Extract<ArtId, `${string}/og`>

/**
 * The plates a blog post can wear, by the value of its `plate` frontmatter
 * field: the cover on the post, its card and its log entry, and the share
 * card in the same drawing. Only plates exported in both formats are listed,
 * so a post cannot pick one that would leave its share card on the default.
 *
 * The content schema (`content.config.ts`), the Keystatic select and
 * `scripts/lint-content.mjs` all read `COVER_PLATE_IDS`; `satisfies` makes
 * `astro check` refuse an id the manifest does not have.
 */
export const COVER_PLATES = {
  schichten: {
    label: 'II · Schichten',
    cover: 'tafeln/schichten/cover',
    og: 'tafeln/schichten/og',
  },
  schleife: {
    label: 'III · Schleife',
    cover: 'tafeln/schleife/cover',
    og: 'tafeln/schleife/og',
  },
  tuer: {
    label: 'VIII · Offene Tür',
    cover: 'tafeln/tuer/cover',
    og: 'tafeln/tuer/og',
  },
} as const satisfies Record<string, { label: string; cover: CoverArtId; og: OgArtId }>

export type CoverPlate = keyof typeof COVER_PLATES
export const COVER_PLATE_IDS = Object.keys(COVER_PLATES) as [CoverPlate, ...CoverPlate[]]
