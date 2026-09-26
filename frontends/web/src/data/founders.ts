import type { ImageMetadata } from 'astro'
import type { Locale } from '../i18n/ui'
import ferdinand from '../assets/team/ferdinand-rubenbauer.webp'
import jonathan from '../assets/team/jonathan-uhlemann.webp'
import matthias from '../assets/team/matthias-bigl.webp'

/**
 * The people behind Piloti. Until the company is incorporated they are also
 * the operator the Impressum names (see `legal.ts`), so this list and that one
 * must not drift: both read from here.
 */
export interface Founder {
  name: string
  role: Record<Locale, string>
  /**
   * A square portrait in the site's duotone, built by
   * `scripts/build-team-photos.mjs` from `src/assets/team/originals/`. Without
   * one, the Team section draws the founder's monogram instead.
   */
  photo?: ImageMetadata
}

export const founders: Founder[] = [
  {
    name: 'Jonathan Uhlemann',
    role: { de: 'Architektur und Produkt', en: 'Architecture and product' },
    photo: jonathan,
  },
  {
    name: 'Matthias Bigl',
    role: { de: 'CTO · Software und KI', en: 'CTO · Software and AI' },
    photo: matthias,
  },
  {
    name: 'Ferdinand Rubenbauer',
    role: { de: 'Business und Vertrieb', en: 'Business and sales' },
    photo: ferdinand,
  },
]
