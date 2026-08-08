/**
 * Capability URLs for document images (ADR-0038 posture: signature-authorized).
 *
 * ## Why this exists
 *
 * Document bytes live in SeaweedFS and used to reach the browser as presigned
 * object-store URLs. That is unoptimizable by construction, for two independent
 * reasons: the presigned host resolves to a private IP inside the compose
 * network, which `next/image` refuses to fetch (`dangerouslyAllowLocalIP` is
 * false by default), and every signature is a fresh URL, so the optimizer's
 * cache key changes on every request and it would re-download and re-encode the
 * original each time.
 *
 * Serving the same bytes from a SAME-ORIGIN route fixes both — the optimizer
 * resolves a local path in-process, and one allow-list entry covers the whole
 * route rather than a per-environment host. (It does need that entry: a local
 * `src` with a query string is refused unless `images.localPatterns` names its
 * path — see `optimizable.ts`.) But it introduces
 * the problem this module solves: the optimizer's internal fetch is a MOCKED
 * request built from the URL and method alone (`headers = {}`, see
 * `next/dist/server/lib/mock-request`), so it carries no session cookie. A route
 * behind `requireAuthorizedSession()` would hand it a 401 instead of an image.
 *
 * So authorization has to ride in the URL. The issuing endpoint is
 * session-authenticated and runs the real per-document check
 * (`getAccessibleDocument` → `project:view`); it then mints a signature that
 * says "the bearer was authorized for THIS document, in THIS org, until THEN".
 *
 * ## What the signature is bound to
 *
 * Organization, document id, variant and expiry — all four, so a token cannot be
 * walked sideways onto another document, another tenant, or the full-size
 * original when it was issued for a thumbnail.
 *
 * ## Why the expiry is bucketed rather than exact
 *
 * A per-request expiry would make every issued URL unique, which reintroduces
 * exactly the cache-key churn that made presigned URLs useless to the optimizer.
 * Rounding to a fixed window means every viewer of a document gets a
 * byte-identical URL for that window, so the optimizer caches once and serves
 * the resized image to everyone. The cost is that a leaked URL stays live for up
 * to two windows; the benefit is that optimization works at all. Two hours on a
 * capability that only ever yields one image the bearer could already read is
 * the right side of that trade.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Which object a token authorizes: the upload itself, or its ingest thumbnail. */
export type DocumentImageVariant = 'original' | 'thumb'

const SIGNATURE_DOMAIN = 'grid:document-image:v1'
const DEV_DEFAULT_TOKEN = 'grid-internal-dev-token'
const DEV_APP_ENVS = new Set(['development', 'dev', 'local'])

/** Expiry rounding, in seconds. Also the floor on a token's remaining life. */
export const IMAGE_URL_WINDOW_SECONDS = 3600

function isDevEnvironment(): boolean {
  const env = (process.env.APP_ENV ?? process.env.NODE_ENV ?? 'production').toLowerCase()
  return DEV_APP_ENVS.has(env)
}

/**
 * The HMAC key, or null when signing must not happen.
 *
 * Keyed on `GRID_INTERNAL_API_TOKEN` — already provisioned in every deployment
 * path (compose and Pulumi) and never exposed by an HMAC — with the domain
 * prefix above separating these tokens from any other use of the same secret.
 * Fail-closed on both counts, matching `@/lib/internal-auth`: an unset secret
 * disables the feature, and the well-known dev default is refused outside dev,
 * where it would let anyone mint a URL for any document.
 */
function signingSecret(): string | null {
  const secret = process.env.GRID_INTERNAL_API_TOKEN
  if (!secret) {
    warnDisabledOnce('GRID_INTERNAL_API_TOKEN is not set')
    return null
  }
  if (secret === DEV_DEFAULT_TOKEN && !isDevEnvironment()) {
    warnDisabledOnce(
      `GRID_INTERNAL_API_TOKEN is the well-known dev default and APP_ENV is ` +
        `"${process.env.APP_ENV ?? process.env.NODE_ENV ?? 'production'}". Anyone who has read ` +
        `the compose file could otherwise mint an image URL for any document, so signing is off. ` +
        `Set a real GRID_INTERNAL_API_TOKEN on this environment (note that APP_ENV is "production" ` +
        `on every deployed stack, dev ones included).`,
    )
    return null
  }
  return secret
}

