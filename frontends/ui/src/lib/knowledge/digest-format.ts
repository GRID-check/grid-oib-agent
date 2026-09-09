/**
 * Bounded, injection-safe digest formatting — the one way free-text knowledge
 * rows become prompt lines. Shared by the project-memory digest
 * (`lib/projects/memory-service.ts`) and the platform-lessons digest
 * (`lib/platform-lessons/service.ts`) so both carry the same guarantees:
 *
 *  - Each item is ONE line: `- [tag | tag | …] "content"`. Content is
 *    whitespace-collapsed and wrapped in double quotes with internal quotes and
 *    backslashes escaped, so stored text can never forge an additional tag
 *    line or break out of its own entry.
 *  - The whole digest is bounded in characters, and items past the budget are
 *    dropped in order — the caller decides the order, this module enforces the
 *    ceiling.
 */

export interface DigestLineItem {
  /** Rendered inside the `[...]` bracket, joined with ` | `. */
  tags: string[]
  content: string
}

export interface RenderedDigest {
  text: string
  /**
   * Indices into `items` of the entries that actually reached the text, in the
   * order they appear in it.
   *
   * It is here because a caller that has to REPORT what it carried cannot
   * infer this: the character budget drops a tail, and a blank content is
   * skipped in the middle, so neither the input length nor a prefix of it is
   * the answer. ADR-0055 makes the digest name the notes it carried, and a
   * name list built from the selection rather than from the render is a list
   * that claims notes the model never saw.
   */
  included: number[]
}

/**
 * Render `header` plus one line per item, appending in order until `maxChars`
 * would be exceeded, and report which items made it. Returns null when no item
 * survives — callers omit the block entirely rather than injecting a bare
 * header.
 */
export function renderBoundedDigest(
  header: string,
  items: DigestLineItem[],
  maxChars: number
): RenderedDigest | null {
  if (items.length === 0) return null

  const lines: string[] = [header]
  const included: number[] = []
  let used = header.length
  for (const [index, item] of items.entries()) {
    const content = item.content.replace(/\s+/g, ' ').trim()
    if (!content) continue
    const escaped = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const line = `- [${item.tags.join(' | ')}] "${escaped}"`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    included.push(index)
    used += line.length + 1
  }

  return included.length > 0 ? { text: lines.join('\n'), included } : null
}

/** {@link renderBoundedDigest} for callers that need only the text. */
export function formatBoundedDigest(
  header: string,
  items: DigestLineItem[],
  maxChars: number
): string | null {
  return renderBoundedDigest(header, items, maxChars)?.text ?? null
}
