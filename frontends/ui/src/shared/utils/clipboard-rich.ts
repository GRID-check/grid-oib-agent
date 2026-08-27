/**
 * Markdown onto the clipboard in BOTH flavors — rendered HTML and the source.
 *
 * `writeText` alone hands Word, Outlook and Google Docs the literal `**bold**`
 * and `| a | b |`, which is precisely the structure the copy buttons exist to
 * preserve. A `ClipboardItem` carrying `text/html` beside `text/plain` lets the
 * paste target pick: rich editors take the rendered table and emphasis, plain
 * surfaces (a terminal, a markdown editor) still get the markdown source.
 *
 * The HTML flavor is produced by `marked` — the same renderer the docx/pdf
 * exports parse with — imported lazily so the chat bundle only pays for it on
 * the first copy. Raw inline HTML in the source is neutralised by escaping `<`
 * before parsing: the in-app renderer (react-markdown) shows such fragments as
 * text, and the clipboard must not quietly interpret what the screen did not.
 *
 * Throws when nothing could be written, so the caller owns the failure toast.
 */
export async function copyMarkdownToClipboard(markdown: string): Promise<void> {
  // `ClipboardItem` is the capability gate: browsers without it (or without
  // clipboard.write) still get the markdown source via writeText.
  if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard.write !== 'function') {
    await navigator.clipboard.writeText(markdown)
    return
  }

  let html: string
  try {
    const { marked } = await import('marked')
    html = await marked.parse(markdown.replace(/</g, '&lt;'), { gfm: true, breaks: false })
  } catch {
    // The chunk failed to load (offline, a deploy in between): the markdown
    // source is still a correct copy, so degrade rather than fail.
    await navigator.clipboard.writeText(markdown)
    return
  }

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([markdown], { type: 'text/plain' }),
      }),
    ])
  } catch {
    // Some engines accept writeText but reject write() with multiple types
    // (older Safari): fall back before reporting failure.
    await navigator.clipboard.writeText(markdown)
  }
}
