/**
 * What search engines and answer engines read about the site: share images,
 * the JSON-LD graph, the FAQ as data. The <head> that emits it is
 * `components/seo/SeoHead.astro`; the strings live in `i18n/ui.ts` (`meta`,
 * `seo`, `faq`).
 *
 * Piloti is not incorporated. The Organization node says who Piloti is (name,
 * site, logo, founders) and nothing a legal entity would carry: no legalName,
 * no address, no registration.
 */
import { CONTACT_EMAIL, SITE_NAME } from '../consts'
import { founders } from '../data/founders'
import { languages, ui, type Locale } from '../i18n/ui'

export interface OgImage {
  /** Site-relative or absolute URL. */
  src: string
  alt: string
  width: number
  height: number
}

/**
 * The share image every page uses unless it passes its own. Interim: rendered
 * by `scripts/build-brand-assets.mjs`. When the riso print lands at
 * `public/art/og-piloti.png` (1200×630), point `src` at `OG_ART` instead.
 */
export const OG_ART = '/art/og-piloti.png'
export function defaultOgImage(locale: Locale): OgImage {
  return { src: `/og/default-${locale}.png`, alt: ui[locale].seo.ogImageAlt, width: 1200, height: 630 }
}

/** What an article page adds to its head: og:type article and its dates. */
export interface Article {
  published: Date
  section: string
}

export const OG_LOCALE: Record<Locale, string> = { de: 'de_AT', en: 'en_GB' }

/** One RSS feed per locale (`pages/rss.xml.ts`, `pages/en/rss.xml.ts`); every page links both. */
export const FEED_PATH: Record<Locale, string> = { de: '/rss.xml', en: '/en/rss.xml' }
export const FEEDS = (Object.keys(FEED_PATH) as Locale[]).map((locale) => ({
  path: FEED_PATH[locale],
  title: `${ui[locale].seo.rssTitle} (${languages[locale]})`,
}))

/** A path on this site as the absolute URL search engines see, always with its trailing slash. */
export function absoluteUrl(path: string, site: URL | undefined) {
  const url = new URL(path, site)
  if (!url.pathname.endsWith('/') && !/\.[a-z0-9]+$/i.test(url.pathname)) url.pathname += '/'
  return url.href
}

/** The founders as schema.org Persons, the people behind every post and the site. */
export function founderPersons(locale: Locale) {
  return founders.map((f) => ({ '@type': 'Person', name: f.name, jobTitle: f.role[locale] }))
}

/** "A, B und C". */
export function founderNames(locale: Locale) {
  const names = founders.map((f) => f.name)
  return `${names.slice(0, -1).join(', ')} ${ui[locale].seo.and} ${names.at(-1)}`
}

/** The FAQ with its placeholders filled, for the page, its JSON-LD and llms-full.txt alike. */
export function faqItems(locale: Locale) {
  const people = founders.map((f) => `${f.name} (${f.role[locale].replace(' · ', ', ')})`).join(', ')
  return ui[locale].faq.items.map(({ q, a }) => ({
    q,
    a: a.replace('{founders}', people).replace('{email}', CONTACT_EMAIL),
  }))
}

const KNOWS_ABOUT: Record<Locale, string[]> = {
  de: ['Baurecht in Österreich', 'OIB-Richtlinien', 'Landesbauordnungen', 'Bauordnung für Wien', 'Architekturplanung'],
  en: ['Austrian building law', 'OIB guidelines', 'Austrian state building codes', 'Vienna Building Code', 'Architectural planning'],
}

/**
 * The nodes every page carries: the site and who is behind it. `@id`s let a
 * page's own nodes (a post, its breadcrumbs) point at them.
 */
export function siteGraph(locale: Locale, site: URL | undefined) {
  const home = absoluteUrl(locale === 'en' ? '/en/' : '/', site)
  const root = absoluteUrl('/', site)
  return [
    {
      '@type': 'Organization',
      '@id': `${root}#organization`,
      name: SITE_NAME,
      url: root,
      logo: absoluteUrl('/icons/icon-512.png', site),
      description: ui[locale].meta.description,
      founder: founderPersons(locale),
      areaServed: { '@type': 'Country', name: locale === 'de' ? 'Österreich' : 'Austria' },
      knowsAbout: KNOWS_ABOUT[locale],
    },
    {
      '@type': 'WebSite',
      '@id': `${home}#website`,
      name: SITE_NAME,
      url: home,
      inLanguage: locale === 'de' ? 'de-AT' : 'en',
      description: ui[locale].meta.description,
      publisher: { '@id': `${root}#organization` },
    },
  ]
}

export function faqPageLd(locale: Locale) {
  return {
    '@type': 'FAQPage',
    mainEntity: faqItems(locale).map(({ q, a }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  }
}

export interface PostLdInput {
  locale: Locale
  url: string
  title: string
  description: string
  published: Date
  image: string
  section: string
  sectionUrl: string
  blogUrl: string
  site: URL | undefined
}

/** A post as BlogPosting plus the breadcrumb trail Start › Blog › Category › Post. */
export function postLd(p: PostLdInput) {
  const t = ui[p.locale].seo
  const home = absoluteUrl(p.locale === 'en' ? '/en/' : '/', p.site)
  return [
    {
      '@type': 'BlogPosting',
      headline: p.title,
      description: p.description,
      datePublished: p.published.toISOString(),
      dateModified: p.published.toISOString(),
      inLanguage: p.locale === 'de' ? 'de-AT' : 'en',
      image: p.image,
      url: p.url,
      mainEntityOfPage: { '@type': 'WebPage', '@id': p.url },
      articleSection: p.section,
      author: founderPersons(p.locale),
      publisher: { '@id': `${absoluteUrl('/', p.site)}#organization` },
      isPartOf: { '@id': `${home}#website` },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        [t.breadcrumbHome, home],
        ['Blog', p.blogUrl],
        [p.section, p.sectionUrl],
        [p.title, p.url],
      ].map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })),
    },
  ]
}

/** JSON for a <script type="application/ld+json">, safe against a `</script>` in any string. */
export function ldJson(nodes: object[]) {
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes }).replace(/</g, '\\u003c')
}
