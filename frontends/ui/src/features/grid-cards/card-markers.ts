/**
 * Inline `[[card:N]]` placement markers, resolved on the PARSED document.
 *
 * A card used to be a block of its own above the whole answer, which is the one
 * place it cannot do its job: a stair diagram is an argument about the sentence
 * beside it, and three of them push the written answer below the fold. So the
 * agent now writes a marker — `[[card:2]]`, handed back by `emit_card` — on a
 * line of its own where the card belongs, and the card is drawn there.
 *
 * The marker names the card's INDEX in the `cards` array (1-based on the wire,
 * because the agent counts its own emissions from one). Cards gained no id
 * field for this: identity is already positional everywhere else — `cardKey`,
 * `reconcileCardInteractions` and the persisted decisions all key on the index
 * — and a second identity would be a second thing to keep in sync.
 *
 * Resolved on the mdast for the reason `citation-markers` spells out at length:
 * by the time remark hands over a `text` node it has already decided what is
 * code, what is a link and what is literal prose, so a marker surviving in a
 * text node is one the reader would otherwise have seen.
 *
 * THE CONTRACT, and why it is this narrow:
 *  - A marker is PLACED only when it stands alone on its own line in a
 *    top-level paragraph. A card is a block; splicing one into the middle of a
 *    sentence would put a `<div>` inside a `<p>`, which the browser un-nests.
 *  - Every other `[[card:N]]` — mid-sentence, inside a list item or a quote,
 *    naming a card that does not exist — is STRIPPED, and its card falls back
 *    to the block after the prose. Both halves matter: the reader must never
 *    meet a raw marker, and a card must never silently disappear because its
 *    marker landed somewhere unrenderable.
 *
 * {@link placedCardIndices} answers "which cards did the prose claim?" for the
 * caller that renders the fallback block. It is a second, line-based reading of
 * the same contract, because React cannot learn during one render what a child
 * component's parse decided; the two are kept in step deliberately, and the
 * divergence that remains (a marker in a setext heading, or on a lazy list
 * continuation line) costs a card its inline slot, never a duplicate.
 */

import type { Paragraph, PhrasingContent, Root, RootContent, Text } from 'mdast'
import type { Parent } from 'unist'
import { MARKDOWN_SLOT_TAG } from '@/shared/components/MarkdownRenderer/slot-context'

export interface CardMarkerOptions {
  /**
   * How many cards this answer carries. A `[[card:4]]` in an answer holding
   * three cards renders nothing at all rather than a marker or a hole: while
   * streaming, the marker regularly arrives frames before the card it names,
   * and it must not flash as literal text in between.
   */
  count: number
}

/**
 * Remark plugin splicing each placed card into the flow of the answer.
 *
 * The card itself is not rendered here — a markdown plugin must not know what a
 * `stair_diagram` is. It leaves a slot (see `slot-context`), and the chat fills
 * it with the card at that index.
 */
export const remarkCardMarkers =
  ({ count }: CardMarkerOptions) =>
  (tree: Root): void => {
    const children: RootContent[] = []
    let changed = false

    for (const child of tree.children) {
      // Only a top-level paragraph can host a card: it is the one position
      // where replacing the node keeps the document's content model valid.
      const placed = child.type === 'paragraph' ? placeMarkers(child, count) : null
      if (placed) {
        children.push(...placed)
        changed = true
        continue
      }
      children.push(child)
    }
    if (changed) tree.children = children

    // Whatever the pass above could not place is prose the reader would read as
    // machine noise — including the marker of a card that has not streamed in.
    stripMarkers(tree)
    stripPartialTail(tree)
  }

/** The slot node one placed marker becomes. */
const cardSlot = (index: number): Paragraph => ({
  type: 'paragraph',
  children: [],
  // `hName` replaces the `<p>` wholesale, so the card is never nested inside a
  // paragraph — which is the whole reason placement is line-based.
  data: { hName: MARKDOWN_SLOT_TAG, hProperties: { index: String(index) } },
})

