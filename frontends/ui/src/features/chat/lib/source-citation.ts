/**
 * Citations an architect can actually paste somewhere.
 *
 * The provenance block knows exactly what a source IS (OIB-Richtlinie with an
 * edition, a RIS legal norm, a project upload, a web page) — so it can hand the
 * user a real citation instead of a link they have to retype into their Befund,
 * their Word bibliography or their reference manager.
 *
 * This module builds **CSL-JSON**, the interchange format every serious tool
 * speaks (Zotero, Mendeley, EndNote, Word, pandoc, citation-js). Rendering it
 * into APA/BibTeX/RIS is `citation-export.ts`'s job — deliberately split, so
 * the mapping below stays pure, synchronous and testable, and the heavy
 * citation-js bundle only loads when someone actually copies something.
 *
 * NOTHING is invented: every field comes from data the answer already carries.
 * An unknown edition, page or date is simply absent from the output rather than
 * guessed — a fabricated Fundstelle in a building-law citation is worse than a
 * short one.
 */

import type { AnswerSourceItem } from './answer-source-list'

/** The publisher of the OIB-Richtlinien — a fact about the document class. */
const OIB_PUBLISHER = 'Österreichisches Institut für Bautechnik'
const OIB_PLACE = 'Wien'
/** The Austrian legal information system a RIS source is retrieved from. */
const RIS_CONTAINER = 'Rechtsinformationssystem des Bundes (RIS)'

/** CSL-JSON date shape (`{"date-parts": [[year, month]]}`). */
export interface CslDate {
  'date-parts': number[][]
}

/**
 * A CSL-JSON item. Deliberately a narrow subset of the spec — only the fields
 * we can fill from real data.
 */
export interface CslItem {
  id: string
  /** CSL type: `standard` (OIB/ÖNORM), `legislation`, `webpage`, `report`. */
  type: string
  title: string
  authority?: string
  publisher?: string
  'publisher-place'?: string
  'container-title'?: string
  edition?: string
  page?: string
  number?: string
  issued?: CslDate
  accessed?: CslDate
  URL?: string
  note?: string
}

const GERMAN_MONTHS: Record<string, number> = {
  jänner: 1,
  januar: 1,
  februar: 2,
  märz: 3,
  maerz: 3,
  april: 4,
  mai: 5,
  juni: 6,
  juli: 7,
  august: 8,
  september: 9,
  oktober: 10,
  november: 11,
  dezember: 12,
}

/** "Ausgabe Mai 2023" / "Ausgabe: Mai 2023" — the OIB edition convention. */
const EDITION_RE = /ausgabe:?\s*([a-zäöü]+)?\s*(\d{4})/i
/** A bare year, used only when no edition phrase exists. */
const YEAR_RE = /\b(19|20)\d{2}\b/

const cslDate = (year: number, month?: number): CslDate => ({
  'date-parts': [month ? [year, month] : [year]],
})

/** Today, as a CSL `accessed` date. */
export const accessedDate = (now: Date): CslDate =>
  cslDate(now.getFullYear(), now.getMonth() + 1)

/** The edition ("Ausgabe Mai 2023") and its date, if the title/filename states one. */
const parseEdition = (text: string): { edition?: string; issued?: CslDate } => {
  const match = EDITION_RE.exec(text)
  if (match) {
    const month = match[1] ? GERMAN_MONTHS[match[1].toLowerCase()] : undefined
    const year = Number(match[2])
    const label = match[1]
      ? `Ausgabe ${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${year}`
      : `Ausgabe ${year}`
    return { edition: label, issued: cslDate(year, month) }
  }
  const year = YEAR_RE.exec(text)
  return year ? { issued: cslDate(Number(year[0])) } : {}
}

/** Human title for a source: its label, with a filename cleaned up if that is all we have. */
const displayTitle = (item: AnswerSourceItem): string => {
  const label = item.ref.label.trim()
  const citationTitle = item.ref.citation?.title?.trim()
  if (citationTitle && citationTitle !== label) return citationTitle
  return label
}

const isOib = (item: AnswerSourceItem): boolean =>
  item.ref.authority === 'OIB' ||
  item.ref.signal === 'oib' ||
  (item.ref.citation?.lane ?? '').toLowerCase().startsWith('baurecht_oib')

const isNorm = (item: AnswerSourceItem): boolean => item.ref.authority === 'ÖNORM'

