'use client'

/**
 * The caret of a text still being written, placed INSIDE the markdown.
 *
 * ## Why in the tree, and not after the renderer
 *
 * The caret used to be a sibling of the rendered markdown, and to make it
 * trail the last glyph instead of dropping to a line of its own, the surface
 * forced the markdown root and its last block to `display: inline`. An inline
 * block is no block: the paragraph being written ignored its `max-w-[72ch]`
 * (930px wide on a desktop, then rewrapped to 72ch the moment the next block
 * started), a list lost its `pl-5` and its bullets slid right later, a heading
 * lost its margins and dropped 16px when the paragraph after it began, and a
 * table, a figure or a card ending the text grew a phantom caret line that
 * vanished at settle (stream audit 2026-10, A1).
 *
 * So the caret is a node: {@link rehypeStreamingCaret} appends it to the
 * deepest last element that holds running text (a paragraph, a list item, a
 * heading, a table cell) of the block still being written, and every block
 * keeps its own display. Where the text ends in something that holds no
 * running text (a figure, a card slot, a code block) there is no caret: that
 * block shows its own progress, and a caret beside it would need a line.
 *
 * What the caret looks like is the surface's (`MarkdownRenderer`'s `caret`
 * prop); this module only places it, and reads it from context so the hast
 * node carries nothing but its position.
 */

import { createContext, useContext, type ReactNode } from 'react'
import type { Element, ElementContent, Root, RootContent } from 'hast'

import { ANSWER_BLOCK_TAG, ANSWER_ENERGY_TAG, ANSWER_MARKER_TAG, ANSWER_PROJECT_TAG } from './directives'
import { BLOCK_BODY_TAG } from './directive-shape'

/**
 * The hast tag the caret node carries. A custom element name, like the slot's,
 * so markdown can never produce one; the renderer's override always
 * intercepts it and nothing reaches the DOM under this name.
 */
export const STREAMING_CARET_TAG = 'streaming-caret'

/** Elements whose own text the caret may follow. */
const TEXT_HOSTS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th'])
/**
 * Elements the caret looks inside for the last text host. The dialect's two
 * plain wrappers are on it; its other blocks rearrange or copy their children
 * (a `:::compare` builds a stack per variant from its cells), where a caret
 * would land twice or nowhere.
 */
const CONTAINERS = new Set(['ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', ANSWER_BLOCK_TAG, BLOCK_BODY_TAG])

/**
 * Inline markup a text host may end in: the caret follows it on the line. Any
 * other element (a code block in a list item, a card slot, a figure) is drawn
 * after the text, where a caret would sit on a line of its own.
 */
const INLINE = new Set([
  'a', 'abbr', 'b', 'br', 'code', 'del', 'em', 'i', 'img', 'input', 'kbd', 'mark', 's', 'span', 'strong', 'sub', 'sup', 'u',
  ANSWER_MARKER_TAG, ANSWER_ENERGY_TAG, ANSWER_PROJECT_TAG,
])

/** Inline markup that is only text with a weight: the veil fades it like the text around it. */
const PLAIN_INLINE = new Set(['b', 'del', 'em', 'i', 's', 'strong', 'u'])

const isElement = (node: RootContent | ElementContent): node is Element => node.type === 'element'
const isBlank = (node: RootContent | ElementContent): boolean =>
  (node.type === 'text' && node.value.trim() === '') || node.type === 'comment'

/** The last child that shows anything: whitespace between blocks is not one. */
function lastMeaningful(children: (RootContent | ElementContent)[]): RootContent | ElementContent | undefined {
  for (let index = children.length - 1; index >= 0; index--) {
    if (!isBlank(children[index])) return children[index]
  }
  return undefined
}

const hasText = (node: ElementContent): boolean =>
  node.type === 'text' ? node.value.trim() !== '' : isElement(node) && node.children.some(hasText)

/**
 * The cell of a row the caret follows: the last one written into. GFM pads a
 * row still arriving with empty cells, and the caret belongs after the word
 * just written, not in the empty last column.
 */
function lastWrittenCell(row: Element): Element | undefined {
  const cells = row.children.filter((child): child is Element => isElement(child) && (child.tagName === 'td' || child.tagName === 'th'))
  for (let index = cells.length - 1; index >= 0; index--) {
    if (cells[index].children.some(hasText)) return cells[index]
  }
  return cells.at(-1)
}

/** Where the caret goes in `tree`: the deepest last text host, or null when the text ends in something else. */
export function caretHost(tree: Root): Element | null {
  let current = lastMeaningful(tree.children)
  while (current && isElement(current)) {
    const next: RootContent | ElementContent | undefined =
      current.tagName === 'tr' ? lastWrittenCell(current) : lastMeaningful(current.children)
    if (CONTAINERS.has(current.tagName) && next && isElement(next) && (CONTAINERS.has(next.tagName) || TEXT_HOSTS.has(next.tagName))) {
      current = next
      continue
    }
    if (!TEXT_HOSTS.has(current.tagName)) return null
    // A host whose last child is its own running text, or inline markup in it.
    // Nothing at all is a host just opened (an empty cell, `- `).
    return !next || !isElement(next) || INLINE.has(next.tagName) ? current : null
  }
  return null
}

/**
 * The rehype plugin. Runs last, after the table and directive passes, so they
 * read cells without the caret in them. Appends with a new array: a pass
 * before it may share a cell's children with a copy it built.
 */
export function rehypeStreamingCaret() {
  return (tree: Root) => {
    const host = caretHost(tree)
    if (!host) return
    // What the caret follows: running text the veil may fade, or markup with a
    // ground of its own (an inline code span, a citation pill) the veil, drawn
    // in the card's colour, would paint over.
    const before = lastMeaningful(host.children)
    const afterText = !before || before.type === 'text' || (isElement(before) && PLAIN_INLINE.has(before.tagName))
    host.children = [
      ...host.children,
      { type: 'element', tagName: STREAMING_CARET_TAG, properties: { dataAfter: afterText ? 'text' : 'markup' }, children: [] },
    ]
  }
}

const CaretContext = createContext<ReactNode>(null)

/** What the caret node draws. */
export const StreamingCaretProvider = CaretContext.Provider

/**
 * The override for {@link STREAMING_CARET_TAG}: the surface's caret, read from
 * context, in a box that takes no part in layout (`display: contents`) and
 * says what the caret follows, for a veil to hide itself after markup
 * (`data-caret-after`).
 */
export function MarkdownCaret({ node }: { node?: Element }) {
  const caret = useContext(CaretContext)
  if (caret === null) return null
  return (
    <span className="contents" data-caret-after={node?.properties?.dataAfter === 'markup' ? 'markup' : 'text'}>
      {caret}
    </span>
  )
}
