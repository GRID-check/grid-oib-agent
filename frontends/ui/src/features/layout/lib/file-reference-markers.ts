/**
 * Filenames in the prose, resolved on the PARSED document.
 *
 * The sibling of `citation-markers`, and it exists for the same reason and with
 * the same discipline: the rewrite happens on the mdast, after remark has
 * already decided what is code, what is a link and what is an image, so this
 * pass never has to recognise markdown in raw text. A `Plan.pdf` surviving in a
 * `text` node is literal prose, and the only question left is whether the
 * reader has a file by that name.
 *
 * That question is answered before this runs. The plugin is handed the names —
 * real filenames, from the reader's own project, Büroarchiv and chat
 * attachments — so it does not need a filename grammar and cannot invent a
 * reference to a document nobody has. Matching is literal and
 * case-insensitive; the LABEL is whatever the answer wrote, so a name the model
 * capitalised differently still reads as the model's sentence.
 *
 * Order matters and is the caller's: names arrive longest-first, so
 * `Grundriss Plan.pdf` claims its text before `Plan.pdf` can take the tail of
 * it.
 *
 * ## No regex, deliberately
 *
 * The obvious implementation of "find any of these strings" is one alternation
 * compiled with `new RegExp(names.map(escape).join('|'), 'gi')`, and that is
 * what this was. Semgrep blocked it (`detect-non-literal-regexp`) and it was
 * right to, even though the ReDoS it names cannot actually happen here: an
 * alternation of escaped literals has no quantifier to backtrack on. The rule
 * is pointing at the shape rather than the exploit, and the shape is real —
 * the pattern was built at runtime out of FILENAMES, which are whatever
 * somebody typed into an upload dialog, so its safety rested entirely on one
 * hand-written escape function staying correct forever.
 *
 * Nothing here needs a regex engine. Finding a literal string in another
 * literal string is `indexOf`, which cannot be talked into interpreting its
 * input as a pattern, is faster than compiling and running an alternation, and
 * deletes the escaping question rather than answering it.
 */

import type { Link, Parent, PhrasingContent, Root, Text } from 'mdast'
import { fileReferenceHref } from '@/features/chat/lib/file-references'
import { OPAQUE_TO_MARKERS } from './citation-markers'

export interface FileReferenceOptions {
  /**
   * The filenames that resolve to a document this reader can open, longest
   * first. A name absent from this list stays prose: a chip that opened
   * nothing would be a worse lie than plain text, which is the rule the
   * citation markers already hold to for a `[7]` with no source.
   */
  fileNames: readonly string[]
}

/**
 * Remark plugin turning literal filenames into in-page links the chat renders
 * as file-reference chips.
 *
 * The links are ordinary mdast `link` nodes with a `#file-ref-…` url — the
 * existing contract with `InPageAnchorProvider` — so nothing downstream learns
 * that this plugin ran, and a markdown surface with no provider renders the
 * filename as an inert anchor rather than as something that navigates away.
 */
export const remarkFileReferences =
  ({ fileNames }: FileReferenceOptions) =>
  (tree: Root): void => {
    const names = fileNames.filter((name) => name.trim().length > 0)
    if (names.length === 0) return
    linkFileNames(tree, names)
  }

/**
 * A filename occurrence is a REFERENCE only when it stands on its own.
 *
 * Before it: nothing that would make it the tail of a longer token —
 * `Bestand-Plan.pdf` does not contain a reference to `Plan.pdf`, and neither
 * does the path `03_Einreichung/Plan.pdf`, where linking the basename alone
 * would put a chip inside a string the reader wrote as one thing.
 *
 * After it: a word character would mean the name is a prefix of something else
 * (`Plan.pdfx`). A `.` is deliberately allowed, because the overwhelmingly
 * common thing following a filename in German prose is the full stop that ends
 * the sentence.
 */
const BOUNDARY_BEFORE = /[\p{L}\p{N}_./\\-]/u
const BOUNDARY_AFTER = /[\p{L}\p{N}_-]/u

const standsAlone = (value: string, start: number, end: number): boolean => {
  const before = start > 0 ? value[start - 1] : ''
  const after = end < value.length ? value[end] : ''
  if (before && BOUNDARY_BEFORE.test(before)) return false
  if (after && BOUNDARY_AFTER.test(after)) return false
  return true
}

