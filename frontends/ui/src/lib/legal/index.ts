/**
 * Legal-content accessor — resolves a legal document for a locale and slug,
 * and exposes the ordered navigation entries the legal pages and footers use.
 */

import type { Locale } from '@/i18n'
import { de } from './content/de'
import { en } from './content/en'
import { legalSlugs, type LegalContent, type LegalDocument, type LegalSlug } from './types'

const contentByLocale: Record<Locale, LegalContent> = { en, de }

/** The legal document for a locale and slug. */
export function getLegalDocument(locale: Locale, slug: LegalSlug): LegalDocument {
  return contentByLocale[locale][slug]
}

/** Ordered `{slug, title}` entries for legal-page navigation in a locale. */
export function legalNavEntries(locale: Locale): Array<{ slug: LegalSlug; title: string }> {
  return legalSlugs.map((slug) => ({ slug, title: contentByLocale[locale][slug].title }))
}
