/**
 * Legal-content model — typed, locale-variant legal documents (Impressum,
 * Datenschutzerklärung, terms, AI transparency, subprocessors) rendered by
 * the public `/legal/[slug]` pages.
 *
 * Content lives in `./content/{en,de}.ts`; the German set is the canonical
 * shape and English must structurally match it, mirroring how the i18n
 * dictionaries enforce locale parity.
 */

/** Route slugs for the public legal pages. */
export const legalSlugs = [
  'imprint',
  'privacy',
  'terms',
  'ai-transparency',
  'subprocessors',
] as const

export type LegalSlug = (typeof legalSlugs)[number]

/** Type guard narrowing an arbitrary string to a known {@link LegalSlug}. */
export function isLegalSlug(value: string): value is LegalSlug {
  return (legalSlugs as readonly string[]).includes(value)
}

/** A simple data table (e.g. the subprocessor register). */
export interface LegalTable {
  headers: string[]
  rows: string[][]
}

/** One titled section of a legal document. */
export interface LegalSection {
  /** Section heading; omit for an untitled leading block. */
  heading?: string
  /** Body paragraphs, rendered in order. */
  paragraphs?: string[]
  /** Bullet list rendered after the paragraphs. */
  list?: string[]
  /** Data table rendered after the list. */
  table?: LegalTable
  /** Highlighted notice box (e.g. the model-switching statement). */
  notice?: string
}

/** A complete legal document for one locale. */
export interface LegalDocument {
  title: string
  /** ISO date the document was last revised. */
  updated: string
  /** Short lead-in shown under the title. */
  intro?: string
  sections: LegalSection[]
}

export type LegalContent = Record<LegalSlug, LegalDocument>