/** Where one `[[card:N]]` sits in a run of literal text. */
interface Marker {
  /** Offset of the first `[`. */
  start: number
  /** Offset just past the last `]`. */
  end: number
  /** The 1-based card number the agent wrote. */
  number: number
}

const MARKER = /\[\[card:(\d+)\]\]/g

const findMarkers = (value: string): Marker[] => {
  const markers: Marker[] = []
  // `matchAll`, not `exec` in a loop: it works on its own clone of the regex,
  // so the shared global `MARKER` never carries a `lastIndex` from one text
  // node into the next and skips the marker at the start of it.
  for (const match of value.matchAll(MARKER)) {
    markers.push({
      start: match.index,
      end: match.index + match[0].length,
      number: Number(match[1]),
    })
  }
  return markers
}

/**
 * A paragraph split into the prose around its own-line markers and the slots
 * between them, or `null` when it holds no placeable marker.
 *
 * A marker out of range yields no slot but still splits the paragraph — the
 * text goes, the card comes back in the fallback block.
 */
const placeMarkers = (paragraph: Paragraph, count: number): RootContent[] | null => {
  const out: RootContent[] = []
  let run: PhrasingContent[] = []
  let found = false

  const flush = (): void => {
    const trimmed = trimRun(run)
    if (trimmed.length > 0) out.push({ type: 'paragraph', children: trimmed })
    run = []
  }

  paragraph.children.forEach((child, position) => {
    if (child.type !== 'text') {
      run.push(child)
      return
    }

    const markers = findMarkers(child.value).filter((marker) =>
      isOwnLine(marker, child, paragraph, position)
    )
    if (markers.length === 0) {
      run.push(child)
      return
    }
    found = true

    let cursor = 0
    for (const marker of markers) {
      const before = child.value.slice(cursor, marker.start)
      if (before.length > 0) run.push({ type: 'text', value: before })
      flush()
      if (marker.number >= 1 && marker.number <= count) out.push(cardSlot(marker.number - 1))
      cursor = marker.end
      // The newline that ended the marker's line belongs to the marker, not to
      // the prose after it — left in, it opens the next paragraph with a blank.
      if (child.value[cursor] === '\n') cursor += 1
    }
    const after = child.value.slice(cursor)
    if (after.length > 0) run.push({ type: 'text', value: after })
  })

  if (!found) return null
  flush()
  return out
}

/**
 * Is this marker alone on its line?
 *
 * "Line" inside a paragraph means: bounded by the soft line breaks remark left
 * in the text value, by a hard `break` node, or by the paragraph's own edges.
 * Anything else is a marker the agent wrote mid-sentence, where a card cannot
 * go.
 */
const isOwnLine = (marker: Marker, node: Text, paragraph: Paragraph, position: number): boolean => {
  const startsLine =
    marker.start === 0
      ? position === 0 || paragraph.children[position - 1]?.type === 'break'
      : node.value[marker.start - 1] === '\n'
  const endsLine =
    marker.end === node.value.length
      ? position === paragraph.children.length - 1 ||
        paragraph.children[position + 1]?.type === 'break'
      : node.value[marker.end] === '\n'
  return startsLine && endsLine
}

/**
 * Drop the line breaks and blank text a split leaves at a run's edges, and the
 * run itself when nothing but those remain — a paragraph holding one stray
 * `<br>` is a gap the reader reads as a rendering fault.
 */
