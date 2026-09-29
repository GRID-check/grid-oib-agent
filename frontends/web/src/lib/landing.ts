/**
 * The site's search pages: comparisons, use cases, audiences, the nine states
 * and the glossary. Each is one entry in `src/data/landing/<section>.ts`,
 * rendered by `components/landing/LandingPage.astro` at
 * `/<section>/<slug>/` (and `/en/<section>/<slug>/`), listed on its section's
 * hub, in the sitemap and in /llms.txt. Adding a page is adding an entry.
 *
 * Copy rules are the rest of the site's: both locales, German typography
 * (`scripts/lint-typography.mjs` reads `src/data/landing/`), only what the
 * product does (`scripts/lint-claims.mjs`). A competitor is described only as
 * its own site describes it, with the month it was read (`checked`).
 */
import type { Locale } from '../i18n/ui'
import type { OgArtId } from './seo'

export interface Row {
  label: string
  a: string
  b: string
}

/** A page is a head, a run of blocks, an FAQ and the pages it points to. */
export type Block =
  | { kind: 'text'; title: string; body: string[] }
  | { kind: 'list'; title: string; items: string[] }
  | { kind: 'pairs'; title: string; body?: string; items: { name: string; body: string }[] }
  | { kind: 'steps'; title: string; body?: string; items: { name: string; body: string }[] }
  | { kind: 'table'; title: string; headA: string; headB: string; rows: Row[]; note?: string }
  | { kind: 'split'; left: { title: string; items: string[] }; right: { title: string; items: string[] } }
  /** A definition quoted from its source, for the glossary. */
  | { kind: 'definition'; term: string; text: string; source: string; sourceUrl?: string }

export interface LandingCopy {
  /** <title>, about 60 characters. */
  title: string
  /** Meta description, about 155 characters. */
  description: string
  /** The h1. */
  heading: string
  lede: string
  /** The line under the lede in small type: a naming note, a source, a date. */
  note?: string
  /** One sentence an answer engine can lift whole: what this page concludes. */
  answer: string
  blocks: Block[]
  faq: { q: string; a: string }[]
}

export interface LandingEntry {
  slug: string
  de: LandingCopy
  en: LandingCopy
  /** Month the facts on the page were last checked, e.g. '2026-09'. */
  checked: string
  /** Other search pages this one points to, as `section/slug`. */
  related?: string[]
  /** For the glossary: the term, for DefinedTerm markup. */
  term?: string
}

export const SECTION_IDS = ['vergleich', 'anwendungen', 'fuer', 'baurecht', 'glossar'] as const
export type SectionId = (typeof SECTION_IDS)[number]

interface SectionCopy {
  /** Breadcrumb, footer and hub nav label. */
  label: string
  /** Hub <title> and description. */
  title: string
  description: string
  heading: string
  lede: string
}

