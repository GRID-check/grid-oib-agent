/**
 * Every heading in one markdown document, and the id each one carries.
 *
 * ## Why a pre-pass and not a counter during render
 *
 * Heading ids have to be unique per document: a report with two „Bewertung"
 * sections gave both `id="bewertung"`, so `getElementById` found the first one
 * and every link to the second — an outline entry, an in-page citation anchor —
 * scrolled to the wrong section without ever failing.
 *
 * The renderer assigns its ids inside per-heading component callbacks, so the
 * obvious fix is to count occurrences as those callbacks fire. Every shape of
 * that fix is wrong here:
 *
 *  - a module-level counter is shared by every `MarkdownRenderer` mounted on
 *    the page, and a chat thread mounts several — the second answer's first
 *    heading would inherit the first answer's count;
 *  - an instance `useRef` reset at the top of each render leaks in the other
 *    direction: React may start a render, abandon it and start again, and may
 *    interleave two components' renders, so the number a heading receives
 *    depends on how the renderer happened to be scheduled. An id that changes
 *    between paints is the same dead link in a new costume;
 *  - counting inside `useMemo` would work only for as long as nobody renders
 *    the same content twice, which `React.memo` does not promise either.
 *
 * So the ids are computed by a PURE PASS over the markdown string before
 * anything renders, and the render only looks its answer up — keyed by the
 * source line the heading was written on, which is a property of the text and
 * not of the render. The function is memoized on the content, gives the same
 * answer for two instances showing the same document, and cannot be disturbed
 * by re-entrant or interrupted rendering.
 *
 * It buys one thing more, which is the point: {@link extractReportOutline}
 * already had to do this exact scan to build the report outline, and it now
 * calls THIS function. The outline and the renderer cannot spell an id two
 * ways, because there is only one spelling.
 *
 * Inline markdown is resolved here by hand rather than by a parser. `remark`
 * is a devDependency — it exists for the specs, not for the bundle — and a
 * heading is a single line, a far smaller grammar than running prose. Most
 * inline syntax needs no handling at all, because {@link headingAnchorId}
 * deletes every character that is not a word character, whitespace or a
 * hyphen: `*`, `` ` ``, `~` and `\` are gone before they can change an id.
 * What survives that strip and would corrupt the id is handled: a link/image
 * destination (whose URL would otherwise be slugified into the id), emphasis
 * delimiters (which have to come off the visible LABEL even when the id would
 * not notice), and an inline HTML tag (which react-markdown drops, so it must
 * not reach the id either).
 */

import { headingAnchorId } from './utils'

/** A heading of a level {@link MarkdownRenderer} gives an id to. */
export type MarkdownHeadingLevel = 1 | 2 | 3 | 4

/** One heading of a markdown document. */
export interface MarkdownHeading {
  level: MarkdownHeadingLevel
  /** The heading as the reader sees it, with inline markdown resolved. */
  text: string
  /** The id the renderer puts on it — unique within this document. */
  id: string
  /** 1-based line of the markdown the heading was written on. */
  line: number
}

/**
 * An ATX heading of the levels the renderer anchors. `#####` does not match:
 * after four hashes the fifth is neither whitespace nor end of line, and the
 * text group requires one of those.
 *
 * The text is captured GREEDILY and its trailing whitespace trimmed in code,
 * rather than captured lazily against a trailing `[ \t]*$`. The lazy form made
 * the engine expand the capture one character at a time and re-scan to the end
 * of the line on each step, which is quadratic in the line's length: a heading
 * carrying 40k interior spaces took 1,311ms, and this runs over every line of
 * every report. Greedy capture cannot backtrack against a class it does not
 * overlap, so the same line is now microseconds.
 */
const HEADING_RE = /^ {0,3}(#{1,4})(?:[ \t]+(.*))?$/

/** A fence that opens or closes a code block. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** The optional run of `#` that may close an ATX heading. */
const CLOSING_SEQUENCE_RE = /(?:^|[ \t])#+[ \t]*$/

/** `[label](destination)` and `![alt](destination)` — the label is what shows. */
const INLINE_LINK_RE = /!?\[([^\]]*)\]\([^)]*\)/g

