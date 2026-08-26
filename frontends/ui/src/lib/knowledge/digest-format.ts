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

/**
 * Render `header` plus one line per item, appending in order until `maxChars`
 * would be exceeded. Returns null when no item survives — callers omit the
 * block entirely rather than injecting a bare header.
 */
export function formatBoundedDigest(
  header: string,
  items: DigestLineItem[],
  maxChars: number
): string | null {
  if (items.length === 0) return null

  const lines: string[] = [header]
  let used = header.length
  for (const item of items) {
    const content = item.content.replace(/\s+/g, ' ').trim()
    if (!content) continue
    const escaped = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const line = `- [${item.tags.join(' | ')}] "${escaped}"`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }

  return lines.length > 1 ? lines.join('\n') : null
}
