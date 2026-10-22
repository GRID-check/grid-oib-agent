/**
 * The held mail's text as the detail shows it: plain text only, the first
 * lines first.
 *
 * The text arrives already flattened and masked by the server
 * (`inbound-mail-text-get`): HTML is never rendered, no remote image is ever
 * loaded, and a link is shown as the text it is, never made live (a stranger
 * wrote it). React escapes it; nothing here builds markup.
 *
 * Pure.
 */

/** How many lines the detail shows before „Ganze E-Mail anzeigen“. */
export const PREVIEW_LINES = 6
/** And at most this many characters: one long paragraph is one line, and could fill the screen. */
export const PREVIEW_CHARS = 600

export interface TextPreview {
  /** The lines shown before the fold, blank runs collapsed. */
  head: string
  /** Whether anything is behind the fold. */
  more: boolean
}

/** Collapse three or more line breaks to one blank line, and trim the edges. */
export function tidyText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function textPreview(text: string, lines = PREVIEW_LINES, chars = PREVIEW_CHARS): TextPreview {
  const tidy = tidyText(text)
  const all = tidy.split('\n')
  let head = all.length <= lines ? tidy : all.slice(0, lines).join('\n').trimEnd()
  if (head.length > chars) {
    // Cut at the last space before the limit, so no word is broken in half.
    const cut = head.lastIndexOf(' ', chars)
    head = `${head.slice(0, cut > chars / 2 ? cut : chars).trimEnd()} …`
  }
  return { head, more: head !== tidy }
}

/** The domain a URL in the text points to, for the hint beside it; null for anything that is not an http(s) URL. */
export function linkDomain(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.replace(/^www\./, '') : null
  } catch {
    return null
  }
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/giu

/** The text cut into plain runs and URLs, so a URL can be shown as inert text with its domain. Never markup. */
export function textRuns(text: string): Array<{ kind: 'text'; value: string } | { kind: 'link'; value: string; domain: string }> {
  const runs: Array<{ kind: 'text'; value: string } | { kind: 'link'; value: string; domain: string }> = []
  let last = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0
    const domain = linkDomain(match[0])
    if (!domain) continue
    if (start > last) runs.push({ kind: 'text', value: text.slice(last, start) })
    runs.push({ kind: 'link', value: match[0], domain })
    last = start + match[0].length
  }
  if (last < text.length) runs.push({ kind: 'text', value: text.slice(last) })
  return runs
}