const isLaw = (item: AnswerSourceItem): boolean =>
  item.ref.kind === 'ris' || (item.ref.citation?.lane ?? '').toLowerCase().startsWith('baurecht')

/**
 * Map one source row onto a CSL-JSON item.
 *
 * `now` is passed in (never read from the clock here) so the mapping stays pure
 * and the `accessed` date is testable.
 */
export const toCslItem = (item: AnswerSourceItem, now: Date): CslItem => {
  const title = displayTitle(item)
  const fileName = item.ref.citation?.fileName ?? ''
  const { edition, issued } = parseEdition(`${title} ${fileName}`)
  const page = item.page != null ? String(item.page) : undefined
  const url = item.ref.url
  const id = `source-${item.number ?? item.ref.key}`

  if (isOib(item) || isNorm(item)) {
    // A technical guideline / standard — CSL `standard` is exactly this type.
    return {
      id,
      type: 'standard',
      title,
      ...(isOib(item)
        ? { publisher: OIB_PUBLISHER, 'publisher-place': OIB_PLACE, authority: OIB_PUBLISHER }
        : {}),
      ...(edition ? { edition } : {}),
      ...(issued ? { issued } : {}),
      ...(page ? { page } : {}),
      ...(url ? { URL: url, accessed: accessedDate(now) } : {}),
    }
  }

  if (isLaw(item)) {
    return {
      id,
      type: 'legislation',
      title,
      ...(item.ref.citation?.laneLabel ? { authority: item.ref.citation.laneLabel } : {}),
      'container-title': RIS_CONTAINER,
      ...(issued ? { issued } : {}),
      ...(page ? { page } : {}),
      ...(url ? { URL: url, accessed: accessedDate(now) } : {}),
    }
  }

  if (item.ref.kind === 'web') {
    return {
      id,
      type: 'webpage',
      title,
      ...(item.host ? { 'container-title': item.host } : {}),
      ...(issued ? { issued } : {}),
      ...(url ? { URL: url, accessed: accessedDate(now) } : {}),
    }
  }

  // A project / office document: a real artifact, not a publication.
  return {
    id,
    type: 'report',
    title,
    ...(fileName && fileName !== title ? { note: fileName } : {}),
    ...(issued ? { issued } : {}),
    ...(page ? { page } : {}),
  }
}

/** `28.07.2026` — the date format an Austrian document uses. */
const formatAustrianDate = (now: Date): string =>
  `${String(now.getDate()).padStart(2, '0')}.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`

/**
 * The German Fachtext citation — the one an Austrian architect actually pastes
 * into a Befund, a Gutachten or an Einreichung, following the conventions those
 * documents use: the OIB's own "OIB-Richtlinie N, Ausgabe …, S. x" form, and a
 * legal source cited with its Fundstelle plus the RIS retrieval note.
 */
export const toFachtext = (item: AnswerSourceItem, now: Date): string => {
  const csl = toCslItem(item, now)
  const parts: string[] = [csl.title]

  // The edition is often already part of the title ("OIB-Richtlinie 2 – Brand-
  // schutz, Ausgabe Mai 2023") — never state it twice.
  if (csl.edition && !csl.title.toLowerCase().includes(csl.edition.toLowerCase())) {
    parts.push(csl.edition)
  }
  if (csl.page) parts.push(`S. ${csl.page}`)

  let text = parts.join(', ')

  if (csl.type === 'standard' && csl.publisher) {
    text += ` (${csl.publisher}, ${csl['publisher-place'] ?? ''})`.replace(', )', ')')
  } else if (csl.type === 'legislation') {
    text += `, in: ${RIS_CONTAINER}`
  } else if (csl.type === 'webpage' && csl['container-title']) {
    text += `, ${csl['container-title']}`
  } else if (csl.type === 'report' && csl.note) {
    text += ` [${csl.note}]`
  }

  if (csl.URL) text += `, abgerufen am ${formatAustrianDate(now)}: ${csl.URL}`

  return `${text}.`
}

/** The numbered Fachtext bibliography for a whole answer. */
export const toFachtextList = (items: AnswerSourceItem[], now: Date): string =>
  items
    .map((item, index) => `[${item.number ?? index + 1}] ${toFachtext(item, now)}`)
    .join('\n')

/** CSL-JSON for a whole answer, ready for Zotero / Word / pandoc import. */
export const toCslJson = (items: AnswerSourceItem[], now: Date): string =>
  JSON.stringify(
    items.map((item) => toCslItem(item, now)),
    null,
    2
  )
