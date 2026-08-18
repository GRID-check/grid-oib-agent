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
 * The second is that an outline entry's `id` is not this module's invention. It
 * is {@link headingAnchorId}, the exact function `MarkdownRenderer` puts on its
 * `h1`–`h4` elements — the whole feature is a set of links into ids somebody
 * else assigns, so a second spelling of that rule is not a style difference,
 * it is a dead link. That is also why the visible label is resolved BEFORE the
 * id is computed: the renderer slugifies the heading's rendered TEXT, so
 * `## Die [OIB-Richtlinie 2](https://…)` must reach `headingAnchorId` as
 * "Die OIB-Richtlinie 2" and not with the URL still in it.
 *
 * Inline markdown is resolved here by hand rather than by a parser, which is
 * the one approximation in this file and worth naming. `remark-parse` is a
 * devDependency — it exists for the specs, not for the bundle — and a heading
 * is in any case a single line, a far smaller grammar than running prose. Most
 * inline syntax needs no handling at all, because `headingAnchorId` deletes
 * every character that is not a word character, whitespace or a hyphen: `*`,
 * `` ` ``, `~` and `\` are gone before they can change an id. Only two
 * constructs survive that strip and would corrupt the id, and both are handled:
 * a link/image destination (whose URL would otherwise be slugified into the id)
 * and emphasis delimiters (which have to come off the visible LABEL even when
 * the id would not notice).
 */

import { headingAnchorId } from '@/shared/components/MarkdownRenderer/utils'

/** A heading a reader can jump to. */
export interface ReportOutlineEntry {
  /** 2 for a `##` section, 3 for a `###` subsection. */
  level: 2 | 3
  /** The heading as the reader sees it, with inline markdown resolved. */
  text: string
  /** The heading's DOM id — the same one `MarkdownRenderer` assigns. */
  id: string
  /**
   * A key that is unique within one outline. Two sections may carry the same
   * title, and the renderer gives both the same `id` (see the note on
   * duplicates in {@link extractReportOutline}), so `id` alone cannot key a
   * list.
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

/** An ATX heading of exactly the two levels the outline lists. */
const HEADING_RE = /^ {0,3}(#{2,3})(?:[ \t]+(.*?))?[ \t]*$/

/** A fence that opens or closes a code block. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** The optional run of `#` that may close an ATX heading. */
const CLOSING_SEQUENCE_RE = /(?:^|[ \t])#+[ \t]*$/

/** `[label](destination)` and `![alt](destination)` — the label is what shows. */
const INLINE_LINK_RE = /!?\[([^\]]*)\]\([^)]*\)/g

/**
 * `_emphasis_`, but only where CommonMark would see emphasis: an underscore
 * inside a word (`OIB_2`, `snake_case`) never opens one, and eating it would
 * both mangle the label and change the id, since `headingAnchorId` turns an
 * underscore into a hyphen rather than dropping it.
 */
const UNDERSCORE_EMPHASIS_RE = /(^|[\s([{"'])__?(\S(?:[^_]*\S)?)__?(?=[\s)\]}"'.,;:!?]|$)/g

/** `**strong**` / `*emphasis*` / `~~struck~~` / `` `code` ``. */
const STAR_EMPHASIS_RE = /\*{1,3}([^*]+)\*{1,3}/g
const STRIKE_RE = /~~([^~]+)~~/g
const CODE_SPAN_RE = /`+([^`]+)`+/g

/** A backslash escape resolves to the character it protects. */
const ESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!~<>|])/g

/**
 * The reader-visible text of a heading's inline markdown.
 *
 * Note what is deliberately NOT touched: a bare `[3]` and the `[2][3]` of a
 * claim carried by two sources. Both are literal text to the parser unless a
 * link definition exists for them, which a report does not write, and both are
 * shapes the citation numbering produces on purpose. Collapsing `[2][3]` to
 * "2" would print a number the report never wrote, and would move the id.
 */
export const headingDisplayText = (raw: string): string =>
  raw
    .replace(INLINE_LINK_RE, '$1')
    .replace(CODE_SPAN_RE, '$1')
    .replace(STRIKE_RE, '$1')
    .replace(STAR_EMPHASIS_RE, '$1')
    .replace(UNDERSCORE_EMPHASIS_RE, '$1$2')
    .replace(ESCAPE_RE, '$1')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Build one entry from heading text that is already reader-visible. Shared with
 * the caller, because the sources section at the foot of a report is rendered
 * by `ReportTab` itself rather than by the markdown, and it has to arrive in
 * the outline spelled exactly the same way.
 */
export const reportOutlineEntry = (
  text: string,
  level: 2 | 3,
  ordinal: number
): ReportOutlineEntry | null => {
  const id = headingAnchorId(text)
  // A heading of nothing but punctuation slugifies to the empty string, which
  // is not an id anything can be scrolled to. There is nothing to offer.
  if (!id) return null
  return { level, text, id, key: `${ordinal}-${id}` }
}

/**
 * Every `##`/`###` heading in a report, in document order.
 *
 * Fenced code is skipped, because a `## Sources` inside a fenced example is
 * sample text and the renderer draws it as such — an outline entry for it
 * would point at an id that does not exist. Indented code needs no special
 * case: four leading spaces already disqualify a line as an ATX heading.
 *
 * Duplicate heading text is reproduced, not disambiguated. `MarkdownRenderer`
 * derives the id from the heading text alone and adds no occurrence suffix, so
 * two sections called "Bewertung" really do carry the same id in the document
 * and `getElementById` finds the first. The outline matches that rather than
 * inventing "bewertung-2", which would link nowhere at all: a link to the
 * first occurrence is a truthful description of what the document contains.
 * Making them genuinely distinct is a change to the renderer's id assignment
 * and belongs there, in one place, for every surface that links to a heading.
 */
export const extractReportOutline = (markdown: string): ReportOutlineEntry[] => {
  if (!markdown) return []

  const entries: ReportOutlineEntry[] = []
  let fence: { char: string; length: number } | null = null

  for (const line of markdown.split('\n')) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      const char = marker[0]
      if (!fence) {
        // An opening fence may carry an info string; a closing one may not.
        fence = { char, length: marker.length }
        continue
      }
      if (char === fence.char && marker.length >= fence.length && fenceMatch[2].trim() === '') {
        fence = null
      }
      continue
    }
    if (fence) continue

    const headingMatch = HEADING_RE.exec(line)
    if (!headingMatch) continue

    const raw = (headingMatch[2] ?? '').replace(CLOSING_SEQUENCE_RE, '')
    const text = headingDisplayText(raw)
    if (!text) continue

    const entry = reportOutlineEntry(text, headingMatch[1].length === 2 ? 2 : 3, entries.length)
    if (entry) entries.push(entry)
  }

  return entries
}
