import type { Locale } from '../i18n/ui'

/**
 * The people behind Piloti. Until the company is incorporated they are also
 * the operator the Impressum names (see `legal.ts`), so this list and that one
 * must not drift: both read from here.
 */
export interface Founder {
  name: string
  role: Record<Locale, string>
}

export const founders: Founder[] = [
  { name: 'Jonathan Uhlemann', role: { de: 'Architektur und Produkt', en: 'Architecture and product' } },
  { name: 'Matthias Bigl', role: { de: 'CTO · Software und KI', en: 'CTO · Software and AI' } },
  { name: 'Ferdinand Rubenbauer', role: { de: 'Business und Vertrieb', en: 'Business and sales' } },
]
