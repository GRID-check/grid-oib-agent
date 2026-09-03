/**
 * Inline `[N]` citation markers, resolved on the PARSED document.
 *
 * The markers used to be linked by rewriting the markdown source with a regex
 * before it reached the parser, and that is why `[2][3]` — the shape the
 * backend is instructed to write for a claim carried by two sources — rendered
 * as dead text next to the pills its neighbours got. The rewrite had to
 * recognise, in raw text, everything markdown means by a bracket: it split
 * fenced blocks and code spans off by hand, refused a `[N]` that followed a
 * `]`, and abandoned the whole document if any `[1]: url` definition appeared.
 * Two of those guards fire on `[2][3]` — a lookahead for the `[` that opens the
 * next marker, and the check for the `]` that closed the previous one — because
 * to a regex over source text, adjacent markers are indistinguishable from the
 * `[label][ref]` of a reference link.
 *
 * They are perfectly distinguishable to a PARSER, which is the point: by the
 * time remark hands us an mdast `text` node, it has already decided what is
 * code, what is a link, what is an image and which references resolve. A `[2]`
 * surviving in a text node is literal prose, so the only thing left to do is
 * find it — a scan for `[`, digits, `]`, with no context to guess at.
 *
 * What the parser now decides, and we no longer approximate:
 *  - code blocks and inline code — never `text` nodes, so never touched;
 *  - real links, images and resolved references — their own node types, whose
 *    subtrees we skip (a link inside a link is not expressible anyway);
 *  - `[label][ref]` with a matching definition — a `linkReference` node, so it
 *    is skipped for the right reason rather than by a lookahead;
 *  - `[label][ref]` WITHOUT a definition — plain text, exactly as it renders,
 *    which is what makes `[2][3]` two markers instead of a suspected link.
 *
 * The one thing the AST hides is the difference between `[2]` and `\[2\]`:
 * remark resolves the escape and both arrive as the text `[2]`. An author
 * escaping a bracket around a number that is also a live citation is not a
 * shape this content produces, and paying for it would mean re-reading the
 * source — which is the approach this module exists to replace.
 */

import type { Link, Parent, PhrasingContent, Root, Text } from 'mdast'
import { REPORT_SOURCE_ANCHOR_PREFIX } from './report-citations'

export interface CitationMarkerOptions {
  /**
   * The numbers that have a source entry to point at. A `[7]` in an answer
   * whose sources stop at 5 stays text: a marker that led nowhere would be a
   * worse lie than one that does not claim to be a link.
   */
  numbers: ReadonlySet<number>
  /** Anchor id prefix of the rows being linked to. */
  anchorPrefix?: string
}

/**
 * Remark plugin turning `[N]` markers into in-page links to the source rows.
 *
 * The links are ordinary mdast `link` nodes with a `#…` url, which is the
 * existing contract with `InPageAnchorProvider`: the chat renders them as
 * {@link CitationMarker} pills, every other markdown surface as a scroll
 * anchor. Nothing downstream learns that this plugin ran.
 */
export const remarkCitationMarkers =
  ({ numbers, anchorPrefix = REPORT_SOURCE_ANCHOR_PREFIX }: CitationMarkerOptions) =>
  (tree: Root): void => {
    if (numbers.size === 0) return
    linkMarkers(tree, numbers, anchorPrefix)
  }

/**
 * Node types no inline marker pass descends into: their subtree is a link
 * label, an alt text or a reference definition, where a `[N]` — or a filename —
 * is part of the construct rather than something to rewrite. Shared with
 * `file-reference-markers`, which walks the same tree for the same reason: two
 * copies of this list would drift the moment mdast grew an eighth node type.
 */
export const OPAQUE_TO_MARKERS: ReadonlySet<string> = new Set([
  'link',
  'linkReference',
  'image',
  'imageReference',
  'definition',
  'footnoteReference',
  'footnoteDefinition',
])

/** Rewrite every literal `[N]` below `parent`, in place. */
const linkMarkers = (
  parent: Parent,
  numbers: ReadonlySet<number>,
  anchorPrefix: string
): void => {
  const rewritten: PhrasingContent[] = []
  let changed = false

  for (const child of parent.children) {
    if (child.type === 'text') {
      const parts = splitMarkers(child, numbers, anchorPrefix)
      if (parts) {
        rewritten.push(...parts)
        changed = true
        continue
      }
    } else if ('children' in child && !OPAQUE_TO_MARKERS.has(child.type)) {
      linkMarkers(child, numbers, anchorPrefix)
    }
    rewritten.push(child as PhrasingContent)
  }

  // Only the phrasing positions are ever replaced — a `text` node can only sit
  // where phrasing content is allowed, and a `link` is allowed wherever a
  // `text` is — so the container's own content model still holds.
  if (changed) parent.children = rewritten as Parent['children']
}

/**
 * A text node split into its markers and the prose between them, or `null`
 * when it carries no marker this answer can resolve.
 */
const splitMarkers = (
  node: Text,
  numbers: ReadonlySet<number>,
  anchorPrefix: string
): PhrasingContent[] | null => {
  const markers = findMarkers(node.value).filter((marker) => numbers.has(marker.number))
  if (markers.length === 0) return null

  const parts: PhrasingContent[] = []
  let cursor = 0
  for (const marker of markers) {
    if (marker.start > cursor) {
      parts.push({ type: 'text', value: node.value.slice(cursor, marker.start) })
    }
    parts.push(citationLink(marker.number, anchorPrefix))
    cursor = marker.end
  }
  if (cursor < node.value.length) {
    parts.push({ type: 'text', value: node.value.slice(cursor) })
  }
  return parts
}

/**
 * The link one marker becomes. Its label keeps the brackets so a surface
 * without a citation renderer still reads as "[3]"; the chat's pill drops them
 * and shows the bare number.
 */
const citationLink = (number: number, anchorPrefix: string): Link => ({
  type: 'link',
  url: `#${anchorPrefix}${number}`,
  children: [{ type: 'text', value: `[${number}]` }],
})

/** Where one `[N]` sits in a run of literal text. */
interface Marker {
  /** Offset of the `[`. */
  start: number
  /** Offset just past the `]`. */
  end: number
  number: number
}

/**
 * Citation numbers are `[1]`…`[999]`. The bound is what stops a bracketed
 * figure in prose ("[2024]") from being read as a marker; beyond it, the
 * source list would have to have a thousand entries for the number to resolve.
 */
const MAX_MARKER_DIGITS = 3

const isDigit = (char: string): boolean => char >= '0' && char <= '9'

/**
 * Every `[N]` in a run of literal text, left to right and non-overlapping.
 *
 * A plain scan, because at this point the text IS plain: no escapes to honour,
 * no code to avoid, no link syntax to second-guess — the parser settled all
 * three before this ran.
 */
const findMarkers = (value: string): Marker[] => {
  const markers: Marker[] = []
  let index = 0

  while (index < value.length) {
    if (value[index] !== '[') {
      index += 1
      continue
    }
    let cursor = index + 1
    while (cursor < value.length && isDigit(value[cursor])) cursor += 1
    const digits = cursor - index - 1
    if (digits > 0 && digits <= MAX_MARKER_DIGITS && value[cursor] === ']') {
      markers.push({ start: index, end: cursor + 1, number: Number(value.slice(index + 1, cursor)) })
      index = cursor + 1
      continue
    }
    // Not a marker: step past this `[` only, so the `[` of `[[2]` still opens
    // one on the next pass.
    index += 1
  }

  return markers
}
