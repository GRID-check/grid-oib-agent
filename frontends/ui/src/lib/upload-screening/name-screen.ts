/**
 * The name gate (ADR-0086): does a file's path name something the office does
 * not want uploaded?
 *
 * Pure and client-safe. The browser runs it before upload, so an excluded file
 * is never sent; the BFF runs the same function on receipt, so a client that
 * skipped it cannot store one.
 *
 * Matching is a SUBSTRING of every path segment, after folding case, Unicode
 * form and the German umlauts (`ä`→`ae`, `ß`→`ss`). Substring because German
 * puts the head of a compound last: `Schlussrechnung`, `Monatslohn`,
 * `Architektenvertrag` are what offices actually name these files. The price is
 * words that merely contain a term — `Berechnung` contains `rechnung` — which
 * the office declares as exceptions: an occurrence of a term that lies inside
 * an occurrence of an exception does not count.
 *
 * A name is read the way the content screen reads prose (`./reading`):
 * invisible characters do not count (`Gehalts\u200Babrechnung` is
 * `Gehaltsabrechnung`), and a term of eight or more characters still matches
 * with one space, hyphen, underscore or full stop inside it
 * (`Gehalts-Abrechnung_Mai.pdf`), as long as each part keeps three.
 */

import type { UploadScreeningPolicy } from './policy'
import { SPLIT_TERM_MIN, splitTermEnd, TERM_FRAGMENT, withoutIgnorables } from './reading'

export type NameSegmentKind = 'file' | 'folder'

export interface NameMatch {
  /** The term as the office wrote it. */
  term: string
  /** The path segment it was found in, as uploaded. */
  segment: string
  kind: NameSegmentKind
}

export interface NameVerdict {
  blocked: boolean
  matches: NameMatch[]
}

export interface ScreenedName {
  /** The file's own name. */
  filename: string
  /** Where it sat before upload (`webkitRelativePath`), when the browser knows. */
  originPath?: string | null
  /** The project folder it is being filed into, as a materialised path. */
  folderPath?: string | null
}

const UMLAUTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ä/g, 'ae'],
  [/ö/g, 'oe'],
  [/ü/g, 'ue'],
  [/ß/g, 'ss'],
]

/** Case-, form- and umlaut-folded, so `Gehälter`, `GEHAELTER` and `Gehälter` (decomposed) are one string. */
export function foldForScreening(text: string): string {
  let folded = text.normalize('NFKC').toLocaleLowerCase('de')
  for (const [pattern, replacement] of UMLAUTS) folded = folded.replace(pattern, replacement)
  return folded
}

/** What may split a long term in a name: what people put between the words of a file name. */
const NAME_JOINERS = ' -_.\u2010\u2011'

/** A name as both gates compare it: invisible characters left out, then folded. */
function foldName(text: string): string {
  return foldForScreening(withoutIgnorables(text))
}

function occurrences(haystack: string, needle: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  if (!needle) return spans
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return spans
    spans.push([at, at + needle.length])
    from = at + 1
  }
}

/** `occurrences` of a term, and for a long one also where one joiner splits it (`splitTermEnd`). */
function termOccurrences(haystack: string, term: string): Array<[number, number]> {
  if (term.length < SPLIT_TERM_MIN) return occurrences(haystack, term)
  return occurrences(haystack, term.slice(0, TERM_FRAGMENT)).flatMap(
    ([at]): Array<[number, number]> => {
      const end = splitTermEnd(haystack, at, term, NAME_JOINERS)
      return end > at ? [[at, end]] : []
    }
  )
}

function coveredBy(span: [number, number], covers: Array<[number, number]>): boolean {
  return covers.some(([start, end]) => start <= span[0] && span[1] <= end)
}

/** The first term of the policy this one segment matches, ignoring occurrences inside an exception. */
function matchSegment(
  segment: string,
  terms: readonly { raw: string; folded: string }[],
  exceptions: readonly string[]
): string | null {
  const folded = foldName(segment)
  const excepted = exceptions.flatMap((exception) => termOccurrences(folded, exception))
  for (const term of terms) {
    const hit = termOccurrences(folded, term.folded).some((span) => !coveredBy(span, excepted))
    if (hit) return term.raw
  }
  return null
}

function pathSegments(path: string | null | undefined): string[] {
  if (!path) return []
  return path
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

/**
 * Every segment worth checking, with what it is. The origin path's last
 * segment IS the file, so it is not checked twice; folders from the origin path
 * and from the target project folder are both checked, because either can be
 * the one called „Personal".
 */
function segmentsOf(name: ScreenedName): Array<{ segment: string; kind: NameSegmentKind }> {
  const origin = pathSegments(name.originPath)
  const originFolders = origin.length > 0 ? origin.slice(0, -1) : []
  const targetFolders = pathSegments(name.folderPath)
  const seen = new Set<string>()
  const out: Array<{ segment: string; kind: NameSegmentKind }> = []
  const add = (segment: string, kind: NameSegmentKind): void => {
    const key = `${kind}:${segment}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ segment, kind })
  }
  add(name.filename, 'file')
  for (const folder of [...originFolders, ...targetFolders]) add(folder, 'folder')
  return out
}

/** Screen one file's name and path against the policy. Never throws. */
export function screenUploadName(policy: UploadScreeningPolicy, name: ScreenedName): NameVerdict {
  if (!policy.enabled || policy.nameTerms.length === 0) return { blocked: false, matches: [] }
  const terms = policy.nameTerms.map((raw) => ({ raw, folded: foldName(raw) }))
  const exceptions = policy.nameExceptions.map(foldName)
  const matches: NameMatch[] = []
  for (const { segment, kind } of segmentsOf(name)) {
    const term = matchSegment(segment, terms, exceptions)
    if (term) matches.push({ term, segment, kind })
  }
  return { blocked: matches.length > 0, matches }
}
