/**
 * The blog's two strands, defined once. The content schema, the Keystatic
 * select, the listing routes, the chips and scripts/lint-content.mjs all read
 * this file, so adding a category here is the whole change on the data side.
 *
 * Kept free of runtime imports: keystatic.config.ts and the Node content lint
 * load it outside Astro (the lint through Node's type stripping).
 */
import type { Locale } from '../i18n/ui'

/** Stored in each post's frontmatter as `category`, and used as the URL segment. */
export const CATEGORY_IDS = ['journal', 'bautagebuch'] as const
export type Category = (typeof CATEGORY_IDS)[number]

/** What Keystatic preselects for a new entry. */
export const DEFAULT_CATEGORY: Category = 'journal'

interface CategoryCopy {
  /** Chip, filter and listing heading. */
  label: string
  /** One line under the heading: who the strand is for. */
  descriptor: string
  /** Heading of the "more from this category" block on a post. */
  more: string
  /** Link from that block to the full listing. */
  viewAll: string
}

export const CATEGORIES: Record<Locale, Record<Category, CategoryCopy>> = {
  de: {
    journal: {
      label: 'Journal',
      descriptor: 'Für Büros: Planungspraxis, Baurecht und was Piloti im Alltag ändert.',
      more: 'Mehr aus dem Journal',
      viewAll: 'Das ganze Journal →',
    },
    bautagebuch: {
      label: 'Bautagebuch',
      descriptor: 'Notizen aus der Entwicklung: wie Piloti gebaut ist und warum.',
      more: 'Mehr aus dem Bautagebuch',
      viewAll: 'Das ganze Bautagebuch →',
    },
  },
  en: {
    journal: {
      label: 'Journal',
      descriptor: 'For offices: planning practice, building law and what Piloti changes day to day.',
      more: 'More from the Journal',
      viewAll: 'The whole Journal →',
    },
    bautagebuch: {
      label: 'Build log',
      descriptor: 'Notes from development: how Piloti is built, and why.',
      more: 'More from the build log',
      viewAll: 'The whole build log →',
    },
  },
}

/** `/blog/` or `/blog/bautagebuch/`, prefixed with `/en` for English. */
export function blogPath(locale: Locale, category?: Category) {
  const base = locale === 'en' ? '/en/blog/' : '/blog/'
  return category ? `${base}${category}/` : base
}
