/**
 * A markdown document cut into its top-level blocks, so the renderer can parse
 * each block on its own and keep the ones whose source did not change.
 *
 * Why (2026-09): a streamed answer is revealed every 50 ms, and each step
 * re-parsed the WHOLE shown answer (remark, rehype, KaTeX, JSX) and reconciled
 * every element in it. On a phone at a 4× throttled CPU that was a 17 ms render
 * per step and about 100 ms of parsing per second, growing with the answer's
 * length. Only the last block of a growing answer changes, so only the last
 * block needs parsing.
 *
 * Markdown is not safely incremental, which is why this is conservative and
 * recomputed from the whole text every time rather than extended:
 *
 * - A cut is made only at a blank line, outside a fenced code or math block,
 *   and only before a line that starts at column 0. An indented line after a
 *   blank may continue a list item or an indented code block.
 * - A list item after a blank line is not cut from a block that holds a list
 *   item: the blank line would make the two one loose list, and a loose list
 *   is drawn differently from a tight one.
 * - A setext underline (`---`, `===`) or a table's delimiter row cannot follow
 *   a blank line and still belong to the block above it, so neither needs a
 *   rule: a line that turns the paragraph above into a heading or a table
 *   changes that block's own source, and the block is parsed again.
 * - A directive block (`:::check` … `:::`) is one construct however many
 *   blank lines it holds, so no cut is made while one is open; an unclosed
 *   one (a streamed answer) runs to the end, as `remark-directive` runs it.
 * - Some constructs reach across blocks: a link reference definition
 *   (`[x]: url`) resolves `[x]` anywhere in the document, a footnote (`[^1]`)
 *   collects its definitions into a section at the end, and an HTML block
 *   (`<!-- … -->`) can span blank lines. A text holding any of them is not
 *   split at all ({@link splitMarkdownBlocks} returns `null`), and is rendered
 *   whole, as before.
 *
 * The rule the renderer is held to is the one `docs/design/streaming-chat-answer.md`
 * set before this existed: for every prefix of the recorded answers, the blocks
 * rendered one by one must give the same HTML as the whole text rendered at once
 * (`streaming-markdown-equivalence.spec.tsx`).
 */

import type { Root as HastRoot } from 'hast'
import { directiveDepths } from '@/lib/text/answer-directives'

/** One top-level run of a markdown document. */
export interface MarkdownBlock {
  /** The block's source, without the blank lines before it (and, but for the last block, after it). */
  source: string
  /** 0-based index of the block's first line in the whole text. */
  line: number
}

interface Fence {
  char: string
  length: number
}

/** An opening code fence (```` ``` ````, `~~~`) or math fence (`$$`), at most three spaces in. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,}|\${2,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,}|\${2,})[ \t]*$/
/** A list item marker at most three spaces in. A thematic break (`- - -`) matches as well; that only means no cut. */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const BLANK = /^[ \t]*$/
/**
 * What makes a text unsafe to split: a definition or footnote (`]:`, `[^`), a
 * line that may open an HTML block (`<` at the start of a line, also inside a
 * quote), and a carriage return, which CommonMark reads as a line ending and
 * this module does not.
 */
const CROSS_BLOCK = /\]:|\[\^|^[ \t>]*<|\r/m

const openingFence = (line: string): Fence | null => {
  const match = FENCE_OPEN.exec(line)
  if (!match) return null
  const marker = match[1]
  const char = marker[0]
  // A backtick fence's info string may not hold a backtick, and a math fence's
  // meta may not hold a dollar: either line is inline code or math instead.
  if (char !== '~' && match[2].includes(char)) return null
  return { char, length: marker.length }
}

const closesFence = (line: string, fence: Fence): boolean => {
  const match = FENCE_CLOSE.exec(line)
  return match !== null && match[1][0] === fence.char && match[1].length >= fence.length
}

/** Can the block that starts at `line` (after a blank line) be parsed apart from the one before it? */
const startsOwnBlock = (line: string, previousHoldsList: boolean): boolean => {
  if (line[0] === ' ' || line[0] === '\t') return false
  return !(previousHoldsList && LIST_ITEM.test(line))
}

/**
 * A first block of nothing but placement markers (`[[card:2]]`, `[[callout]]`)
 * may render nothing at all: the chat strips a marker it cannot place. The
 * blank-line separator the whole document would put between two blocks
 * ({@link rehypeBlockSeparator}) needs a block before it that rendered, so such
 * a block is joined to the one after it.
 */
const onlyMarkers = (source: string): boolean => source.replace(/\[\[[^\]\n]*\]\]/g, '').trim() === ''

