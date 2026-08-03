/**
 * Document image bytes for a signed capability URL.
 *
 * This is the one document route that serves bytes without a session, and it is
 * `publicApiRoute` for an honest reason: the Next image optimizer fetches it
 * through an in-process MOCKED request carrying no headers and therefore no
 * session cookie, so a session gate here would return 401s to our own optimizer
 * instead of images. Authorization moves into the URL — see
 * `@/lib/images/signed-image-url` for what the signature binds and why its
 * expiry is bucketed.
 *
 * Thin handler; verification, tenancy and streaming live in the service.
 */

import { publicApiRoute } from '@/lib/api/handler'
import { streamDocumentImage } from '@/lib/documents/service'

type Params = { id: string }

export const GET = publicApiRoute<Params>(
  async ({ request, params }) =>
    streamDocumentImage(params.id, new URL(request.url).searchParams),
  {
    why:
      'Unauthenticated by necessity: the Next image optimizer fetches this route with a ' +
      'headerless internal request, so no session cookie can reach it. Authorization is the ' +
      'HMAC signature on the URL, minted by getDocumentPreview/getDocumentThumbnail only after ' +
      'getAccessibleDocument enforced project:view, and bound to org + document + variant + ' +
      'expiry. The route serves image content types only, and re-derives tenancy from the ' +
      'signed org claim rather than trusting the caller.',
  }
)
