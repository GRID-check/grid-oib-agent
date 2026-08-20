/**
 * The second and third producers: a diagram, as two files in the project.
 *
 * ## The architecture, stated rather than implied
 *
 * **Diagrams are laid out in the browser and filed by the BFF.** The browser
 * has the DOM that mermaid needs to lay out a graph; production has no browser
 * at all (`playwright-core` is a devDependency, and adding Chromium to the
 * production image is a deployment decision nobody has made). The BFF owns the
 * write, the quota and the audit. So the client sends the SVG it produced and
 * the source it produced it from, and this module admits them.
 *
 * The bytes therefore come from an authenticated user's browser. **That is the
 * same trust posture every upload already has** — a person's browser sends
 * bytes and the server stores them under that person's authority — and it is
 * written here rather than assumed, because "the client rendered it" reads like
 * "the server rendered it" and they are different claims. Nothing here can
 * assert the SVG is a faithful drawing of the source beside it. What is
 * asserted, by `svg.ts`, is that the file is inert and that what gets stored is
 * written from an allow-list rather than copied from the request.
 *
 * ## Two rows, and why not one
 *
 * A diagram is two artifacts, and they are not substitutes:
 *
 *   - the **SVG** previews in the Files pane today (`image/svg+xml` is already
 *     in `PREVIEW_TYPES`), is what a reader opens, and carries the diagram's
 *     own source in its `<metadata>` so the drawing can be regenerated or
 *     hand-edited a year later by whoever has the file;
 *   - the **PDF** is what gets attached to an Einreichung. A Behörde receives a
 *     bundle of PDFs, and an architect who has to convert a file first will
 *     convert it in whatever tool is open — which is where the marking line
 *     stops travelling with the drawing.
 *
 * One row cannot be both: a row has one storage key and one content type.
 * Storing the second artifact as a sibling object under the first row's prefix
 * was the version that needed no second row, and it is exactly what ADR-0042
 * forbids — bytes written outside the document service have no row and are
 * invisible to the quota ledger. So: two rows, two producers, one call each,
 * through the one admitting path.
 *
 * That collided with migration 0064, which allowed one machine-authored
 * document per (organization, project, run). Migration **0065** widens that key
 * and `findDocumentAuthoredByRun` with it, in the same commit and derived from
 * each other, which is the move 0064's own header prescribes for exactly this
 * case. The alternative — two synthetic run ids, `{run}:svg` and `{run}:pdf` —
 * needed no migration and was rejected: `authored_by_run_id` exists so somebody
 * can later ask what wrote a file and in which run, and a key that joins back
 * to no real run is what the schema calls "an audit trail in appearance only".
 *
 * ## Partial filing, and why retry is the compensation
 *
 * The two calls are not one transaction, so the PDF can fail after the SVG has
 * landed. Nothing is rolled back, and that is deliberate: the SVG is the
 * artifact that carries the source, so it is the half worth keeping, and
 * `fileGeneratedDocument` is idempotent per (run, producer) — which is what
 * makes the retry the compensation. Filing again finds the SVG already filed,
 * renders and files only the PDF, and costs the reader one more click instead
 * of a report that quietly vanished. The result says which halves landed so the
 * caller can tell the reader the truth rather than "done".
 */

import 'server-only'
import { fileGeneratedDocument, type FiledGeneratedDocument } from '@/lib/documents/generated'
import type { AuthorizedSession } from '@/lib/auth/types'
import { acceptDiagram, type DiagramSubmission } from './svg'
import { renderDiagramPdf } from './svg-to-pdf'

export interface FileDiagramInput extends DiagramSubmission {
  /** The commissioning human. Their permission is what authorizes the write. */
  session: AuthorizedSession
  projectId: string
  /**
   * The identity of the diagram this is an artifact OF — the chat message the
   * model wrote it in. It is `authored_by_run_id` and half the idempotency key,
   * so filing the same diagram twice files nothing twice: pressing the button
   * again on a message that already has its files is a no-op that answers with
   * the ids it already had.
   */
  runId: string
  /** What a reader should see in the Files pane. */
  title: string
  /**
   * The provenance line for the PDF, already in the reader's locale.
   *
   * Resolved by the route, not here, for the reason `answer-export` gives about
   * the same problem: this module runs on a request whose locale the caller has
   * already resolved, and a renderer that reaches for a dictionary renders one
   * language for every office.
   */
  marking: string
  request?: Request
}

export interface FiledDiagram {
  svg: FiledGeneratedDocument
  pdf: FiledGeneratedDocument
}

export async function fileDiagramDocuments(input: FileDiagramInput): Promise<FiledDiagram> {
  // Validated BEFORE anything is authorized or stored, because this is the step
  // that decides whether the request is a diagram at all. `acceptDiagram`
  // throws a named `DiagramSvgError`; the route turns it into a 400 the client
  // can act on rather than a 500 it can only retry.
  const accepted = acceptDiagram(input)
  const svgBytes = new TextEncoder().encode(accepted.svg)

  const svg = await fileGeneratedDocument({
    session: input.session,
    projectId: input.projectId,
    producer: 'diagram_svg',
    runId: input.runId,
    title: input.title,
    request: input.request,
    // The bytes this renderer returns are the bytes `svg.ts` wrote out of its
    // own allow-list — never the request's. That is the whole reason the
    // validator returns a string instead of a boolean.
    render: () => ({ bytes: svgBytes, contentType: 'image/svg+xml' }),
  })

  const pdf = await fileGeneratedDocument({
    session: input.session,
    projectId: input.projectId,
    producer: 'diagram_pdf',
    runId: input.runId,
    title: input.title,
    request: input.request,
    render: async (context) => ({
      bytes: await renderDiagramPdf({
        root: accepted.root,
        viewport: accepted.viewport,
        title: input.title,
        projectName: context.projectName,
        marking: input.marking,
        createdAt: new Date(),
      }),
      contentType: 'application/pdf',
    }),
  })

  return { svg, pdf }
}
