/**
 * Every search page, by section. One file per section; see `src/lib/landing.ts`
 * for the shape and the rules.
 */
import type { LandingEntry, SectionId } from '../../lib/landing'
import { vergleich } from './vergleich'
import { anwendungen } from './anwendungen'
import { fuer } from './fuer'
import { baurecht } from './baurecht'
import { glossar } from './glossar'

export const LANDING: Record<SectionId, LandingEntry[]> = { vergleich, anwendungen, fuer, baurecht, glossar }

/** An entry by `section/slug`, as `related` names it. */
export function landingEntry(ref: string): { section: SectionId; entry: LandingEntry } | undefined {
  const [section, slug] = ref.split('/') as [SectionId, string]
  const entry = LANDING[section]?.find((e) => e.slug === slug)
  return entry ? { section, entry } : undefined
}
