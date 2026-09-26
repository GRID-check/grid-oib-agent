/**
 * Unlisted pages: public at their URL, but found only by someone given the
 * link. Each is `noindex, nofollow`, filtered out of the sitemap
 * (astro.config.mjs reads `UNLISTED`), and named by nothing else: no link on
 * another page, no line in robots.txt (a Disallow would publish the path) and
 * none in llms.txt. frontends/web/AGENTS.md, "Unlisted pages".
 *
 * The slug is the only secret, so it is written here and nowhere else. A new
 * one: a word and eight random lowercase letters. Changing it breaks every
 * link handed out.
 */

/** The riso image downloads: /<slug>/ and /en/<slug>/, the ZIPs under /<slug>/. */
export const DOWNLOADS_SLUG = 'bildmaterial-jjrnesos'

/** Every unlisted slug, for the sitemap filter. */
export const UNLISTED = [DOWNLOADS_SLUG] as const
