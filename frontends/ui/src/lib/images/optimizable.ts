/**
 * Can `/_next/image` serve this src?
 *
 * The rule is a `next/image` fact rather than a domain one, which is why it
 * lives on its own: the optimizer accepts a root-relative path unconditionally
 * (local images need no allow-list), and any absolute URL only if its host is in
 * `images.remotePatterns`. Document images are served root-relative by the
 * signed route for exactly this reason; the presigned object-store URL they fall
 * back to when signing is unavailable is not eligible, and asking the optimizer
 * for it would yield a broken image rather than a slow one.
 *
 * Call sites use this to drive `unoptimized`, so an ineligible src degrades to
 * today's direct-from-origin behaviour instead of failing.
 */
export function isOptimizerEligible(src: string | null | undefined): boolean {
  // A protocol-relative `//host/path` is remote despite the leading slash, and
  // the optimizer rejects it outright.
  return !!src && src.startsWith('/') && !src.startsWith('//')
}
