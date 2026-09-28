/**
 * The answer's Markdown dialect: a few `remark-directive` blocks that tell the
 * renderer what a run of plain Markdown IS, so it can draw it as richly as the
 * retired cards drew the same content.
 *
 * Markdown is the transport. A directive never carries data a reader would lose
 * without it: wrapped around a GFM table or a list, it only says "this table is
 * a check" or "this list is a procedure". So the dialect has two readers:
 *
 *  - the renderer (`shared/components/MarkdownRenderer/directives.ts`), which
 *    turns each block into its designed form;
 *  - everything that leaves the app as text (copy, Word, PDF), which reads the
 *    same Markdown with the directives taken out ({@link stripDirectives}): a
 *    table stays a table, a `details` block is printed open, `:klasse[B]` is
 *    „B".
 *
 * The vocabulary is deliberately this small. A name the renderer does not know
 * degrades to its content, never to nothing and never to `:::` on the page.
 */

/** Blocks, written `:::name` … `:::` around the Markdown they describe. */
export const DIRECTIVE_BLOCKS = ['pruefung', 'verfahren', 'faelle', 'kennzahlen', 'vergleich', 'details'] as const
export type DirectiveBlock = (typeof DIRECTIVE_BLOCKS)[number]

/**
 * Inline markers, written `:name` inside a list item, a table cell or a header.
 * What each one prints as when the directives are stripped.
 */
export const DIRECTIVE_MARKERS = {
  /** The step of a `:::verfahren` the project is at. */
  aktuell: 'aktuell',
  /** The case of a `:::faelle` that applies to this project. */
  trifft: 'trifft zu',
  /** The column of a `:::vergleich` the answer recommends. */
  empfohlen: 'empfohlen',
} as const
export type DirectiveMarker = keyof typeof DIRECTIVE_MARKERS

/** The Energieeffizienzklassen `:klasse[…]` accepts, best first. */
export const ENERGY_CLASSES = ['A++', 'A+', 'A', 'B', 'C', 'D', 'E', 'F', 'G'] as const

/** `:klasse[b ]` → `B`, or null for anything that is not a class. */
export function energyClass(label: string): (typeof ENERGY_CLASSES)[number] | null {
  const normal = label.replace(/\s+/g, '').toUpperCase()
  return (ENERGY_CLASSES as readonly string[]).includes(normal) ? (normal as (typeof ENERGY_CLASSES)[number]) : null
}

export const isDirectiveBlock = (name: string): name is DirectiveBlock =>
  (DIRECTIVE_BLOCKS as readonly string[]).includes(name)

export const isDirectiveMarker = (name: string): name is DirectiveMarker =>
  Object.prototype.hasOwnProperty.call(DIRECTIVE_MARKERS, name)

