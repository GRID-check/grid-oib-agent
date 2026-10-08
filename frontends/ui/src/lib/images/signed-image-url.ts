/**
 * Capability URLs for document images (ADR-0038 posture: signature-authorized).
 *
 * ## Why this exists
 *
 * Document bytes live in SeaweedFS and used to reach the browser as presigned
 * object-store URLs. That is unoptimizable by construction: the presigned host
 * resolves to a private IP inside the compose network, which `next/image`
 * refuses to fetch (`dangerouslyAllowLocalIP` is false by default).
 *
 * Serving the same bytes from a SAME-ORIGIN route fixes that — the optimizer
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
 * says "THIS person was authorized for THIS document, in THIS org, until THEN".
 *
 * The person is in the claim so that the route can ask the question again. The
 * optimizer's fetch carries no session, but the token names the one it was
 * minted for, and `streamDocumentImage` re-checks that person's CURRENT read
 * access to the folder when the URL is used. A role taken away, or a folder
 * tightened, stops loading images within the role cache's minute
 * (`lib/auth/membership-roles.ts`), not when the URL expires.
 *
 * That holds only because nothing answers for the route without calling it.
 * The optimizer's server-side cache did: a cached or even stale copy was served
 * without a fetch, and a failed refetch re-stored it, so `next.config.ts` turns
 * that cache off (`maximumDiskCacheSize: 0`). What remains is the browser's own
 * cache, which keeps a picture it has already been shown for at most
 * {@link IMAGE_URL_WINDOW_SECONDS} ({@link DOCUMENT_IMAGE_CACHE_CONTROL}, and
 * `images.minimumCacheTTL`); `optimizer-cache.spec.ts` holds both.
 *
 * ## What the signature is bound to
 *
 * Organization, person, document id, variant and expiry — all five, so a token
 * cannot be walked sideways onto another document, another tenant, or the
 * full-size original when it was issued for a thumbnail, and cannot be used
 * after the person it names has lost the folder.
 *
 * Not to a standing the route cannot ask again. Who may see a document held
 * back by the upload screen (ADR-0085) is its uploader and its reviewers, a
 * rule over session roles the token does not carry, so the route serves
 * screened files only and the mint issues no URL for a held one: a URL minted
 * before a re-upload was held stops working, for everyone, the moment it is.
 * The uploader and the reviewers preview a held image through the presigned
 * object-store URL their own session check produced.
 *
 * ## Why the expiry is bucketed rather than exact
 *
 * A per-request expiry would make every issued URL unique, so no cache could
 * ever reuse a response. Rounding to a fixed window means one person gets a
 * byte-identical URL for a document throughout that window, so their browser
 * fetches it once rather than on every re-render or revisit. The cost is that a
 * leaked URL stays live for up to two windows. The window is five minutes: it
 * was an hour, and the access it carries (project membership, which the route
 * cannot re-check without a session) outlived a revocation by up to two hours.
 * The folder is re-checked on every use regardless of the window.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Which object a token authorizes: the upload itself, or its ingest thumbnail. */
export type DocumentImageVariant = 'original' | 'thumb'

const SIGNATURE_DOMAIN = 'grid:document-image:v2'
const DEV_DEFAULT_TOKEN = 'grid-internal-dev-token'
const DEV_APP_ENVS = new Set(['development', 'dev', 'local'])

/** Expiry rounding, in seconds. Also the floor on a token's remaining life. */
export const IMAGE_URL_WINDOW_SECONDS = 300

/**
 * What the route sends. Private, and no longer-lived than one window: the
 * optimizer passes the max-age on (as `public`, see `next.config.ts`), so this
 * is what bounds how long a browser keeps the picture without asking again.
 */
export const DOCUMENT_IMAGE_CACHE_CONTROL = `private, max-age=${IMAGE_URL_WINDOW_SECONDS}`

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
  /** The WorkOS user id the URL was minted for, whose access is re-checked when it is used. */
  userId: string
  documentId: string
  variant: DocumentImageVariant
  /** Unix seconds, bucketed by {@link IMAGE_URL_WINDOW_SECONDS}. */
  exp: number
}

function signature(claims: DocumentImageClaims, secret: string): string {
  const message = [
    SIGNATURE_DOMAIN,
    claims.organizationId,
    claims.userId,
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

/** The clock tests pin. */
export interface DocumentImageUrlOptions {
  nowMs?: number
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
  userId: string,
  documentId: string,
  variant: DocumentImageVariant,
  { nowMs = Date.now() }: DocumentImageUrlOptions = {},
): string | null {
  const secret = signingSecret()
  if (!secret) return null

  const claims: DocumentImageClaims = {
    organizationId,
    userId,
    documentId,
    variant,
    exp: imageUrlExpiry(nowMs),
  }
  const query = new URLSearchParams({
    org: organizationId,
    u: userId,
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
  const userId = params.get('u')
  const variant = params.get('v')
  const exp = Number(params.get('exp'))
  const provided = params.get('sig')

  if (!organizationId || !userId || !provided) return { ok: false, reason: 'malformed' }
  if (variant !== 'original' && variant !== 'thumb') return { ok: false, reason: 'malformed' }
  if (!Number.isSafeInteger(exp) || exp <= 0) return { ok: false, reason: 'malformed' }

  if (exp * 1000 <= nowMs) return { ok: false, reason: 'expired' }

  const claims: DocumentImageClaims = { organizationId, userId, documentId, variant, exp }
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