/**
 * The fewest characters a block holds before the text is cut after it.
 *
 * Each block is a parse of its own, and a parse has a fixed cost (building the
 * processor, combining the syntax extensions) on top of its length. When a turn
 * ends every block is parsed again (the chat's plugins stop drawing pending
 * markers), so a block per paragraph made that settle cost nearly twice what
 * parsing the text whole does. For an 11k-character answer (2026-09, vitest,
 * unthrottled), per reveal step and at the settle: whole text 25 ms and 24 ms,
 * a block per paragraph 1.6 ms and 45 ms, blocks of 1200 characters 3 ms and
 * 28 ms (2000 gave no more).
 */
export const MIN_BLOCK_CHARS = 1200

/**
 * The top-level blocks of `markdown`, in order, or `null` when the text holds a
 * construct that reaches across blocks and must be rendered whole.
 *
 * A cut is made at the first safe place after a block has reached `minChars`,
 * and where that is depends only on the text before it, so a cut, once made,
 * stays where it is while the text after it grows.
 */
export function splitMarkdownBlocks(markdown: string, minChars: number = MIN_BLOCK_CHARS): MarkdownBlock[] | null {
  if (CROSS_BLOCK.test(markdown)) return null
  const lines = markdown.split('\n')
  const blocks: MarkdownBlock[] = []
  let start = -1
  let end = -1
  /** Characters in the block so far, newlines included. */
  let size = 0
  let gap = false
  let holdsList = false
  let fence: Fence | null = null
  // Blocks open before each line, from the dialect's one fence scanner: a
  // line inside a `:::check` is never a place to cut.
  const depths = directiveDepths(lines)

  lines.forEach((line, index) => {
    size += line.length + 1
    if (fence) {
      if (closesFence(line, fence)) fence = null
      end = index + 1
      return
    }
    if (depths[index] > 0) {
      end = index + 1
      return
    }
    if (BLANK.test(line)) {
      gap = start >= 0
      return
    }
    if (start < 0) start = index
    else if (gap && size >= minChars && startsOwnBlock(line, holdsList)) {
      blocks.push({ source: lines.slice(start, end).join('\n'), line: start })
      start = index
      size = line.length + 1
      holdsList = false
    }
    gap = false
    end = index + 1
    if (LIST_ITEM.test(line)) holdsList = true
    fence = openingFence(line)
  })
  // The last block runs to the end of the text, blank lines and all: at the end
  // of the document they are not always nothing (an indented code block keeps
  // the whitespace of a trailing line that is still being written).
  if (start >= 0) blocks.push({ source: lines.slice(start).join('\n'), line: start })

  while (blocks.length > 1 && onlyMarkers(blocks[0].source)) {
    const [first, second] = blocks
    const between = lines.slice(first.line, second.line).join('\n')
    blocks.splice(0, 2, { source: `${between}\n${second.source}`, line: first.line })
  }
  return blocks
}

/** Where a block's render learns that the document goes on after it. */
const CONTINUES = 'markdownBlockContinues'

interface FileWithData {
  data: Record<string, unknown>
}

/**
 * The remark plugin the renderer runs first on every block but the last: it
 * tells a later plugin that the tree it sees is not the end of the document.
 * A plugin that acts on the document's end (the chat strips a half-written
 * `[[card:` there) reads {@link documentContinues} and leaves a block that is
 * followed by more alone.
 */
export const remarkBlockContinues = () => (_tree: unknown, file: FileWithData) => {
  file.data[CONTINUES] = true
}

/** Does more of the document follow the tree this file was parsed into? */
export const documentContinues = (file: FileWithData | undefined): boolean => file?.data[CONTINUES] === true

/**
 * The rehype plugin the renderer runs on every block but the first: the line
 * break the whole document would put between two top-level elements, written
 * before this block's first one. Only a block that renders anything gets it,
 * as a node removed by a plugin gets no separator in the whole document either.
 */
export const rehypeBlockSeparator = () => (tree: HastRoot) => {
  if (tree.children.length > 0) tree.children.unshift({ type: 'text', value: '\n' })
}