const trimRun = (run: PhrasingContent[]): PhrasingContent[] => {
  const isBlank = (node: PhrasingContent): boolean =>
    node.type === 'break' || (node.type === 'text' && node.value.trim().length === 0)

  let start = 0
  let end = run.length
  while (start < end && isBlank(run[start])) start += 1
  while (end > start && isBlank(run[end - 1])) end -= 1
  if (start >= end) return []

  const trimmed = run.slice(start, end)
  // Only the outer text nodes are trimmed, and only at the outer edge: the
  // whitespace between two words in the middle of the run is content.
  const first = trimmed[0]
  if (first.type === 'text') trimmed[0] = { type: 'text', value: first.value.replace(/^\n+/, '') }
  const last = trimmed[trimmed.length - 1]
  if (last.type === 'text') {
    trimmed[trimmed.length - 1] = { type: 'text', value: last.value.replace(/\n+$/, '') }
  }
  return trimmed
}

/**
 * Remove every marker the placement pass left behind, and any node left empty
 * by the removal. Code is untouched for free: `code` and `inlineCode` carry
 * their content in `value`, not in `text` children, so a marker shown
 * deliberately inside a fence still reads as itself.
 */
const stripMarkers = (parent: Parent): void => {
  const kept: RootContent[] = []
  let changed = false

  for (const child of parent.children as RootContent[]) {
    if (child.type === 'text') {
      const stripped = child.value.replace(MARKER, '')
      if (stripped !== child.value) {
        changed = true
        if (stripped.length === 0) continue
        kept.push({ ...child, value: stripped })
        continue
      }
    } else if ('children' in child) {
      stripMarkers(child)
      // A paragraph that held nothing but an unplaceable marker would otherwise
      // render as an empty block with margins. A SLOT is childless on purpose —
      // its content comes from the surface — so it is kept by its `hName`.
      if (child.type === 'paragraph' && child.children.length === 0 && !child.data?.hName) {
        changed = true
        continue
      }
    }
    kept.push(child)
  }

  if (changed) parent.children = kept
}

/**
 * While streaming, `[[card:` arrives one token at a time. Drop a partial
 * marker at the very end of the document so the reader never watches a card
 * reference type itself out — the same courtesy `stabilizeStreamingMarkdown`
 * pays a half-arrived fence or table. Only the tail is touched: a `[[` in the
 * middle of a finished answer is prose.
 */
const PARTIAL_TAIL = /\[\[(?:c(?:a(?:r(?:d(?::\d*\]?)?)?)?)?)?$/

const stripPartialTail = (tree: Root): void => {
  const last = lastText(tree)
  if (!last) return
  last.value = last.value.replace(PARTIAL_TAIL, '')
}

const lastText = (node: Parent): Text | null => {
  const child = node.children[node.children.length - 1]
  if (!child) return null
  if (child.type === 'text') return child as Text
  // Only the very last position is followed: anything else (an image, a table,
  // a closed code block) means the document does not END mid-marker.
  if ('children' in child) return lastText(child as Parent)
  return null
}

/**
 * Which card indices the prose claims, read off the SOURCE.
 *
 * The caller needs this before it renders — the cards left over are the ones
 * its fallback block must carry — and a child component's parse is not
 * available then. Same contract as the plugin, one line at a time: a marker
 * alone on an unindented line, outside a fenced code block. Indent is capped at
 * three spaces because four would make the line an indented code block, which
 * the parser (and therefore the plugin) never treats as prose.
 */
const FENCE = /^ {0,3}(?:```|~~~)/
const LINE_MARKER = /^ {0,3}\[\[card:(\d+)\]\][ \t]*$/

export const placedCardIndices = (markdown: string, count: number): ReadonlySet<number> => {
  const placed = new Set<number>()
  if (count <= 0) return placed

  let fenced = false
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = LINE_MARKER.exec(line)
    if (!match) continue
    const number = Number(match[1])
    if (number >= 1 && number <= count) placed.add(number - 1)
  }
  return placed
}

/** The indices of the cards no marker claimed, in order — the fallback block. */
export const unplacedCardIndices = (markdown: string, count: number): number[] => {
  const placed = placedCardIndices(markdown, count)
  const rest: number[] = []
  for (let index = 0; index < count; index += 1) {
    if (!placed.has(index)) rest.push(index)
  }
  return rest
}
