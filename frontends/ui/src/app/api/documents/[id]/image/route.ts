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
 *
 * Failures deflect to a static placeholder image (200) rather than refusing
 * with a 403/404: the optimizer ignores status codes and sniffs every
 * non-empty body as image bytes, so an error envelope became "isn't a valid
 * image … received null" (#366). All deflections answer identically with
 * static bytes, so nothing leaks and nothing is oracle-able.
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
