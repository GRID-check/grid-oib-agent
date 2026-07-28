/**
 * Report citation helpers (ReportTab).
 *
 * Deep-research reports cite sources with inline `[N]` markers and usually end
 * with a numbered sources section (`## Sources` / `## Quellen`). Rendered as
 * plain markdown those markers are dead text. These helpers:
 *
 *  1. `splitReportSources` — extract the trailing sources section (heading +
 *     numbered entries) so the entries can be rendered with per-entry DOM
 *     anchors (react-markdown without rehype-raw cannot attach ids to list
 *     items from markdown alone).
 *  2. `linkifyCitationMarkers` — turn inline `[N]` markers in the report body
 *     into markdown anchor links (`[\[N\]](#report-source-N)`), skipping code
 *     blocks/spans and existing link syntax, so the MarkdownRenderer's
 *     in-page-anchor handling scrolls to the matching source entry.
 */

/** DOM id prefix for source entries rendered by ReportTab. */
export const REPORT_SOURCE_ANCHOR_PREFIX = 'report-source-'

/**
 * Origin of a cited source, parsed from a leading backend token
 * (`[KB]` / `[Web]` / `[RIS]`) on the source line. `undefined` when the line
 * carries no recognized token — older reports and replays predate the token,
 * so absence must degrade gracefully to an unlabeled entry.
 */
export type ReportSourceKind = 'kb' | 'web' | 'ris'

export interface ReportSourceEntry {
  /** The citation number, e.g. 3 for "[3]" / "3." */
  number: number
  /** Entry text (markdown, without the leading number marker or origin token) */
  markdown: string
  /** Parsed source origin, or undefined when the line has no origin token. */
  sourceKind?: ReportSourceKind
}

export interface SplitReportSources {
  /** Report markdown without the extracted sources section */
  body: string
  /** Heading text of the sources section (e.g. "Quellen"), if one was found */
  heading: string | null
  /** Parsed numbered entries; empty when no sources section was found */
  entries: ReportSourceEntry[]
}

/**
 * Recognized sources-section heading titles (EN + DE variants), as either a
 * markdown heading (`## Quellen`) or a bold label (`**References:**`). The bold
 * form is what the backend's minimal-citation fallback writes
 * (`_append_minimal_citation`), so missing it left those source sections
 * unparsed — and therefore rendered raw, next to the chip row that already said
 * the same thing.
 */
const SOURCES_HEADING_RE =
  /^(?:#{1,4}\s*|\*\*)?(?:\d+\.?\s*)?(sources|quellen|quellenverzeichnis|quellenangaben|references|referenzen)\s*:?\s*(?:\*\*)?$/i

/**
 * A numbered source entry line: "1. ...", "1) ..." or "[1] ...", optionally as a
 * markdown bullet ("- [1] ..."). The bullet form is the backend's own output
 * (`_CITATION_LINE_RE` accepts it and `_append_minimal_citation` writes it).
 */
const SOURCE_ENTRY_RE = /^\s*(?:[-*+]\s+)?(?:\[(\d{1,3})\]|(\d{1,3})[.)])\s+(.+)$/

/**
 * Leading backend origin token on a source entry, e.g. "[KB] ...".
 * Deterministic backend output (see citation_verification.source_origin_token);
 * stripped from the display text and mapped to `sourceKind`.
 */
const SOURCE_KIND_TOKEN_RE = /^\[(KB|Web|RIS)\]\s*/i

const TOKEN_TO_SOURCE_KIND: Record<string, ReportSourceKind> = {
  kb: 'kb',
  web: 'web',
  ris: 'ris',
}

/** Split a leading origin token off an entry, returning the display text + kind. */
const parseSourceKind = (
  text: string
): { markdown: string; sourceKind?: ReportSourceKind } => {
  const match = text.match(SOURCE_KIND_TOKEN_RE)
  if (!match) return { markdown: text }
  return {
    markdown: text.slice(match[0].length).trim(),
    sourceKind: TOKEN_TO_SOURCE_KIND[match[1].toLowerCase()],
  }
}