/** A code fence opener or closer, at most three spaces in (also inside a list item). */
const FENCE = /^\s*(`{3,}|~{3,})/
/** A container opener: `:::name`, optionally `[label]` and `{attributes}`. */
const OPENER = /^(\s*)(:{3,})([A-Za-z][\w-]*)(.*)$/
/** A container closer: colons alone on the line. */
const CLOSER = /^(\s*)(:{3,})\s*$/

/** What a line is to the dialect's block structure. */
export type FenceEvent = 'open' | 'close' | null

/**
 * Each line's part in the block structure: an opener, a closer that closes an
 * open block, or neither. Code is skipped (`:::` in a fence is code), and a
 * closer with nothing open is not one. The one scanner every reader of the
 * structure uses: {@link normalizeDirectiveFences}, and the renderer's block
 * splitter, which must never cut inside an open block.
 */
export function scanDirectiveFences(lines: readonly string[]): FenceEvent[] {
  let fence: string | null = null
  let open = 0
  return lines.map((line): FenceEvent => {
    const fenceMatch = FENCE.exec(line)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null
      return null
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      return null
    }
    if (OPENER.test(line)) {
      open += 1
      return 'open'
    }
    if (CLOSER.test(line) && open > 0) {
      open -= 1
      return 'close'
    }
    return null
  })
}

/** How many blocks are open BEFORE each line (an opener's line is at the depth outside it). */
export function directiveDepths(lines: readonly string[]): number[] {
  let depth = 0
  return scanDirectiveFences(lines).map((event) => {
    const before = depth
    if (event === 'open') depth += 1
    else if (event === 'close') depth -= 1
    return before
  })
}

interface OpenContainer {
  /** Line index of the opener. */
  line: number
  /** How many containers are open inside it at most, below it. */
  height: number
}

/**
 * The same text with every container fence given the colons its nesting needs.
 *
 * `remark-directive` closes a container at the first closing fence with at
 * least as many colons as its opener, so `:::verfahren` holding a
 * `:::details` is closed by the details' own `:::` and the procedure's list is
 * cut in two. The outer fence has to be longer (`::::verfahren`), which is a
 * rule a writer (a model, a person) gets wrong. So the renderer does not ask:
 * a bare `:::` closes the innermost open block, and each fence is rewritten to
 * `3 + the depth nested inside it` colons. An unclosed block (a streamed one)
 * stays open and runs to the end of the text, as `remark-directive` runs it.
 *
 * Code fences are skipped: `:::` inside a code block is code.
 */
export function normalizeDirectiveFences(markdown: string): string {
  if (!markdown.includes(':::')) return markdown
  const lines = markdown.split('\n')
  const stack: OpenContainer[] = []
  const pairs: { open: number; close: number | null; height: number }[] = []
  scanDirectiveFences(lines).forEach((event, index) => {
    if (event === 'open') {
      stack.push({ line: index, height: 0 })
      return
    }
    if (event !== 'close') return
    const closed = stack.pop() as OpenContainer
    pairs.push({ open: closed.line, close: index, height: closed.height })
    const parent = stack[stack.length - 1]
    if (parent) parent.height = Math.max(parent.height, closed.height + 1)
  })
  // Still open at the end of the text: the stream has not closed them yet.
  for (let at = stack.length - 1; at >= 0; at--) {
    const open = stack[at]
    pairs.push({ open: open.line, close: null, height: open.height })
    const parent = stack[at - 1]
    if (parent) parent.height = Math.max(parent.height, open.height + 1)
  }
  if (pairs.every(({ height }) => height === 0)) return markdown
  for (const { open, close, height } of pairs) {
    const colons = ':'.repeat(3 + height)
    lines[open] = lines[open].replace(OPENER, (_m, indent: string, _c, name: string, rest: string) => `${indent}${colons}${name}${rest}`)
    if (close !== null) lines[close] = lines[close].replace(CLOSER, (_m, indent: string) => `${indent}${colons}`)
  }
  return lines.join('\n')
}

/** `[label]` of an opener, unescaped enough to print. */
const openerLabel = (rest: string): string => {
  const match = /^\[([^\]]*)\]/.exec(rest.trim())
  return match ? match[1].trim() : ''
}

/** A text directive: `:name`, `:name[label]`, either with `{attributes}`. */
const TEXT_DIRECTIVE = /(^|[^\w:\\])(:)([A-Za-z][\w-]*)(?:\[([^\]\n]*)\])?(?:\{[^}\n]*\})?/g

/**
 * The Markdown with the dialect taken out, for everything that leaves the app
 * as text: the copy button, the Word and PDF export.
 *
 * - A block's fences go; what they held stays as it was written, so a table
 *   is still a table. A `details` block's label becomes a bold line over its
 *   content, which is printed open.
 * - A marker becomes its word in brackets (`:aktuell` → „(aktuell)"), because
 *   it is information: the step the project is at.
 * - `:klasse[B]` becomes „B".
 * - Anything else that merely looks like a directive (`10:30`, `Hinweis:Text`)
 *   is left exactly as written, which is also how the renderer shows it.
 *
 * Code is left alone.
 */
export function stripDirectives(markdown: string): string {
  if (!markdown.includes(':')) return markdown
  let fence: string | null = null
  const out: string[] = []
  for (const line of markdown.split('\n')) {
    const fenceMatch = FENCE.exec(line)
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null
      out.push(line)
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      out.push(line)
      continue
    }
    const opener = OPENER.exec(line)
    if (opener) {
      const label = openerLabel(opener[4])
      if (label) out.push(`${opener[1]}**${label}**`, '')
      continue
    }
    if (CLOSER.test(line)) continue
    out.push(stripTextDirectives(line))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** One line's text directives, as {@link stripDirectives} prints them. */
function stripTextDirectives(line: string): string {
  if (!line.includes(':')) return line
  // Inline code spans are split out first and left alone.
  return line
    .split(/(`[^`]*`)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(TEXT_DIRECTIVE, (whole, before: string, _colon, name: string, label?: string) => {
            if (name === 'klasse' && label !== undefined && energyClass(label)) return `${before}${energyClass(label)}`
            if (isDirectiveMarker(name) && label === undefined) return `${before}(${DIRECTIVE_MARKERS[name]})`
            return whole
          })
    )
    .join('')
}
