/**
 * The one reading of a fenced code block's fences, for every line scanner that
 * must skip code: the answer dialect's (`answer-directives.ts`) and the
 * renderer's block splitter (`markdown-blocks.ts`).
 *
 * Two scanners with two readings disagreed: a line such as ```` ```a``` inline ````
 * opened a fence for one and not the other, so one saw the rest of the answer
 * as code and cut inside a block the other saw open. CommonMark's rules, which
 * the renderer's parser follows:
 *
 * - an opener is three or more backticks or tildes; a backtick opener's info
 *   string may not hold a backtick (that line is inline code);
 * - a closer is the same character, at least as long, and nothing after it.
 */

export interface CodeFence {
  char: string
  length: number
}

export interface CodeFenceOptions {
  /** Also read `$$` math fences (the splitter's parser has remark-math). */
  math?: boolean
  /** How far in a fence may stand: 3 at the top level, unbounded inside list items. */
  maxIndent?: number
}

const OPENER = /^([ \t]*)(`{3,}|~{3,}|\${2,})(.*)$/
const CLOSER = /^([ \t]*)(`{3,}|~{3,}|\${2,})[ \t]*$/

const indentOk = (indent: string, maxIndent: number | undefined): boolean =>
  maxIndent === undefined || indent.length <= maxIndent

/** The fence `line` opens, or null. */
export function openingCodeFence(line: string, options: CodeFenceOptions = {}): CodeFence | null {
  const match = OPENER.exec(line)
  if (!match || !indentOk(match[1], options.maxIndent)) return null
  const marker = match[2]
  const char = marker[0]
  if (char === '$' && !options.math) return null
  // A backtick fence's info string may not hold a backtick, and a math fence's
  // meta may not hold a dollar: either line is inline code or math instead.
  if (char !== '~' && match[3].includes(char)) return null
  return { char, length: marker.length }
}

/** Whether `line` closes `fence`. */
export function closesCodeFence(line: string, fence: CodeFence, options: CodeFenceOptions = {}): boolean {
  const match = CLOSER.exec(line)
  return (
    match !== null && indentOk(match[1], options.maxIndent) && match[2][0] === fence.char && match[2].length >= fence.length
  )
}
