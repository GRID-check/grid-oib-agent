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
import { PDF_MEDIA_TYPE, renderMarkdownPdf } from '@/lib/pdf/markdown-pdf'

const generatePdfSchema = z.object({
  /**
   * Non-empty, because an empty string renders a blank page and a blank page
   * downloads as a file the user then has to open to discover is empty.
   */
  markdown: z.string().min(1),
})

export const POST = apiRoute(
  async ({ request }) => {
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