/**
 * Say so, once, when image signing is unavailable.
 *
 * Falling back to a presigned object-store URL keeps every image RENDERING,
 * which is the right call — but it means the optimizer silently stops running,
 * and "images are unoptimized" is invisible from the outside short of noticing
 * that a preview does not feel like a WebP. That is a terrible way to find out.
 * One line in the container log, naming the variable to set, turns a silent
 * degradation into a greppable one.
 */
let disabledWarningLogged = false
function warnDisabledOnce(reason: string): void {
  if (disabledWarningLogged) return
  disabledWarningLogged = true
  console.error(
    `[signed-image-url] Document image optimization is DISABLED: ${reason}. ` +
      `Images fall back to presigned object-store URLs and next/image will not resize them.`,
  )
}

/** Test hook — lets a spec assert the warning fires rather than inheriting a latch. */
export function resetSigningWarning(): void {
  disabledWarningLogged = false
}

export interface DocumentImageClaims {
  organizationId: string
  documentId: string
  variant: DocumentImageVariant
  /** Unix seconds, bucketed by {@link IMAGE_URL_WINDOW_SECONDS}. */
  exp: number
}

function signature(claims: DocumentImageClaims, secret: string): string {
  const message = [
    SIGNATURE_DOMAIN,
    claims.organizationId,
    claims.documentId,
    claims.variant,
    String(claims.exp),
  ].join(':')
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex')
}

/**
 * The expiry every URL minted in the current window shares. Between one and two
 * windows of remaining life, never less — see the note on bucketing above.
 */
export function imageUrlExpiry(nowMs: number = Date.now()): number {
  const nowSeconds = Math.floor(nowMs / 1000)
  return (Math.floor(nowSeconds / IMAGE_URL_WINDOW_SECONDS) + 2) * IMAGE_URL_WINDOW_SECONDS
}

/**
 * Build the same-origin, signed path for a document image, or null when the
 * signing secret is unavailable (callers fall back to the presigned object-store
 * URL, which still renders — just without the optimizer).
 *
 * Returned as a ROOT-RELATIVE path on purpose: `next/image` only treats a local
 * URL as local, and the optimizer only skips the remote allow-list, when the
 * `src` starts with a single `/`.
 */
export function buildDocumentImageUrl(
  organizationId: string,
  documentId: string,
  variant: DocumentImageVariant,
  nowMs: number = Date.now(),
): string | null {
  const secret = signingSecret()
  if (!secret) return null

  const claims: DocumentImageClaims = {
    organizationId,
    documentId,
    variant,
    exp: imageUrlExpiry(nowMs),
  }
  const query = new URLSearchParams({
    org: organizationId,
    v: variant,
    exp: String(claims.exp),
    sig: signature(claims, secret),
  })
  return `/api/documents/${encodeURIComponent(documentId)}/image?${query.toString()}`
}

/** A rejected verification, and why — the route maps these onto status codes. */
export type ImageUrlRejection = 'disabled' | 'malformed' | 'expired' | 'bad-signature'

export type ImageUrlVerification =
  | { ok: true; claims: DocumentImageClaims }
  | { ok: false; reason: ImageUrlRejection }

/**
 * Verify a request's query against the signature. Constant-time on the
 * signature comparison, and expiry is checked BEFORE the comparison so a stale
 * token is never distinguishable from a forged one by timing.
 */
export function verifyDocumentImageUrl(
  documentId: string,
  params: URLSearchParams,
  nowMs: number = Date.now(),
): ImageUrlVerification {
  const secret = signingSecret()
  if (!secret) return { ok: false, reason: 'disabled' }

  const organizationId = params.get('org')
  const variant = params.get('v')
  const exp = Number(params.get('exp'))
  const provided = params.get('sig')

  if (!organizationId || !provided) return { ok: false, reason: 'malformed' }
  if (variant !== 'original' && variant !== 'thumb') return { ok: false, reason: 'malformed' }
  if (!Number.isSafeInteger(exp) || exp <= 0) return { ok: false, reason: 'malformed' }

  if (exp * 1000 <= nowMs) return { ok: false, reason: 'expired' }

  const claims: DocumentImageClaims = { organizationId, documentId, variant, exp }
  const expected = signature(claims, secret)

  // timingSafeEqual throws on a length mismatch, which a hex-length check
  // settles first — and a wrong length is already a forgery, not a near miss.
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad-signature' }
  }
  return { ok: true, claims }
}
