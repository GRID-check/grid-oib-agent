/**
 * Markdown a person is reading, as a PDF they can keep.
 *
 * The Download-PDF button in the research panel's report tab
 * (`features/layout/components/ExportFooter.tsx` → `hooks/use-download-pdf.ts`)
 * posts the report the user is looking at and gets a file back. `ReportCard`
 * does the same from its own footer.
 *
 * ## Why this file exists, when the route already did
 *
 * It was `src/pages/api/generate-pdf.ts` — a Pages-Router handler with **no
 * session check at all**. It read `req.body.markdown` and rendered it, for
 * anyone who could reach the origin: an unauthenticated CPU-and-memory sink,
 * and a way to have the product's own domain serve a PDF containing whatever
 * text the caller supplied.
 *
 * That it survived is a lesson about where the gate lives rather than about
 * anyone's care. ADR-0038 made the posture a required argument of `apiRoute`,
 * and `app/api/authz-coverage.spec.ts` walks `app/api/**\/route.ts` to catch
 * what a type cannot see — but it walks `app/api`, so a route under `pages/`
 * was outside both the compiler's reach and the spec's. The route was not
 * exempted; it was invisible.
 *
 * So the fix is not "add a session read to the Pages handler". It is to move
 * the route inside the enforcement, where the declaration below is compulsory
 * and the coverage spec counts it. The path is unchanged — `/api/generate-pdf`
 * — so no client changes, and `src/pages/` is gone entirely, which is what
 * stops the next handler from landing in the same blind spot.
 *
 * **What the move cost, and what took its place.** The Pages handler inherited
 * a 1 MB body limit from `api.bodyParser.sizeLimit`, which it never declared
 * and nobody had to think about. An App Router handler inherits nothing, so
 * the move handed an unbounded string to `renderToStream` — the same class of
 * regression as the missing session check, and invisible for the same reason:
 * what was lost was a DEFAULT, so there is no deleted line to notice. Both
 * bounds are therefore written down below, with the measurement behind each.
 *
 * ## Why `sessionOnly`
 *
 * The bytes come from the request. This route reads nothing, owns nothing, and
 * can leak nothing that the caller did not already have in hand — so there is
 * no resource to authorize against and a per-resource check would be theatre.
 * What it needs is to not be free to the internet, which authentication is.
 *
 * Rate limiting is the factory's `DEFAULT_MUTATION_LIMIT`, applied to every
 * mutating method unless a route says otherwise (ADR-0040). It is declared by
 * omission on purpose: rendering a PDF is expensive, and the default bound is
 * the one thing this endpoint was missing that a signed-in caller could still
 * abuse.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { PayloadTooLargeError } from '@/lib/api/errors'
import { MAX_MARKDOWN_PDF_CHARS, PDF_MEDIA_TYPE, renderMarkdownPdf } from '@/lib/pdf/markdown-pdf'

/**
 * The largest JSON body this route will read: the ceiling the Pages Router
 * applied for free, put back where it can be seen.
 *
 * `src/pages/api/generate-pdf.ts` declared no `config`, so Next's Pages default
 * `api.bodyParser.sizeLimit: '1mb'` bounded every request to it. **App Router
 * handlers have no such default** — `next.config`'s `serverActions.bodySizeLimit`
 * governs Server Actions only, and this deployment's transport ceiling is the
 * 250 MB one sized for `.ifc` uploads — so moving the route out of `pages/`
 * silently removed a limit nobody had written down. This is that limit,
 * restated: the same 1 MiB, now enforced by the handler that needs it.
 *
 * It bounds the TRANSPORT and not the work. A 1 MiB body of markdown is minutes
 * of one blocked worker and over a gigabyte of peak RSS, so the render has its
 * own, much smaller bound — see {@link MAX_MARKDOWN_PDF_CHARS}.
 */
const MAX_PDF_REQUEST_BYTES = 1024 * 1024

/**
 * The largest markdown this route will RENDER is not this route's number any
 * more: it is {@link MAX_MARKDOWN_PDF_CHARS}, and it lives with the renderer.
 *
 * It was declared here, and the second caller of `renderMarkdownPdf` — a filed
 * research report — was written without it, which is the whole argument for
 * moving it: this handler is a caller, and a bound that only a caller applies
 * is a bound the next caller has to remember. The renderer now refuses on its
 * own behalf, and the measurements behind the number are in its header (the
 * superlinear curve, the shape sensitivity, and why a timeout cannot be the
 * bound instead).
 *
 * The schema keeps refusing at the same threshold rather than deferring to the
 * throw, because the two refusals are not the same answer: this one is a 400
 * with the field named, before any render is attempted, which is what a client
 * posting a body can act on. The renderer's is the floor underneath it.
 */
const generatePdfSchema = z.object({
  /**
   * Non-empty, because an empty string renders a blank page and a blank page
   * downloads as a file the user then has to open to discover is empty.
   *
   * Bounded above because the schema stands directly in front of
   * `renderToStream`, whose cost is superlinear in its input and whose layout
   * pass blocks the event loop for the whole of it — with
   * `DEFAULT_MUTATION_LIMIT` admitting 300 mutations a minute per member.
   */
  markdown: z.string().min(1).max(MAX_MARKDOWN_PDF_CHARS),
})

/**
 * Refuse a body that says up front it is too big, before it is buffered.
 *
 * `Content-Length` is a claim rather than a fact, so this is the cheap half:
 * a client that omits it is still bounded by the `.max()` above, one buffer
 * later. Both are needed — only this one runs before the bytes are read, and
 * only the schema holds when there is no header.
 */
function refuseOversizedBody(request: Request): void {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_PDF_REQUEST_BYTES) {
    throw new PayloadTooLargeError(MAX_PDF_REQUEST_BYTES)
  }
}

export const POST = apiRoute(
  async ({ request }) => {
    refuseOversizedBody(request)
    const { markdown } = await parseJsonBody(request, generatePdfSchema)

    // No `notice` and no `aiProvenance`. This is a person exporting prose they
    // have read on screen and chosen to download — the case
    // `MarkdownPdfOptions.aiProvenance` names as the reason the marking is
    // opt-in. A stamp on every PDF is a stamp that means nothing, which costs
    // exactly the documents that need one.
    const bytes = await renderMarkdownPdf(markdown)

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': PDF_MEDIA_TYPE,
        // The client names the file itself from the conversation title
        // (`use-download-pdf.ts` sets `a.download`), so this is the fallback
        // for a caller that does not — and it must still be an attachment, or
        // a browser renders it inline and the download silently does nothing.
        'Content-Disposition': 'attachment; filename="report.pdf"',
        // The markdown posted here is the live report; a cached response would
        // hand somebody a PDF of a version they are no longer looking at.
        'Cache-Control': 'no-store',
      },
    })
  },
  {
    authz: {
      sessionOnly: true,
      why: 'renders caller-supplied markdown and reads nothing — there is no resource to authorize against, only a rendering cost that must not be free to the internet.',
    },
  }
)
