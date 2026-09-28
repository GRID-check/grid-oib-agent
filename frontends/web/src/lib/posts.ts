import { getCollection, type CollectionEntry } from 'astro:content'
import type { Locale } from '../i18n/ui'
import type { Category } from './categories'

export type BlogPost = CollectionEntry<'blog'>

/**
 * Preview builds render drafts, so an author can see a post before it is
 * published. Set only by the blog-preview workflow, never by the Docker build:
 * `astro build` bakes the result into the image, so a truthy value in a release
 * build would publish every unfinished draft to the live site.
 */
const includeDrafts = import.meta.env.PUBLIC_INCLUDE_DRAFTS === '1'

/** `de/mein-post` -> `mein-post`. */
export function postSlug(id: string) {
  return id.slice(3)
}

/**
 * Posts published on the same day need an order both locales agree on, or the
 * build log would number one entry 01 in German and 02 in English. The German
 * slug is shared by both (English posts carry it as `translationSlug`).
 */
function pairKey(post: BlogPost) {
  const slug = postSlug(post.id)
  return post.id.startsWith('de/') ? slug : (post.data.translationSlug ?? slug)
}

function newestFirst(a: BlogPost, b: BlogPost) {
  const byDate = b.data.pubDate.valueOf() - a.data.pubDate.valueOf()
  return byDate !== 0 ? byDate : pairKey(b).localeCompare(pairKey(a))
}

/** Posts for one locale, newest first, drafts hidden outside preview builds. */
export async function getBlogPosts(locale: Locale, category?: Category) {
  const posts = await getCollection(
    'blog',
    ({ id, data }) =>
      (includeDrafts || !data.draft) &&
      id.startsWith(`${locale}/`) &&
      (!category || data.category === category)
  )
  return posts.sort(newestFirst)
}

/**
 * The running number of each post within its category, oldest = 1, the way a
 * site diary numbers its entries. Takes the newest-first list getBlogPosts
 * returns; posts of every category may be mixed in it.
 */
export function entryNumbers(posts: BlogPost[]) {
  const counts = new Map<Category, number>()
  const numbers = new Map<string, number>()
  for (const post of [...posts].reverse()) {
    const n = (counts.get(post.data.category) ?? 0) + 1
    counts.set(post.data.category, n)
    numbers.set(post.id, n)
  }
  return numbers
}

/** Dates as the blog prints them: long form in prose, ISO-like in the log. */
export function formatDate(date: Date, locale: Locale, style: 'long' | 'log' = 'long') {
  if (style === 'log') return date.toISOString().slice(0, 10).replaceAll('-', '.')
  return date.toLocaleDateString(locale === 'en' ? 'en-GB' : 'de-AT', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
