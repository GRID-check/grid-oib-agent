/**
 * Which same-origin paths `/_next/image` is allowed to serve.
 *
 * ## The belief this module used to encode, and why it was wrong
 *
 * "Local images need no allow-list" was true up to Next 15 and is false in 16.
 * When `images.localPatterns` is left unset, Next does not skip the check — it
 * fills in a default of `[{ pathname: '**', search: '' }]` (see
 * `next/dist/server/config.js`), so every local path is allowed *as long as it
 * carries no query string*. A local `src` with a query is rejected before the
 * underlying route is ever invoked, with `"url" parameter is not allowed` and a
 * 400. It is an anti-enumeration measure: without it, `/_next/image` will
 * happily optimize (and cache) every `?id=1`, `?id=2`, … a stranger asks for.
 *
 * Our signed document images are exactly that shape — the authorization rides
 * in the query (`?org=&v=&exp=&sig=`, see `signed-image-url.ts`) — so every
 * preview and thumbnail in the app went blank on the Next 16 upgrade.
 *
 * ## Why the patterns live here rather than in `next.config.ts`
 *
 * Two things have to agree, and a disagreement is invisible until an image is
 * blank in production: the `images.localPatterns` allow-list (which decides what
 * `/_next/image` will fetch) and the `unoptimized` decision at the call site
 * (which decides whether we ask it to at all). This is the same arrangement
 * `avatar-hosts.ts` uses for remote hosts, for the same reason — one source of
 * truth, and `local-image-patterns.spec.ts` cross-checks it against Next's own
 * matcher so an upgrade that changes the rules again fails a test instead of a
 * page.
 *
 * NOTE: imported by `next.config.ts`, so this module must stay free of path
 * aliases, `server-only`, and any other import the config loader cannot follow.
 */

/**
 * The signed document-image route: `/api/documents/<id>/image`.
 *
 * `*` does not cross a `/` in picomatch (the matcher Next uses), and document
 * ids are URL-encoded into a single segment, so this names that one route and
 * nothing beneath it.
 */
export const DOCUMENT_IMAGE_PATHNAME_PATTERN = '/api/documents/*/image'

/** Recognise the one path we allow a query string on, without a glob engine. */
const DOCUMENT_IMAGE_PATHNAME = /^\/api\/documents\/[^/]+\/image$/

/**
 * The value of `images.localPatterns` in `next.config.ts`.
 *
 * Entry one restates Next's own default, so every other local image keeps
 * behaving exactly as it does today: defining `localPatterns` REPLACES the
 * default rather than extending it, and dropping this entry would break
 * `/public` assets and static imports wholesale.
 *
 * Entry two omits `search`, which allows any query string on that path. An
 * exact `search` match is the safer form and is not available to us: the query
 * carries a per-document HMAC, so there is no fixed string to match. What makes
 * that acceptable here is the signature itself — the route verifies it before
 * reading a byte, so an enumerated URL yields a 403, not an image, and nothing
 * an attacker can mint enters the optimizer's cache.
 */
export const LOCAL_IMAGE_PATTERNS = [
  { pathname: '**', search: '' },
  { pathname: DOCUMENT_IMAGE_PATHNAME_PATTERN },
] as const

/**
 * Can `/_next/image` serve this src?
 *
 * The rule is a `next/image` fact rather than a domain one, which is why it
 * lives on its own: the optimizer accepts a root-relative path if it matches
 * `images.localPatterns` above, and any absolute URL only if its host is in
 * `images.remotePatterns` (see `avatar-hosts.ts`). The presigned object-store
 * URL document images fall back to when signing is unavailable is neither, and
 * asking the optimizer for it would yield a broken image rather than a slow one.
 *
 * Call sites use this to drive `unoptimized`, so an ineligible src degrades to
 * direct-from-origin instead of failing. That fail-soft posture is the point: a
 * local image the config would reject renders unoptimized rather than blank.
 */
export function isOptimizerEligible(src: string | null | undefined): boolean {
  // A protocol-relative `//host/path` is remote despite the leading slash, and
  // the optimizer rejects it outright.
  if (!src || !src.startsWith('/') || src.startsWith('//')) return false

  const queryAt = src.indexOf('?')
  // No query string: covered by the `**` pattern, like every other local image.
  if (queryAt === -1) return true

  // With one, only the signed document-image route is allow-listed.
  return DOCUMENT_IMAGE_PATHNAME.test(src.slice(0, queryAt))
}
