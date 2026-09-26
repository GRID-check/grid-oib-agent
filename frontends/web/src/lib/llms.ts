/**
 * /llms.txt and /llms-full.txt (llmstxt.org): the site as an answer engine
 * reads it. Built at build time from the same sources the pages render
 * (ui.ts, the blog collection, founders.ts), never kept as a copy, so the two
 * cannot drift and nothing reaches them that `npm run check` did not lint.
 */
import { CONTACT_EMAIL, SITE_NAME } from '../consts'
import { ui, languages, type Locale } from '../i18n/ui'
import { blogPath, CATEGORIES } from './categories'
import { getBlogPosts, postSlug, type BlogPost } from './posts'
import { absoluteUrl, faqItems, founderNames } from './seo'

const LOCALES = Object.keys(languages) as Locale[]

type PageKey = keyof (typeof ui)['de']['seo']['pages']
const PAGE_PATHS: [PageKey | 'home', string][] = [
  ['home', '/'],
  ['blog', '/blog/'],
  ['journal', '/blog/journal/'],
  ['bautagebuch', '/blog/bautagebuch/'],
  ['changelog', '/changelog/'],
  ['rechenweg', '/rechenweg/'],
  ['impressum', '/impressum/'],
  ['datenschutz', '/datenschutz/'],
]

const localized = (locale: Locale, path: string) => (locale === 'en' ? `/en${path}` : path)
const postUrl = (post: BlogPost, locale: Locale, site: URL | undefined) =>
  absoluteUrl(`${blogPath(locale)}${postSlug(post.id)}/`, site)

function pageLinks(locale: Locale, site: URL | undefined) {
  return PAGE_PATHS.map(([key, path]) => {
    const { title, description } = key === 'home' ? ui[locale].meta : ui[locale].seo.pages[key]
    return `- [${title.split(' — ')[0]}](${absoluteUrl(localized(locale, path), site)}): ${description}`
  })
}

function summary() {
  return LOCALES.map((l) => `> ${ui[l].meta.description}`).join('\n>\n')
}

function facts(locale: Locale) {
  const line = ui[locale].seo.llmsFacts
  return `${ui[locale].hero.stage}. ${line.replace('{founders}', founderNames(locale)).replace('{email}', CONTACT_EMAIL)}`
}

export async function llmsTxt(site: URL | undefined) {
  const sections = [`# ${SITE_NAME}`, summary(), facts('de'), facts('en')]
  for (const locale of LOCALES) {
    sections.push(`## ${ui[locale].seo.llmsPages}\n\n${pageLinks(locale, site).join('\n')}`)
  }
  for (const locale of LOCALES) {
    const posts = await getBlogPosts(locale)
    const lines = posts.map((p) => `- [${p.data.title}](${postUrl(p, locale, site)}): ${p.data.description}`)
    sections.push(`## ${ui[locale].seo.llmsPosts}\n\n${lines.join('\n')}`)
  }
  sections.push(
    `## Optional\n\n- [llms-full.txt](${absoluteUrl('/llms-full.txt', site)}): FAQ und alle Blogbeiträge im Volltext / FAQ and every blog post in full`
  )
  return sections.join('\n\n') + '\n'
}

/**
 * A post's MDX as plain Markdown: imports dropped, each figure component
 * replaced by its alt text and caption, site links made absolute.
 */
function mdxToMarkdown(body: string, site: URL | undefined) {
  return body
    .replace(/^(import|export) .*$/gm, '')
    .replace(/<([A-Z]\w*)\b[\s\S]*?\/>/g, (block) => {
      const attr = (name: string) => block.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
      const parts = [attr('alt'), attr('caption')].filter(Boolean)
      return parts.length ? `[${parts.join(' — ')}]` : ''
    })
    // A post's own headings sit below the post title (###) in this file.
    .replace(/^(#{1,4}) /gm, '$1## ')
    .replace(/\]\((\/[^)]*)\)/g, (_, path: string) => `](${absoluteUrl(path, site)})`)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function llmsFullTxt(site: URL | undefined) {
  const sections = [`# ${SITE_NAME}`, summary(), facts('de'), facts('en')]
  for (const locale of LOCALES) {
    const qa = faqItems(locale).map(({ q, a }) => `### ${q}\n\n${a}`)
    sections.push(`## ${ui[locale].faq.tag} (${languages[locale]})\n\n${qa.join('\n\n')}`)
  }
  for (const locale of LOCALES) {
    sections.push(`## ${ui[locale].seo.llmsPosts}`)
    for (const post of await getBlogPosts(locale)) {
      const { title, description, pubDate, category } = post.data
      const meta = [
        postUrl(post, locale, site),
        pubDate.toISOString().slice(0, 10),
        CATEGORIES[locale][category].label,
        `${ui[locale].seo.byline} ${founderNames(locale)}`,
      ].join(' · ')
      sections.push(`### ${title}\n\n${meta}\n\n${description}\n\n${mdxToMarkdown(post.body ?? '', site)}`)
    }
  }
  return sections.join('\n\n') + '\n'
}
