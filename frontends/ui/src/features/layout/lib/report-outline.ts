/**
 * The outline of a finished report — its `##`/`###` headings, in document
 * order, as something a reader can click.
 *
 * Two rules shape this module.
 *
 * The first is that the outline reads the SAME markdown string the renderer is
 * handed, never the DOM it produced. A list built by querying rendered headings
 * can only ever be as correct as the render it happened to observe: it is empty
 * on the first paint, stale after a re-render, and untestable without a layout
 * engine. A pure function over the source text has none of those states.
 *
 * The second is that an outline entry's `id` is not this module's invention —
 * and no longer even its computation. {@link markdownHeadings} is the one pass
 * that decides what every heading of a document is called, `MarkdownRenderer`
 * looks its ids up in that same pass, and this module lists what it found. The
 * whole feature is a set of links into ids somebody else assigns, so a second
 * spelling of that rule is not a style difference, it is a dead link; a second
 * IMPLEMENTATION of it is the same dead link with a longer fuse.
 */

import { markdownHeadings } from '@/shared/components/MarkdownRenderer/headings'
import { headingAnchorId } from '@/shared/components/MarkdownRenderer/utils'

export { headingDisplayText } from '@/shared/components/MarkdownRenderer/headings'

/** A heading a reader can jump to. */
export interface ReportOutlineEntry {
  /** 2 for a `##` section, 3 for a `###` subsection. */
  level: 2 | 3
  /** The heading as the reader sees it, with inline markdown resolved. */
  text: string
  /** The heading's DOM id — the same one `MarkdownRenderer` assigns. */
  id: string
  /**
   * A key that is unique within one outline.
   *
   * Ids are unique per document now, so this is no longer load-bearing for the
   * markdown's own headings. It stays because the list has TWO producers: the
   * report's sources section is rendered by `ReportTab` rather than by the
   * markdown, and its entry is synthesized separately (see
   * {@link reportOutlineEntry}). The ordinal prefix keeps the React key stable
   * and unique across both without either having to know about the other.
   */
  key: string
}

/**
 * How many entries a report needs before it gets an outline.
 *
 * A long-form report is written to a plan — a title, main sections as `##`,
 * subsections as `###`, and a closing sources list — and runs to several
 * thousand words, which is ten or more screens in a panel that occupies half
 * the window. That report is unreadable without a map. A report with three
 * navigable places is the short shape: a lead, a section or two, and the
 * sources, all inside a screen or two of scrolling. Offering navigation there
 * adds a control the reader must read and dismiss to reach prose they could
 * already see, so the outline stays away until the fourth entry, which is the
 * first point at which scanning beats scrolling.
 */
export const MIN_REPORT_OUTLINE_ENTRIES = 4

/**
 * Build one entry from heading text that is already reader-visible. Shared with
 * the caller, because the sources section at the foot of a report is rendered
 * by `ReportTab` itself rather than by the markdown, and it has to arrive in
 * the outline spelled exactly the same way.
 *
 * `id` is passed in by a caller that renders the heading itself and has already
 * settled its id against the ids the markdown spoke for
 * ({@link uniqueHeadingId}); it defaults to the plain slug for a heading whose
 * text is the only thing anybody knows about it.
 */
export const reportOutlineEntry = (
  text: string,
  level: 2 | 3,
  ordinal: number,
  id: string = headingAnchorId(text)
): ReportOutlineEntry | null => {
  // A heading of nothing but punctuation slugifies to the empty string, which
  // is not an id anything can be scrolled to. There is nothing to offer.
  if (!id) return null
  return { level, text, id, key: `${ordinal}-${id}` }
}

/**
 * Every `##`/`###` heading in a report, in document order.
 *
 * Duplicate heading text is now genuinely disambiguated: two sections called
 * „Bewertung" are `#bewertung` and `#bewertung-2`, because that is what the
 * renderer puts on them — one pass decides both. The outline used to reproduce
 * the collision instead, offering `#bewertung` twice, and the second entry
 * scrolled the reader to the first section without ever failing.
 *
 * Levels 1 and 4 are read by the shared pass and skipped here. A `#` is the
 * report's own title, which the reader is already at, and a `####` is a detail
 * below the grain a map should have; but both still take an id, and leaving
 * them out of the pass would let a `#### Bewertung` quietly claim the id a
 * later `## Bewertung` should have had.
 */
export const extractReportOutline = (markdown: string): ReportOutlineEntry[] => {
  const entries: ReportOutlineEntry[] = []
  for (const heading of markdownHeadings(markdown)) {
    if (heading.level !== 2 && heading.level !== 3) continue
    entries.push({
      level: heading.level,
      text: heading.text,
      id: heading.id,
      key: `${entries.length}-${heading.id}`,
    })
  }
  return entries
}
