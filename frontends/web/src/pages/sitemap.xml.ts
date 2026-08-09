import type { APIRoute } from 'astro'
import { getBlogPosts, postSlug } from '../lib/posts'

/**
 * Hand-rolled rather than `@astrojs/sitemap`: the site is four page types plus
 * posts, and the interesting part is the hreflang pairing, which an integration
 * that crawls the output directory cannot infer. Written as an endpoint so the
 * blog collection stays the single source of truth for what is published
 * (drafts are filtered out by `getBlogPosts`).
 */

/** Page paths that exist in both locales, given as the German path. */
const BILINGUAL = ['/', '/blog/', '/impressum/', '/datenschutz/']

const enPath = (path: string) => `/en${path === '/' ? '/' : path}`

/** One `<url>`, with the hreflang pair when the page has a counterpart. */
function url(site: URL, loc: string, pair?: { de: string; en: string }) {
  const lines = ['  <url>', `    <loc>${new URL(loc, site).href}</loc>`]
  if (pair) {
    const de = new URL(pair.de, site).href
    const en = new URL(pair.en, site).href
    lines.push(
      `    <xhtml:link rel="alternate" hreflang="de" href="${de}"/>`,
      `    <xhtml:link rel="alternate" hreflang="en" href="${en}"/>`,
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${de}"/>`
    )
  }
  lines.push('  </url>')
  return lines.join('\n')
}

export const GET: APIRoute = async ({ site }) => {
  // `site` comes from astro.config.mjs; without it only relative paths could be
  // emitted, and a sitemap of relative paths is worse than no sitemap.
  if (!site) return new Response('sitemap unavailable: no `site` configured', { status: 404 })

  const entries = BILINGUAL.flatMap((path) => {
    const pair = { de: path, en: enPath(path) }
    return [url(site, pair.de, pair), url(site, pair.en, pair)]
  })

  // Posts are authored per locale and are not translations of each other, so
  // they carry no alternate links — claiming one would point at a 404.
  for (const locale of ['de', 'en'] as const) {
    for (const post of await getBlogPosts(locale)) {
      const path = `/blog/${postSlug(post.id)}/`
      entries.push(url(site, locale === 'de' ? path : enPath(path)))
    }
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...entries,
    '</urlset>',
    '',
  ].join('\n')

  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
}
