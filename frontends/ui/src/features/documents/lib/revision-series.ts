/**
 * Revision series: which documents exist in several Fassungen, and which one
 * is current — read from the names offices give their files.
 *
 * feld72 (Jour fixe, 2026-10-09) asked for "eine Logik wie bei Planfred": read
 * index and date, treat only the newest Fassung as the basis, the older ones
 * only on request — and only ever as a SUGGESTION a person confirms. Offices
 * name every revision explicitly and never overwrite one, so the names carry
 * it: `EG_Grundriss_Index_C_2026-08-14.pdf`, `A-101_C_Grundriss EG.pdf`,
 * `260814_Schnitt_AA_idx-B.pdf`. This module reads that, and nothing here
 * changes, hides or re-files a document: it says which one looks current.
 *
 * Naming: a name says nothing about WHAT a file is, so nothing here calls a
 * file a plan (CONTEXT.md, „Fassung"). A Grundriss is a Grundriss because a
 * tag says so, never because its name carries an index.
 *
 * The SAME grammar runs for the agent in Python
 * (`sources/knowledge_layer/src/revision_series.py`), and both are held to one set
 * of cases (`tests/fixtures/revision_series_cases.json`), so the folder brief and
 * the agent's `list_files` cannot disagree about which Fassung is current.
 *
 * Pure: no React, no I/O.
 */

export interface RevisionIndex {
  kind: 'letter' | 'number'
  /** `C`, `12` — as it should be shown (letters upper-cased, numbers without leading zeros). */
  value: string
  /** Comparable within one kind: A=1 … Z=26, numbers as themselves. */
  rank: number
}

export interface RevisionName {
  /** What the Fassungen of one document share: the name without its index, its date and its extension. */
  key: string
  index: RevisionIndex | null
  /** ISO `YYYY-MM-DD`. */
  date: string | null
}

const SEP = '[ _.\\-]'
/** `Index C`, `idx-B`, `index_a`, `Rev. 12`, `Rev02`, `v3`, `Version 2`. */
const KEYWORD_INDEX = new RegExp(
  `(^|${SEP})(?:index|idx|ind|rev|revision|ver|version|v)\\.?${SEP}?([a-z]|\\d{1,3})(?=$|${SEP})`,
  'i'
)
/** A bare letter right after a leading sheet number, before more name: `A-101_C_Grundriss`. Case-sensitive. */
const SHEET_NUMBER_LETTER = /^([A-Za-z]{1,3}[-_ ]?\d{2,4})[ _.-]([A-Z])(?=[ _.-]\S)/
/** `2026-08-14`, `2026_08_14`, `20260814`, optionally after `Stand`. */
const ISO_DATE = new RegExp(
  `(^|${SEP})(?:stand${SEP}*)?(20\\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\\d|3[01])(?=$|${SEP})`,
  'i'
)
/** `14.08.2026`, optionally after `Stand`. */
const DOTTED_DATE = new RegExp(`(^|${SEP})(?:stand${SEP}*)?(0[1-9]|[12]\\d|3[01])\\.(0[1-9]|1[0-2])\\.(20\\d{2})(?=$|${SEP})`, 'i')
/** `260814_…` or `…_260814` — six digits only at either end, where offices put a date. */
const SHORT_DATE_START = /^(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?=[ _.-])/
const SHORT_DATE_END = new RegExp(`${SEP}(\\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])$`)

function splitExtension(filename: string): { stem: string; extension: string } {
  const match = /^(.*)\.([a-z0-9]{1,5})$/i.exec(filename.trim())
  return match ? { stem: match[1], extension: match[2].toLowerCase() } : { stem: filename.trim(), extension: '' }
}

function indexOf(raw: string): RevisionIndex {
  if (/^\d+$/.test(raw)) {
    const number = Number.parseInt(raw, 10)
    return { kind: 'number', value: String(number), rank: number }
  }
  const letter = raw.toUpperCase()
  return { kind: 'letter', value: letter, rank: letter.charCodeAt(0) - 64 }
}

