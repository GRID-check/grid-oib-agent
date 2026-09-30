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
import { art, artFile, type ArtId } from './art'
import { SECTIONS, landingPath, type LandingEntry, type SectionId } from './landing'

export interface OgImage {
  /** Site-relative or absolute URL. */
  src: string
  alt: string
  width: number
  height: number
}

/** An art id in the share-card format (1200 × 630 PNG). */
export type OgArtId = Extract<ArtId, `${string}/og`>

/**
 * The riso share card of each kind of page, as art ids. Each is a composition
 * of its plate for the 1200 × 630 card, not a crop (art/riso/tafeln). A blog
 * post shares its own plate (`COVER_PLATES` in components/craft/plates.ts)
 * and falls back to its category's card. Pages pass one to BaseLayout as
 * `ogArt`. No two kinds of page share a card (the blog index and its Journal
 * aside), so a link pasted into a chat already says which page it is: the
 * founders' complaint was every preview showing the same house.
 */
export const SHARE_ART = {
  /** Tragwerk I, Säule: the Piloti column, the brand's staple. The landing page only. */
  landing: 'tragwerk/saeule/og',
  /** Plate VI, Zeichentisch: the blog index, the office's working day. */
  blog: 'tafeln/zeichentisch/og',
  /** Tragwerk III, Säulenordnung: the Journal, a textbook plate of the orders. */
  journal: 'tragwerk/ordnung/og',
  /** Plate II, Schichten: the build log takes the system apart, layer by layer. */
  bautagebuch: 'tafeln/schichten/og',
  /** Plate IV, Bauplatz: a site set out, one column up. What shipped, and what comes next. */
  changelog: 'tafeln/bauplatz/og',
  /** Plate VII, Waage: hours against money. */
  rechenweg: 'tafeln/waage/og',
  /** Plate V, Prüfstand: the quiet card, a clause under the glass (imprint, privacy, 404). */
  legal: 'tafeln/pruefstand/og',
  /** Plate I, Drei Stützen: why Piloti, three columns under one answer (law, office, project). */
  warum: 'tafeln/stuetzen/og',
  /**
   * Plate II, Schichten, shared with the build log: sheets on their way from
   * source to answer, which is where a mailed attachment goes. No plate shows
   * a letter; a card of its own is new art, not a pick from these.
   */
  mailInbox: 'tafeln/schichten/og',
  /** Tragwerk II, Drei Säulen: the unlisted image page, all the prints on one slab. */
  bildmaterial: 'tragwerk/drei/og',
} as const satisfies Record<string, OgArtId>


/** The share card for an art id, in the shape SeoHead reads. */
export function ogImageFor(id: OgArtId, locale: Locale): OgImage {
  const og = art(id)
  return { src: artFile(og).src, alt: og.alt[locale], width: og.width, height: og.height }
}

/** The card a page shares when it names none: the landing page's column. */
export function defaultOgImage(locale: Locale): OgImage {
  return ogImageFor(SHARE_ART.landing, locale)
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
      // What Piloti is, as a thing an answer engine can name and compare: the
      // product, not the company. No offers or rating: there is no price list
      // and no review to state.
      '@type': 'SoftwareApplication',
      '@id': `${root}#software`,
      name: SITE_NAME,
      url: home,
      applicationCategory: 'BusinessApplication',
      applicationSubCategory: locale === 'de' ? 'KI-Wissensplattform für Planungsbüros' : 'AI knowledge platform for planning offices',
      operatingSystem: 'Web',
      inLanguage: ['de-AT', 'en'],
      description: ui[locale].meta.description,
      audience: { '@type': 'BusinessAudience', audienceType: locale === 'de' ? 'Architektur- und Planungsbüros in Österreich' : 'Architecture and planning offices in Austria' },
      publisher: { '@id': `${root}#organization` },
      creator: { '@id': `${root}#organization` },
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

/**
 * A standalone page (why Piloti, the comparison) as a WebPage in the site
 * graph with its breadcrumb Start › Page, so a result can show the trail
 * instead of the bare URL.
 */
export function pageLd(locale: Locale, title: string, path: string, site: URL | undefined) {
  const url = absoluteUrl(path, site)
  const home = absoluteUrl(locale === 'en' ? '/en/' : '/', site)
  const name = title.replace(/ – Piloti$/, '')
  return [
    {
      '@type': 'WebPage',
      '@id': url,
      url,
      name,
      inLanguage: locale === 'de' ? 'de-AT' : 'en',
      isPartOf: { '@id': `${home}#website` },
      about: { '@id': `${absoluteUrl('/', site)}#organization` },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        [ui[locale].seo.breadcrumbHome, home],
        [name, url],
      ].map(([n, item], i) => ({ '@type': 'ListItem', position: i + 1, name: n, item })),
    },
  ]
}

function crumbs(items: [string, string][]) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })),
  }
}

/**
 * A search page (lib/landing.ts): WebPage with its date, the breadcrumb
 * Start › Section › Page, its FAQ as FAQPage, and for the glossary the term
 * as DefinedTerm. The one-sentence answer is the page's description to
 * machines, so an answer engine lifts the conclusion, not the lede.
 */
export function landingLd(locale: Locale, section: SectionId, entry: LandingEntry, site: URL | undefined) {
  const c = entry[locale]
  const home = absoluteUrl(locale === 'en' ? '/en/' : '/', site)
  const hub = absoluteUrl(landingPath(locale, section), site)
  const url = absoluteUrl(landingPath(locale, section, entry.slug), site)
  const root = absoluteUrl('/', site)
  const nodes: object[] = [
    {
      '@type': 'WebPage',
      '@id': url,
      url,
      name: c.heading,
      description: c.answer,
      inLanguage: locale === 'de' ? 'de-AT' : 'en',
      dateModified: `${entry.checked}-01`,
      isPartOf: { '@id': `${home}#website` },
      about: { '@id': `${root}#software` },
    },
    crumbs([
      [ui[locale].seo.breadcrumbHome, home],
      [SECTIONS[section][locale].label, hub],
      [c.heading, url],
    ]),
  ]
  if (c.faq.length) {
    nodes.push({
      '@type': 'FAQPage',
      mainEntity: c.faq.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    })
  }
  if (entry.term) {
    nodes.push({
      '@type': 'DefinedTerm',
      name: entry.term,
      description: c.answer,
      url,
      inDefinedTermSet: { '@type': 'DefinedTermSet', name: SECTIONS.glossar[locale].heading, url: absoluteUrl(landingPath(locale, 'glossar'), site) },
    })
  }
  return nodes
}

/** A section hub: a CollectionPage listing its pages, with the breadcrumb. */
export function hubLd(locale: Locale, section: SectionId, site: URL | undefined) {
  const home = absoluteUrl(locale === 'en' ? '/en/' : '/', site)
  const url = absoluteUrl(landingPath(locale, section), site)
  const s = SECTIONS[section][locale]
  return [
    { '@type': 'CollectionPage', '@id': url, url, name: s.heading, description: s.description, inLanguage: locale === 'de' ? 'de-AT' : 'en' },
    crumbs([
      [ui[locale].seo.breadcrumbHome, home],
      [s.label, url],
    ]),
  ]
}