/** Rewrite every standalone filename below `parent`, in place. */
const linkFileNames = (parent: Parent, fileNames: readonly string[]): void => {
  const rewritten: PhrasingContent[] = []
  let changed = false

  for (const child of parent.children) {
    if (child.type === 'text') {
      const parts = splitFileNames(child, fileNames)
      if (parts) {
        rewritten.push(...parts)
        changed = true
        continue
      }
    } else if ('children' in child && !OPAQUE_TO_MARKERS.has(child.type)) {
      linkFileNames(child, fileNames)
    }
    rewritten.push(child as PhrasingContent)
  }

  // Same content-model argument as the citation pass: a `text` node only sits
  // where phrasing is allowed, and a `link` is allowed wherever a `text` is.
  if (changed) parent.children = rewritten as Parent['children']
}

/** Where one filename sits in a run of literal text. */
interface Span {
  start: number
  /** Offset just past the last character. */
  end: number
}

/**
 * Every position in `value` where `needle` occurs, case-insensitively.
 *
 * Lowercasing the whole string once and searching THAT is the fast path, and it
 * is only sound while the fold preserves length — which it does for every
 * character these filenames realistically contain, and does not for a few
 * (U+0130 `İ` lowercases to two code units). A fold that changed the length
 * would slide every index after it, and the chip would then be drawn over the
 * wrong span of the sentence — a visible corruption rather than a missed match,
 * so it is worth the second path rather than a comment saying it is unlikely.
 */
const occurrences = (value: string, needle: string): number[] => {
  const found: number[] = []
  const lowerNeedle = needle.toLowerCase()
  const lowerValue = value.toLowerCase()

  if (lowerValue.length === value.length && lowerNeedle.length === needle.length) {
    let from = 0
    for (;;) {
      const at = lowerValue.indexOf(lowerNeedle, from)
      if (at === -1) return found
      found.push(at)
      // One past the start, not past the match: two occurrences of a name may
      // legitimately touch, and the overlap rule below is what decides.
      from = at + 1
    }
  }

  // A length-changing fold. Compare slices of the ORIGINAL, so an index always
  // means the same thing to `standsAlone` and to the slicing below.
  for (let at = 0; at + needle.length <= value.length; at += 1) {
    if (value.slice(at, at + needle.length).toLowerCase() === lowerNeedle) found.push(at)
  }
  return found
}

/**
 * The spans this text node gives up to file references, in reading order and
 * never overlapping.
 *
 * Names arrive longest-first, and a name claims its span before any shorter one
 * is considered — so in „Grundriss Plan.pdf" the longer name wins and the
 * `Plan.pdf` inside it is not a second reference. That is the same precedence
 * the alternation used to get from leftmost-first matching, made explicit.
 */
const claimedSpans = (value: string, fileNames: readonly string[]): Span[] => {
  const claimed: Span[] = []

  for (const name of fileNames) {
    for (const start of occurrences(value, name)) {
      const end = start + name.length
      if (!standsAlone(value, start, end)) continue
      // Linear: a text node yields a handful of references, never a list worth
      // an interval tree.
      if (claimed.some((span) => start < span.end && end > span.start)) continue
      claimed.push({ start, end })
    }
  }

  return claimed.sort((a, b) => a.start - b.start)
}

/**
 * A text node split into its file references and the prose between them, or
 * `null` when it names none.
 */
const splitFileNames = (node: Text, fileNames: readonly string[]): PhrasingContent[] | null => {
  const spans = claimedSpans(node.value, fileNames)
  if (spans.length === 0) return null

  const parts: PhrasingContent[] = []
  let cursor = 0
  for (const { start, end } of spans) {
    if (start > cursor) parts.push({ type: 'text', value: node.value.slice(cursor, start) })
    parts.push(fileReferenceLink(node.value.slice(start, end)))
    cursor = end
  }
  if (cursor < node.value.length) parts.push({ type: 'text', value: node.value.slice(cursor) })
  return parts
}

/**
 * The link one filename becomes. The label is the text AS WRITTEN, not the
 * index's spelling of the name: the chip sits inside the model's sentence and
 * has to keep reading like it.
 */
const fileReferenceLink = (label: string): Link => ({
  type: 'link',
  url: fileReferenceHref(label),
  children: [{ type: 'text', value: label }],
})
