import rss from '@astrojs/rss'
import { ui, type Locale } from '../i18n/ui'
import { CATEGORIES, blogPath } from './categories'
import { getBlogPosts, postSlug } from './posts'

/** The blog of one locale as RSS 2.0, both strands, newest first. */
export async function blogFeed(locale: Locale, site: URL | undefined) {
  const t = ui[locale].seo
  const posts = await getBlogPosts(locale)
  return rss({
    title: t.rssTitle,
    description: t.rssDescription,
    // The channel's <link> is the listing; item links are absolute paths.
    site: new URL(blogPath(locale), site ?? 'https://piloti.at').href,
    trailingSlash: true,
    customData: `<language>${locale === 'de' ? 'de-at' : 'en'}</language>`,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `${blogPath(locale)}${postSlug(post.id)}/`,
      categories: [CATEGORIES[locale][post.data.category].label],
    })),
  })
}
