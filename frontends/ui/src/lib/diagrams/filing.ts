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
 * and `findDocumentAuthoredByRef` with it, in the same commit and derived from
 * each other, which is the move 0064's own header prescribes for exactly this
 * case. The alternative — two synthetic ids, `{ref}:svg` and `{ref}:pdf` —
 * needed no migration and was rejected: `authored_by_ref` exists so somebody
 * can later ask what wrote a file and where it came from, and a key that joins
 * back to nothing is what the schema calls "an audit trail in appearance only".
 *
 * ## Partial filing, and why retry is the compensation
 *
 * The two calls are not one transaction, so the PDF can fail after the SVG has
 * landed. Nothing is rolled back, and that is deliberate: the SVG is the
 * artifact that carries the source, so it is the half worth keeping, and
 * `fileGeneratedDocument` is idempotent per (reference, producer) — which is what
 * makes the retry the compensation. Filing again finds the SVG already filed,
 * renders and files only the PDF, and costs the reader one more click instead
 * of a report that quietly vanished.
 *
 * **So a PDF failure is a RESULT here, not a throw**, and `pdf: null` is what
 * says so. This paragraph used to describe a design the code did not have:
 * `FiledDiagram` required both halves and this function simply awaited the PDF,
 * so the one case the paragraph is about — the SVG landed, the PDF did not —
 * threw. The route turned that into `Internal server error`, the client into a
 * red line, and the reader was told nothing had happened while a quota-charged
 * SVG sat in Berichte with their diagram in it. Being told "it failed" about a
 * file that exists is worse than being told nothing: it is the one answer that
 * makes the reader stop looking.
 *
 * The failure is swallowed only in the direction where a partial result is
 * TRUE. The SVG's own failure still throws, because there is no half to report:
 * nothing was written, and a caller that got `{ svg: null }` back would have to
 * invent an error message this module already has.
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
   * The identity of the diagram this is an artifact OF: the chat answer the
   * model drew it in, plus a hash of the source, so one answer holding two
   * diagrams files two documents.
   *
   * It is `authored_by_ref` and half the idempotency key, so filing the same
   * diagram twice files nothing twice: pressing the button again on a message
   * that already has its files is a no-op that answers with the ids it already
   * had.
   *
   * **Not a run id, and no longer called one.** Until migration 0066 this field
   * was `runId` and landed in a column called `authored_by_run_id` whose comment
   * said "the backend async job id of the run" — a sentence that was true of the
   * research producer and of nothing here. The kind of identity this is now
   * travels with it, declared once against the producer in
   * `GENERATED_DOCUMENT_PRODUCER_REF_KINDS`, so the row and the
   * `document.generated` audit target both say `answer_artifact` rather than
   * pointing an auditor at a job store this value was never in.
   */
  answerRef: string
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
  /**
   * The half that always landed: if this one had failed, this function threw.
   */
  svg: FiledGeneratedDocument
  /**
   * The PDF, or `null` when only the SVG landed.
   *
   * Nullable because the two writes are not one transaction and the caller has
   * to be able to tell a reader which half is in the project — see the header.
   * `null` is not an error the caller has to handle: it is a smaller success,
   * and the compensation for it is pressing the button again.
   */
  pdf: FiledGeneratedDocument | null
}

export async function fileDiagramDocuments(input: FileDiagramInput): Promise<FiledDiagram> {
  // Validated BEFORE anything is authorized or stored, because this is the step
  // that decides whether the request is a diagram at all. `acceptDiagram`
  // throws a named `DiagramSvgError`; the route turns it into a 400 the client
  // can act on rather than a 500 it can only retry.
  //
  // That ORDER is deliberate and it survives review: `apiRoute` has already
  // required an authenticated session, so this is never reachable anonymously,
  // and refusing a submission that is not a diagram before the project
  // permission is read is what keeps a rejected diagram from leaving half a
  // diagram in somebody's project. The price is that the parser must survive
  // hostile input from ANY authenticated session — which is what the 1 MiB byte
  // cap, `MAX_DIAGRAM_SVG_DEPTH` and the route's own body bound are for. An
  // input that gets past all three has already been judged cheap.
  const accepted = acceptDiagram(input)
  const svgBytes = new TextEncoder().encode(accepted.svg)

  const svg = await fileGeneratedDocument({
    session: input.session,
    projectId: input.projectId,
    producer: 'diagram_svg',
    ref: input.answerRef,
    title: input.title,
    request: input.request,
    // The bytes this renderer returns are the bytes `svg.ts` wrote out of its
    // own allow-list — never the request's. That is the whole reason the
    // validator returns a string instead of a boolean.
    render: () => ({ bytes: svgBytes, contentType: 'image/svg+xml' }),
  })

  try {
    const pdf = await fileGeneratedDocument({
      session: input.session,
      projectId: input.projectId,
      producer: 'diagram_pdf',
      ref: input.answerRef,
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
  } catch (error) {
    // Everything this can throw — a quota refusal, an object-store timeout, a
    // renderer that will not draw this particular geometry — leaves the same
    // world behind: the SVG is filed and the PDF is not. That is a fact about
    // the project, so it is reported as one. Rethrowing would replace a true
    // sentence the reader can act on with a false one they cannot.
    //
    // The reason is not lost, it is just not the reader's business: it is
    // logged for the operator here, because the client's remedy (press it
    // again) is the same whatever the cause, and a message naming a bucket or a
    // quota row in a figcaption is noise to an architect and detail to an
    // attacker.
    console.error('[diagrams] the SVG was filed and the PDF was not', {
      projectId: input.projectId,
      answerRef: input.answerRef,
      svgDocumentId: svg.documentId,
      cause: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
    })
    return { svg, pdf: null }
  }
}