export const SECTIONS: Record<SectionId, { og: OgArtId } & Record<Locale, SectionCopy>> = {
  vergleich: {
    og: 'tragwerk/ziegel/og',
    de: {
      label: 'Vergleiche',
      title: 'Piloti im Vergleich: Alternativen zu ChatGPT, Reiner AI & Co.',
      description:
        'Piloti neben ChatGPT, Microsoft Copilot, NotebookLM, Reiner AI und weiteren KI-Werkzeugen für Planungsbüros: ehrlich verglichen, mit Datum und Quellen.',
      heading: 'Piloti im Vergleich',
      lede: 'Jeder Vergleich sagt zuerst, wofür das andere Werkzeug besser passt. Angaben zu anderen Anbietern stammen von deren eigenen Websites, mit dem Monat, in dem wir sie gelesen haben.',
    },
    en: {
      label: 'Comparisons',
      title: 'Piloti compared: alternatives to ChatGPT, Reiner AI and more',
      description:
        'Piloti next to ChatGPT, Microsoft Copilot, NotebookLM, Reiner AI and other AI tools for planning offices: compared honestly, with dates and sources.',
      heading: 'Piloti compared',
      lede: 'Every comparison first says what the other tool fits better. Details on other vendors come from their own websites, with the month we read them.',
    },
  },
  anwendungen: {
    og: 'tafeln/schleife/og',
    de: {
      label: 'Anwendungen',
      title: 'Anwendungen: Wofür Planungsbüros Piloti einsetzen – Piloti',
      description:
        'Gebäudeklasse, Brandschutz, Einreichcheck, Bestand, Bebauung, Wärmeschutz, Barrierefreiheit: wie Piloti typische Planungsfragen in Österreich bearbeitet.',
      heading: 'Wofür Büros Piloti einsetzen',
      lede: 'Piloti bringt für die häufigsten Planungsfragen eigene Arbeitsweisen mit. Jede sagt, was sie prüft, was sie braucht und wo sie aufhört.',
    },
    en: {
      label: 'Use cases',
      title: 'Use cases: what planning offices use Piloti for – Piloti',
      description:
        'Building class, fire safety, submission check, existing buildings, plot rules, thermal protection, accessibility: how Piloti handles typical planning questions in Austria.',
      heading: 'What offices use Piloti for',
      lede: 'Piloti brings its own ways of working for the most common planning questions. Each says what it checks, what it needs and where it stops.',
    },
  },
  fuer: {
    og: 'tafeln/tuer/og',
    de: {
      label: 'Für wen',
      title: 'Für wen Piloti gebaut ist: Architektur- und Planungsbüros',
      description:
        'Piloti für Architekturbüros, Ziviltechniker:innen und Ingenieurbüros, Baumeister und Bauträger in Österreich: was es jeweils übernimmt und was nicht.',
      heading: 'Für wen Piloti gebaut ist',
      lede: 'Wer in Österreich plant, prüft täglich Baurecht, Pläne und Erfahrung gegeneinander. Was Piloti dabei je nach Büro übernimmt.',
    },
    en: {
      label: 'Who it is for',
      title: 'Who Piloti is built for: architecture and planning offices',
      description:
        'Piloti for architecture offices, civil engineers and consulting engineers, master builders and developers in Austria: what it takes on for each, and what not.',
      heading: 'Who Piloti is built for',
      lede: 'Anyone planning in Austria checks building law, drawings and experience against each other every day. What Piloti takes on, office by office.',
    },
  },
  baurecht: {
    og: 'tafeln/schichten/og',
    de: {
      label: 'Baurecht nach Bundesland',
      title: 'Baurecht in den Bundesländern: KI für Planungsbüros – Piloti',
      description:
        'Neun Bundesländer, neun Bauordnungen: welche Landesgesetze Piloti je Bundesland heranzieht, welche OIB-Ausgabe dort gilt und wie Sie Antworten prüfen.',
      heading: 'Baurecht in den neun Bundesländern',
      lede: 'Baurecht ist in Österreich Landesrecht. Piloti arbeitet mit der Bauordnung und den Bautechnikvorschriften des Landes, in dem Ihr Projekt steht.',
    },
    en: {
      label: 'Building law by state',
      title: 'Building law in Austria’s states: AI for planning offices – Piloti',
      description:
        'Nine states, nine building codes: which state laws Piloti draws on in each state, which OIB edition applies there, and how you check answers.',
      heading: 'Building law in Austria’s nine states',
      lede: 'In Austria, building law is state law. Piloti works with the building code and building-technology rules of the state your project is in.',
    },
  },
  glossar: {
    og: 'tragwerk/drei/og',
    de: {
      label: 'Glossar',
      title: 'Glossar Baurecht Österreich: Begriffe einfach erklärt – Piloti',
      description:
        'Gebäudeklasse, Fluchtniveau, oberirdisches Geschoß, Brandabschnitt, OIB-Richtlinien, RIS: Begriffe des österreichischen Baurechts, erklärt und belegt.',
      heading: 'Glossar: Begriffe aus dem Baurecht',
      lede: 'Die Begriffe, an denen im österreichischen Baurecht die meisten Anforderungen hängen, mit der Definition aus der Quelle und dem, was sie in der Praxis bedeuten.',
    },
    en: {
      label: 'Glossary',
      title: 'Glossary of Austrian building law: terms explained – Piloti',
      description:
        'Building class, escape level, above-ground storey, fire compartment, OIB guidelines, RIS: terms of Austrian building law, explained with their source.',
      heading: 'Glossary: terms from building law',
      lede: 'The terms most requirements in Austrian building law hinge on, with the definition from the source and what they mean in practice.',
    },
  },
}

/** `/vergleich/` or `/en/vergleich/reiner-ai/`. */
export function landingPath(locale: Locale, section: SectionId, slug?: string) {
  const base = `${locale === 'en' ? '/en' : ''}/${section}/`
  return slug ? `${base}${slug}/` : base
}
