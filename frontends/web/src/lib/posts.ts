import { getCollection } from 'astro:content'
import type { Locale } from '../i18n/ui'

/**
 * Preview builds render drafts, so an author can see a post before it is
 * published. Set only by the blog-preview workflow, never by the Docker build:
 * `astro build` bakes the result into the image, so a truthy value in a release
 * build would publish every unfinished draft to the live site.
 */
const includeDrafts = import.meta.env.PUBLIC_INCLUDE_DRAFTS === '1'

/** Posts for one locale, newest first, drafts hidden outside preview builds. */
export async function getBlogPosts(locale: Locale) {
  const posts = await getCollection(
    'blog',
    ({ id, data }) => (includeDrafts || !data.draft) && id.startsWith(`${locale}/`)
  )
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf())
}

/** `de/mein-post` -> `mein-post`. */
export function postSlug(id: string) {
  return id.slice(3)
}
