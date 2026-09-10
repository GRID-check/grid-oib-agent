/**
 * The `agent_document` producer's renderer, on its own and pure.
 *
 * Split out of `./agent-document` for one reason: the UPDATE path has to render
 * through it too (a version's replacement bytes are the model's Markdown and
 * must carry the same marking and the same branding as its first draft), and
 * that path lives in `./version-content`, which `./lifecycle` imports. A direct
 * import of `./agent-document` from there would close a cycle — that module
 * imports the lifecycle to create a version. The renderer itself needs neither.
 *
 * ## Why the marking is written into the text
 *
 * A `.docx` carries the marking as a typed OOXML property and a `.pdf` in its
 * Info dictionary. **Markdown has no metadata at all.** There is no header, no
 * side-car and no place to hang a property that survives being pasted into a
 * Word document, mailed, or attached to an Einreichung — so the marking has to
 * be part of the prose, or it is not in the file. A renderer that emitted it as
 * an HTML comment would satisfy the check and lose it on the first "paste as
 * plain text"; a fenced block at the END of the document survives that, and is
 * the last thing a reader sees before deciding whether to forward it.
 */

import type { AiProvenanceMarking } from '@/lib/ai-provenance'
import type { DocumentBranding } from './branding'
import type { GeneratedRendering } from './generated'

/** The stored content type. Markdown, because the next turn edits it as text. */
export const AGENT_DOCUMENT_MEDIA_TYPE = 'text/markdown'

/**
 * The bytes of an agent-written document: the model's Markdown, wrapped in what
 * every file Piloti produces has to say about itself, plus the marking, as
 * text.
 *
 * Exported and pure so a test can assert on the STRING — the filing seam
 * already asserts the marking is in the bytes, and this is where a reader
 * checks that the branding and the marking are in a place a person will
 * actually see.
 *
 * ## Where each piece goes, and why it is not all in one place
 *
 * ONE line above the title and a block below it, rather than a single block at
 * either end.
 *
 * The line is chrome: „Erstellt mit Piloti für …" is the Markdown equivalent of
 * the PDF's running header, it identifies the file at a glance in a preview
 * pane, and one line does not turn the document into an appendix to its own
 * front matter.
 *
 * The block is the disclaimer, and it stays at the FOOT for the reason the
 * marking does: the first line of a filed document is its title, and three
 * sentences of liability above it turn every preview and every paste into a
 * disclaimer with a document underneath. It is also the last thing a reader
 * sees before deciding whether to forward the file, which is the moment it is
 * about.
 *
 * `branding` is a parameter and not an import, so this function stays pure and
 * so the resolution — which reads an organization's override — happens once, at
 * the filing seam, rather than inside a renderer that would then have to be
 * async to do it.
 */
export function renderAgentDocumentMarkdown(
  body: string,
  marking: AiProvenanceMarking,
  branding: DocumentBranding,
): GeneratedRendering {
  const footer = [
    `**${branding.productName} — ${branding.tagline}**`,
    branding.prose,
    branding.disclaimer,
    branding.footerLine,
  ].join('\n\n')
  const text =
    `${branding.headerLine}\n\n${body.trim()}\n\n---\n\n${footer}\n\n` +
    `<!-- ${branding.aiGeneratorName} -->\n\n\`\`\`\n${marking}\n\`\`\`\n`
  return {
    bytes: new TextEncoder().encode(text),
    contentType: AGENT_DOCUMENT_MEDIA_TYPE,
    marking,
  }
}
