/**
 * The machine-readable AI marking, in the one place both exporters read it.
 *
 * ## Why this is a module and not two sets of string literals
 *
 * The printed *"KI-generiert — nicht geprüft"* block is for the reader. This is
 * for everything else — a records system, a Behörde's intake, a compliance scan
 * — which is what the AI Act's transparency obligation actually asks for:
 * marking that does not depend on somebody reading page one and believing it.
 *
 * A detector matches on NAMES. The moment the same document is offered in two
 * formats, "the same marking" is a claim about four strings agreeing across two
 * files that share no code — and the failure mode is silent: a `.pdf` marked
 * `AIGenerated` and a `.docx` marked `AiGenerated` both look marked, and a scan
 * configured for one finds nothing in the other. So the names live here, and
 * `answer-export/docx.ts` and `pdf/markdown-pdf.ts` are both readers of them.
 *
 * Nothing here is server-only: it is four constants and a formatter, and the
 * modules that use them carry their own `server-only` where they need it.
 */

/**
 * The name a downstream detector matches on. Stable: it is an interface.
 *
 * It is the product's name rather than the library's on purpose — `react-pdf`
 * and this repo's OOXML writer are implementation details that will change, and
 * an office searching its archive for machine-written documents searches for
 * the thing that wrote them.
 */
export const AI_GENERATOR_NAME = 'Piloti'

/**
 * The property names, spelled once.
 *
 * `.docx` writes them as typed OOXML custom properties; `.pdf` writes them into
 * the Info dictionary's `Keywords` (see {@link aiProvenanceKeywords} for why
 * that field and not another). Different carriers, one vocabulary.
 */
export const AI_PROVENANCE_PROPERTIES = {
  generated: 'AIGenerated',
  generator: 'AIGenerator',
  humanReviewed: 'AIHumanReviewed',
  runId: 'AIRunId',
} as const

/** What a machine is told about how the document came to exist. */
export interface AiProvenance {
  /**
   * The agent run that produced the content, when the caller knows it. Absent
   * rather than empty when it does not: a run id nobody can look up is worse
   * than no run id, because it reads like an audit trail.
   */
  runId?: string
}

/**
 * The marking as one PDF `Keywords` string.
 *
 * ## The limit this function exists to work around, stated plainly
 *
 * A `.docx` is an OPC package, so the marking gets its own part with its own
 * named, typed properties. **A PDF written by `@react-pdf/renderer` 4.6.0 has
 * no equivalent.** `<Document>` accepts exactly the Info-dictionary fields —
 * `title`, `author`, `subject`, `keywords`, `creator`, `producer`, `language`,
 * `creationDate`, `modificationDate` (checked against
 * `node_modules/@react-pdf/renderer/index.d.ts`, `interface DocumentProps`) —
 * and `renderer/lib/react-pdf.js` maps them one-for-one onto PDFKit's `info`.
 * There is no custom-key facility and no XMP hook: the underlying
 * `@react-pdf/pdfkit` does have `appendXML`, but it is reachable only through
 * the `subset` option (PDF/A, PDF/UA), which `<Document>` does not expose.
 *
 * So the closest supported field carries the whole marking, and `Keywords` is
 * the one Info field that is a LIST by convention — a reader that splits it on
 * `;` gets the four properties back, and a reader that does not still sees the
 * words. `Creator` carries {@link AI_GENERATOR_NAME} alongside it so a tool
 * that only reads the obvious field is not left with nothing.
 *
 * If react-pdf ever grows an XMP escape hatch, this is the function to change,
 * and the property names above do not move.
 */
export function aiProvenanceKeywords(provenance: AiProvenance): string {
  const parts = [
    `${AI_PROVENANCE_PROPERTIES.generated}=true`,
    `${AI_PROVENANCE_PROPERTIES.generator}=${AI_GENERATOR_NAME}`,
    `${AI_PROVENANCE_PROPERTIES.humanReviewed}=false`,
  ]
  if (provenance.runId) parts.push(`${AI_PROVENANCE_PROPERTIES.runId}=${provenance.runId}`)
  return parts.join('; ')
}