/**
 * An inline HTML tag. Without `rehype-raw` react-markdown renders none of it,
 * so `## <b>Kennwerte</b>` reads "Kennwerte" and the id must not carry the
 * tags. Deliberately narrower than `<[^>]*>`: an autolink (`<https://oib.at>`)
 * is not a tag, it renders as its own URL, and eating it would move that id.
 *
 * The attribute run is `(?:[\s/][^>]*)?` rather than `(?:\s[^>]*?)?\s*\/?`. That
 * earlier form let the lazy `[^>]*?` and the trailing `\s*` both match a space,
 * so an unterminated tag backtracked quadratically — `<a ` followed by 16k
 * spaces took 223ms, and this scans a whole report's markdown, which is written
 * from retrieved documents rather than from input we choose.
 *
 * The single leading `[\s/]` is what keeps the autolink exclusion above: a
 * tag's name is followed by whitespace, a slash or `>`, while `<https://oib.at>`
 * has a colon there, so the group cannot open and the match fails. A bare
 * `[^>]*` is linear too, and swallows every autolink — the regression the
 * outline spec now catches.
 */
const HTML_TAG_RE = /<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/][^>]*)?>/g

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
    .replace(HTML_TAG_RE, '')
    .replace(CODE_SPAN_RE, '$1')
    .replace(STRIKE_RE, '$1')
    .replace(STAR_EMPHASIS_RE, '$1')
    .replace(UNDERSCORE_EMPHASIS_RE, '$1$2')
    .replace(ESCAPE_RE, '$1')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Take the next free id for `base`, in document order.
 *
 * The FIRST heading of a given text keeps the bare id it has always had, so
 * every link already published against a first occurrence — a citation anchor
 * in a stored answer, a `#zusammenfassung` somebody pasted into a ticket — goes
 * on landing where it landed before. Only the second and later occurrences gain
 * a suffix, which is also what GitHub, MDN and every other anchored-heading
 * renderer does, so the shape is one readers have met.
 *
 * `taken` is consulted as well as the per-text count, because the two spellings
 * can meet: a document with „Bewertung", „Bewertung" and „Bewertung 2" would
 * otherwise hand `bewertung-2` to two different headings. The suffix walks on
 * until it finds a genuinely free id.
 */
const claimHeadingId = (base: string, taken: Set<string>, counts: Map<string, number>): string => {
  const occurrence = (counts.get(base) ?? 0) + 1
  counts.set(base, occurrence)
  if (occurrence === 1 && !taken.has(base)) {
    taken.add(base)
    return base
  }
  let suffix = Math.max(occurrence, 2)
  while (taken.has(`${base}-${suffix}`)) suffix += 1
  counts.set(base, suffix)
  taken.add(`${base}-${suffix}`)
  return `${base}-${suffix}`
}

/**
 * The id for a heading THIS document renders outside the markdown, given the
 * ids the markdown already spoke for.
 *
 * The report's sources section is the one such heading: `ReportTab` lifts it
 * out of the markdown and renders it itself, so react-markdown never sees it
 * and cannot number it along with the rest. Returns `''` when the text has no
 * id to give — a heading of pure punctuation slugifies to nothing.
 */
export const uniqueHeadingId = (text: string, taken: Iterable<string>): string => {
  const base = headingAnchorId(text)
  if (!base) return ''
  return claimHeadingId(base, new Set(taken), new Map())
}

/**
 * Every `#`–`####` heading of a markdown document, in document order, with the
 * id the renderer will give it.
 *
 * Fenced code is skipped, because a `## Sources` inside a fenced example is
 * sample text and the renderer draws it as such — an id for it would be an id
 * no element carries, and it would push the real headings' suffixes along.
 * Indented code needs no special case: four leading spaces already disqualify a
 * line as an ATX heading.
 *
 * Setext headings (`Bewertung` over `---`) are deliberately not scanned. They
 * fall through to the renderer's own text-derived id, which is what they had
 * before — the outline never lists them, so nothing links to one, and teaching
 * this scan to recognise `---` would also have to tell it apart from a
 * thematic break and a table delimiter.
 */
export const markdownHeadings = (markdown: string): MarkdownHeading[] => {
  if (!markdown) return []

  const headings: MarkdownHeading[] = []
  const taken = new Set<string>()
  const counts = new Map<string, number>()
  let fence: { char: string; length: number } | null = null
  let line = 0

  for (const raw of markdown.split('\n')) {
    line += 1

    const fenceMatch = FENCE_RE.exec(raw)
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

    const headingMatch = HEADING_RE.exec(raw)
    if (!headingMatch) continue

    // `trimEnd` is what the pattern's old trailing `[ \t]*$` used to do.
    const text = headingDisplayText((headingMatch[2] ?? '').trimEnd().replace(CLOSING_SEQUENCE_RE, ''))
    if (!text) continue

    const base = headingAnchorId(text)
    // A heading of nothing but punctuation slugifies to the empty string, which
    // is not an id anything can be scrolled to. The renderer leaves it without
    // one and nothing may link to it.
    if (!base) continue

    headings.push({
      level: headingMatch[1].length as MarkdownHeadingLevel,
      text,
      id: claimHeadingId(base, taken, counts),
      line,
    })
  }

  return headings
}