/** The series key: what is left once index and date are cut out, folded and with one space between words. */
function seriesKey(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[\s_.]+/g, ' ')
    .replace(/\s*-\s*(?=\s|$)/g, ' ')
    .replace(/(^|\s)-\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * What a file name says about its revision, or null when it names neither an
 * index nor a date — then it is not part of a series.
 */
export function parseRevisionName(filename: string): RevisionName | null {
  let { stem } = splitExtension(filename)
  let index: RevisionIndex | null = null
  let date: string | null = null

  const cut = (match: RegExpExecArray, keepLead: boolean) => {
    const lead = keepLead ? (match[1] ?? '') : ''
    stem = stem.slice(0, match.index) + lead + ' ' + stem.slice(match.index + match[0].length)
  }

  let match = ISO_DATE.exec(stem)
  if (match) {
    date = `${match[2]}-${match[3]}-${match[4]}`
    cut(match, true)
  } else if ((match = DOTTED_DATE.exec(stem))) {
    date = `${match[4]}-${match[3]}-${match[2]}`
    cut(match, true)
  } else if ((match = SHORT_DATE_START.exec(stem))) {
    date = `20${match[1]}-${match[2]}-${match[3]}`
    cut(match, false)
  } else if ((match = SHORT_DATE_END.exec(stem))) {
    date = `20${match[1]}-${match[2]}-${match[3]}`
    cut(match, false)
  }

  if ((match = KEYWORD_INDEX.exec(stem))) {
    index = indexOf(match[2])
    cut(match, true)
  } else if ((match = SHEET_NUMBER_LETTER.exec(stem))) {
    index = indexOf(match[2])
    stem = match[1] + ' ' + stem.slice(match[0].length)
  }

  if (!index && !date) return null
  const key = seriesKey(stem)
  return key ? { key, index, date } : null
}

export interface RevisionSeriesMember<T> {
  item: T
  revision: RevisionName
}

export interface RevisionSeries<T> {
  /** The series key plus the format, so a PDF and a DWG of one Fassung are not versions of each other. */
  key: string
  /** The revision that looks current: Piloti's suggestion, never a decision. */
  current: RevisionSeriesMember<T>
  /** The others, newest first. */
  older: RevisionSeriesMember<T>[]
}

/**
 * The order revisions of ONE series are compared in, as a tuple — so it is a
 * total order whatever mix of names a series holds. A comparator that let the
 * index decide between some pairs and the date between others was cyclic (an
 * indexed revision older by date than an undated one, itself older than the
 * next index), and the "current" one then depended on the sort algorithm.
 *
 * When every revision carries an index of the same kind, the index decides,
 * then the date, then arrival — an office that numbers its revisions means the
 * number. Otherwise the date decides, then the index, then arrival.
 */
function newestFirst<T extends { createdAt?: string | null }>(members: RevisionSeriesMember<T>[]): RevisionSeriesMember<T>[] {
  const kinds = new Set(members.map((member) => member.revision.index?.kind ?? 'none'))
  const indexLeads = kinds.size === 1 && !kinds.has('none')
  const tuple = (member: RevisionSeriesMember<T>): [number, string, number, string] => [
    indexLeads ? (member.revision.index?.rank ?? 0) : 0,
    member.revision.date ?? '',
    member.revision.index?.rank ?? 0,
    member.item.createdAt ?? '',
  ]
  return [...members].sort((a, b) => {
    const ta = tuple(a)
    const tb = tuple(b)
    for (let i = 0; i < ta.length; i += 1) {
      if (ta[i] !== tb[i]) return ta[i] < tb[i] ? 1 : -1
    }
    return 0
  })
}

function signature(revision: RevisionName): string {
  return `${revision.index?.kind ?? ''}:${revision.index?.value ?? ''}:${revision.date ?? ''}`
}

/**
 * The documents that exist in more than one Fassung, each with its current one.
 *
 * A series needs at least two DIFFERENT revisions: one Fassung uploaded twice
 * is a duplicate, which the upload already handles, not a version history.
 * Grouped over the whole set handed in (callers pass one shelf's documents),
 * because an older Fassung is often moved into an `alt/` folder.
 */
export function findRevisionSeries<T extends { filename: string; createdAt?: string | null }>(
  items: readonly T[]
): RevisionSeries<T>[] {
  const groups = new Map<string, RevisionSeriesMember<T>[]>()
  for (const item of items) {
    const revision = parseRevisionName(item.filename)
    if (!revision) continue
    const key = `${revision.key}.${splitExtension(item.filename).extension}`
    const bucket = groups.get(key)
    if (bucket) bucket.push({ item, revision })
    else groups.set(key, [{ item, revision }])
  }
  const series: RevisionSeries<T>[] = []
  for (const [key, members] of groups) {
    if (new Set(members.map((member) => signature(member.revision))).size < 2) continue
    const ordered = newestFirst(members)
    series.push({ key, current: ordered[0], older: ordered.slice(1) })
  }
  // Code-point order, not locale order: the Python twin sorts the same way.
  return series.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** How a revision reads to a person: „Index C · 14.08.2026", „v3", „Stand 02.09.2026". */
export function revisionLabel(revision: RevisionName): string {
  const parts: string[] = []
  if (revision.index) parts.push(revision.index.kind === 'letter' ? `Index ${revision.index.value}` : `v${revision.index.value}`)
  if (revision.date) {
    const [year, month, day] = revision.date.split('-')
    parts.push(`${day}.${month}.${year}`)
  }
  return parts.join(' · ')
}
