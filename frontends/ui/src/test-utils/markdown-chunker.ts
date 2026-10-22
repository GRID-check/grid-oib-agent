/**
 * How the knowledge layer's Markdown chunker reads a `.md`, for specs that
 * write one: its two expressions (`section_chunking.ATX_HEADING_RE`,
 * `text_formats._FENCE_RE`) over Python's `str.splitlines()`. A spec that
 * proves text cannot become a section proves it against this reading, which
 * is not JavaScript's: Python ends a line at more terminators than `^` does,
 * and its `\s` holds more separators than JavaScript's.
 */

/** Python's `\s` on a str: Unicode white space, the separators `\x1c`–`\x1f` and `\x85` included. */
const PY_SPACE = String.raw`[\s\x1c-\x1f\x85]`
const ATX_HEADING = new RegExp(`^#{1,6}${PY_SPACE}+.+?${PY_SPACE}*#*${PY_SPACE}*$`)
const FENCE = new RegExp(`^${PY_SPACE}*(\`\`\`|~~~)`)

/** Python's `str.splitlines()`: every terminator it honours ends a line, `\r\n` as one, no empty last line. */
export function pythonSplitlines(value: string): string[] {
  const lines = value.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

/** The lines the chunker takes for a heading, and how many it takes for a fence. */
export function chunkerReads(markdown: string): { headings: string[]; fences: number } {
  const lines = pythonSplitlines(markdown)
  return {
    headings: lines.filter((line) => ATX_HEADING.test(line)),
    fences: lines.filter((line) => FENCE.test(line)).length,
  }
}
