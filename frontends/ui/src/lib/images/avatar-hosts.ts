/**
 * The remote hosts whose avatars the Next image optimizer is allowed to fetch.
 *
 * This is the SINGLE source of truth for two things that must never drift
 * apart: the `images.remotePatterns` allow-list in `next.config.ts` (which
 * decides what `/_next/image` will fetch at all) and the `unoptimized` decision
 * at the call site (which decides whether we even ask it to). A host in one and
 * not the other is either a broken image or a silently unoptimized one, so both
 * read from here.
 *
 * Why an allow-list rather than a wildcard: `remotePatterns: ['**']` turns the
 * deployment into an open image proxy that anybody can point at any URL.
 *
 * Every profile picture WorkOS hands us today is a `workoscdn.com/images/v1/…`
 * URL — it re-hosts OAuth pictures (Google, Microsoft, …) on its own CDN rather
 * than passing the provider's URL through, so one entry covers every user in
 * the directory. A future SSO or Directory Sync connection could in principle
 * supply a raw IdP URL, which is exactly why call sites fall back to
 * `unoptimized` for an unrecognised host instead of rendering a broken image.
 *
 * NOTE: imported by `next.config.ts`, so this module must stay free of path
 * aliases, `server-only`, and any other import the config loader cannot follow.
 */

/** Remote patterns, in the shape `images.remotePatterns` expects. */
export const AVATAR_IMAGE_PATTERNS = [
  { protocol: 'https', hostname: 'workoscdn.com', pathname: '/images/**' },
] as const

/**
 * Whether `/_next/image` can serve this avatar — i.e. whether the URL matches an
 * allow-listed pattern. A `false` here is not an error: the caller renders the
 * image `unoptimized` (straight from the origin) so an unexpected host degrades
 * to today's behaviour rather than to a broken disc.
 */
export function isOptimizableAvatarUrl(url: string | null | undefined): boolean {
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Relative or malformed. Relative avatar URLs are already same-origin and
    // optimizable, but we have never been handed one; treat anything we cannot
    // parse as "leave it alone".
    return false
  }
  return AVATAR_IMAGE_PATTERNS.some(
    (pattern) =>
      `${pattern.protocol}:` === parsed.protocol &&
      pattern.hostname === parsed.hostname &&
      // `/images/**` — the prefix before the glob is the whole check we need.
      parsed.pathname.startsWith(pattern.pathname.replace(/\*+$/, '')),
  )
}
