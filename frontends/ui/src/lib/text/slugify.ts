/**
 * A lowercase ASCII slug from a human-written name: `Straßenbau Süd / Los 2`
 * becomes `strassenbau-sued-los-2`.
 *
 * {@link latinize} spells the letters (`ß` → `ss`, `ü` → `ue`, `Ø` → `Oe`),
 * then every run of anything outside `[a-z0-9]` is one hyphen, and no hyphen
 * leads or trails. With `max`, the slug is cut to that length and a hyphen the
 * cut exposed is dropped too, so a slug never ends in one.
 *
 * `''` when nothing Latin survives; the caller decides the fallback.
 *
 * Who does NOT use it, on purpose:
 * - `lib/storage/bucket.ts` slugs an organization id into a bucket name, and a
 *   change in derivation would rename live buckets.
 * - `lib/bim/bcf.ts` keeps case in its download name and cuts without trimming
 *   the exposed hyphen; moving it here would change names already downloaded.
 * - `lib/conversations/draft-filing.ts` does not latinize, and its reference is
 *   minted identically by the agent tier (`filing_reference` in Python): the
 *   two must change together or not at all.
 */

import { latinize } from './latinize'

export interface SlugifyOptions {
  /** Cut to at most this many characters, never ending in a hyphen. */
  readonly max?: number
}

export function slugify(value: string, options: SlugifyOptions = {}): string {
  const slug = latinize(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (options.max === undefined) return slug
  return slug.slice(0, options.max).replace(/-+$/, '')
}