/** Markdown reference-link definition, e.g. "[1]: https://..." */
const LINK_REFERENCE_DEFINITION_RE = /^\s*\[\d+\]:\s+\S/m

/**
 * Split a report into body + trailing sources section.
 * Only a sources section introduced by a recognized heading with at least one
 * numbered entry is extracted; otherwise the report is returned unchanged.
 */
export const splitReportSources = (markdown: string): SplitReportSources => {
  const noSplit: SplitReportSources = { body: markdown, heading: null, entries: [] }
  if (!markdown.trim()) return noSplit

  const lines = markdown.split('\n')

  // Find the LAST matching heading outside fenced code blocks.
  let headingIndex = -1
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence && SOURCES_HEADING_RE.test(line.trim())) {
      headingIndex = i
    }
  }
  if (headingIndex === -1) return noSplit

  const headingMatch = lines[headingIndex].trim().match(SOURCES_HEADING_RE)
  const heading = headingMatch ? headingMatch[1] : null

  // Collect numbered entries after the heading until the next heading.
  const entries: ReportSourceEntry[] = []
  let end = lines.length
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,6}\s/.test(line)) {
      end = i
      break
    }
    const entryMatch = line.match(SOURCE_ENTRY_RE)
    if (entryMatch) {
      const number = Number(entryMatch[1] ?? entryMatch[2])
      const { markdown, sourceKind } = parseSourceKind(entryMatch[3].trim())
      entries.push({ number, markdown, sourceKind })
    } else if (line.trim() && entries.length > 0) {
      // Continuation line of the previous entry (wrapped URL/title).
      entries[entries.length - 1].markdown += ` ${line.trim()}`
    }
  }

  if (entries.length === 0) return noSplit

  const body = [...lines.slice(0, headingIndex), ...lines.slice(end)].join('\n').trimEnd()
  return { body, heading, entries }
}

/**
 * Linkify inline `[N]` citation markers to in-page anchors.
 *
 * - Only numbers present in `validNumbers` are linkified.
 * - Fenced code blocks and inline code spans are left untouched.
 * - Existing markdown link syntax is preserved: `[N](url)`, `[N][ref]` and
 *   reference definitions are not rewritten; if the document declares numeric
 *   link-reference definitions (`[1]: url`), linkification is skipped entirely
 *   because `[1]` already renders as a link there.
 */
export const linkifyCitationMarkers = (
  markdown: string,
  validNumbers: ReadonlySet<number>,
  anchorPrefix: string = REPORT_SOURCE_ANCHOR_PREFIX
): string => {
  if (!markdown || validNumbers.size === 0) return markdown
  if (LINK_REFERENCE_DEFINITION_RE.test(markdown)) return markdown

  // Split out fenced code blocks first, then inline code spans, so `[N]`
  // inside code is never rewritten.
  const fenceSplit = markdown.split(/(^\s*(?:```|~~~)[\s\S]*?^\s*(?:```|~~~)\s*$)/m)

  const linkifyText = (text: string): string =>
    text.replace(/\[(\d{1,3})\](?!\(|\[|:)/g, (match, num: string, offset: number) => {
      const n = Number(num)
      if (!validNumbers.has(n)) return match
      // Don't touch markers that are part of link syntax like `[text][1]`.
      if (offset > 0 && text[offset - 1] === ']') return match
      // Leave image/escaped constructs alone.
      if (offset > 0 && (text[offset - 1] === '!' || text[offset - 1] === '\\')) return match
      return `[\\[${n}\\]](#${anchorPrefix}${n})`
    })

  return fenceSplit
    .map((segment, index) => {
      // Odd indexes are the captured fenced code blocks — leave untouched.
      if (index % 2 === 1) return segment
      // Preserve inline code spans within the text segment.
      return segment
        .split(/(`[^`\n]*`)/)
        .map((part, partIndex) => (partIndex % 2 === 1 ? part : linkifyText(part)))
        .join('')
    })
    .join('')
}
