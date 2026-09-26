import type { MetadataRoute } from 'next'

/**
 * The app is behind sign-in and belongs in no search index; the public site
 * (frontends/web) is what gets found. Crawling stays allowed ON PURPOSE: a
 * crawler that is disallowed never fetches a page, so it never sees the
 * `noindex` that keeps the URL out of results, and can still list it bare from
 * a link elsewhere. The noindex comes from `metadata.robots` in layout.tsx and
 * the `X-Robots-Tag` header in next.config.ts.
 */
const robots = (): MetadataRoute.Robots => ({
  rules: { userAgent: '*', allow: '/' },
})

export default robots
