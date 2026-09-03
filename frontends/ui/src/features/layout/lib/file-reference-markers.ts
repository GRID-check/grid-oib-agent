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
    if (fileNames.length === 0) return
    const matcher = buildMatcher(fileNames)
    if (!matcher) return
    linkFileNames(tree, matcher)
  }

/** Escape a filename for use as a regex literal. */
const escapeLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * One alternation over every candidate name, rather than one pass per name.
 *
 * The candidate list is already narrowed to names this body contains, so it is
 * a handful in practice; the alternation keeps the walk linear in the length of
 * the prose either way.
 */
const buildMatcher = (fileNames: readonly string[]): RegExp | null => {
  const alternatives = fileNames.filter((name) => name.trim().length > 0).map(escapeLiteral)
  if (alternatives.length === 0) return null
  return new RegExp(alternatives.join('|'), 'gi')
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
const linkFileNames = (parent: Parent, matcher: RegExp): void => {
  const rewritten: PhrasingContent[] = []
  let changed = false

  for (const child of parent.children) {
    if (child.type === 'text') {
      const parts = splitFileNames(child, matcher)
      if (parts) {
        rewritten.push(...parts)
        changed = true
        continue
      }
    } else if ('children' in child && !OPAQUE_TO_MARKERS.has(child.type)) {
      linkFileNames(child, matcher)
    }
    rewritten.push(child as PhrasingContent)
  }

  // Same content-model argument as the citation pass: a `text` node only sits
  // where phrasing is allowed, and a `link` is allowed wherever a `text` is.
  if (changed) parent.children = rewritten as Parent['children']
}

/**
 * A text node split into its file references and the prose between them, or
 * `null` when it names none.
 */
const splitFileNames = (node: Text, matcher: RegExp): PhrasingContent[] | null => {
  matcher.lastIndex = 0
  const parts: PhrasingContent[] = []
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = matcher.exec(node.value)) !== null) {
    const start = match.index
    const end = start + match[0].length
    // A zero-length alternative would loop forever; a filename cannot be empty,
    // but the guard costs nothing and the alternation is built from input.
    if (end === start) {
      matcher.lastIndex = start + 1
      continue
    }
    if (!standsAlone(node.value, start, end)) {
      // Resume one character in, so a name that begins inside the rejected
      // token can still match on its own.
      matcher.lastIndex = start + 1
      continue
    }
    if (start > cursor) parts.push({ type: 'text', value: node.value.slice(cursor, start) })
    parts.push(fileReferenceLink(match[0]))
    cursor = end
    matcher.lastIndex = end
  }

  if (parts.length === 0) return null
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
