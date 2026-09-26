/**
 * Cache-Control for the files the Astro node adapter serves from `dist/client`.
 *
 * The adapter's static handler (`send`) answers every file with
 * `public, max-age=0` unless a Cache-Control header is already on the
 * response, and only upgrades `/_astro/*` to immutable on a 200 with a body.
 * HEAD and 304 revalidations of those same assets still say `max-age=0`, and
 * `public/` files (fonts, art) never get anything else. `server.mjs` sets the
 * header below before the adapter runs, and `send` keeps it.
 *
 * Prerendered HTML is deliberately absent: it keeps the adapter's
 * `public, max-age=0` and its ETag, so every page view revalidates and a
 * deploy is visible on the next load.
 */

/** Content-hashed by Vite: the URL changes whenever the bytes do. */
export const IMMUTABLE = 'public, max-age=31536000, immutable'

/**
 * Unhashed files under `public/`. A week fresh, then one more day served stale
 * while the browser revalidates in the background against the ETag. Replacing
 * one of these files in place reaches a returning visitor up to eight days
 * late; give the new version a new name instead. Art keeps its name and gets a
 * new URL: the manifest (src/data/art.json) versions every src with ?v=<hash>.
 */
export const LONG_REVALIDATE = 'public, max-age=604800, stale-while-revalidate=86400'

/** Disjoint top-level directories, so the order does not matter. */
const RULES = [
  ['/_astro/', IMMUTABLE],
  ['/fonts/', LONG_REVALIDATE],
  ['/art/', LONG_REVALIDATE],
]

/**
 * The Cache-Control a static file at `pathname` should carry, or `undefined`
 * to leave the adapter's default. Pure: the caller decides whether the path is
 * a file that exists, so a 404 never gets a long lifetime.
 *
 * @param {string} pathname URL path, without query or fragment
 * @returns {string | undefined}
 */
export function cacheControlFor(pathname) {
  for (const [prefix, value] of RULES) {
    if (pathname.startsWith(prefix)) return value
  }
  return undefined
}
