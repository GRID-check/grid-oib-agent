/**
 * The image the document image route serves when it has no tenant bytes to
 * give (`@/lib/documents/service` `streamDocumentImage`).
 *
 * ## Why a placeholder instead of an error status
 *
 * The route's only consumer is `next/image`, and Next's internal optimizer
 * fetch does not treat a non-200 upstream as a failure: `fetchInternalImage`
 * (`next/dist/server/image-optimizer.js`) ignores the status code entirely and
 * hands every non-empty body to magic-byte sniffing. A 403 (expired or forged
 * signature) or 404 (missing document, missing or empty thumbnail object)
 * arrives as a JSON error envelope, the sniffer finds no image magic in
 * `{"code":…}`, and the optimizer logs `The requested resource isn't a valid
 * image … received null` while serving a 400 to the browser (#366, x33).
 *
 * So no error shape from this route is optimizer-safe — not even an empty
 * body (that logs `internal image response is empty` instead). The only
 * response the optimizer accepts is 200 with sniffable image bytes, hence a
 * static 1x1 PNG: a warm paper grey that reads as an empty well rather than a
 * broken image. The failure is still observable — the service logs a `warn`
 * with the reason on every deflection — but it no longer pages as an error.
 *
 * ## Why serving this for forged signatures is safe
 *
 * Every failure deflects identically (expired, malformed, forged, missing
 * document, missing bytes), so the response is not an oracle: a forged token
 * learns nothing a missing document would not also say. And the bytes are
 * static — no tenant content can leak through this path by construction.
 *
 * Pure module, no `server-only` import: the bytes are needed by the service
 * and by specs asserting the served body.
 */

/** A 1x1 opaque warm paper grey (`#E8E6E1`) PNG, matching the card wells. */
const PLACEHOLDER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN48ewhAAVpArB44nOfAAAAAElFTkSuQmCC'

export const FALLBACK_IMAGE_CONTENT_TYPE = 'image/png'

let cachedBytes: Uint8Array | null = null

/** The placeholder bytes. Decoded once; callers must not mutate the result. */
export function fallbackImageBytes(): Uint8Array {
  if (!cachedBytes) {
    const binary = atob(PLACEHOLDER_PNG_BASE64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    cachedBytes = bytes
  }
  return cachedBytes
}

/**
 * The placeholder as a response: 200 with real PNG bytes, private and
 * short-lived. Short because the underlying state can heal — a re-ingest
 * regenerates a missing thumbnail under the same key, and a fresh signature
 * re-authorizes an expired one — and a cached deflection must not outlive the
 * heal by long.
 */
export function fallbackImageResponse(): Response {
  // `.slice()` copies: passing the cached array itself would let the Response
  // take ownership of the module's one copy.
  return new Response(fallbackImageBytes().slice(), {
    status: 200,
    headers: {
      'Content-Type': FALLBACK_IMAGE_CONTENT_TYPE,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
