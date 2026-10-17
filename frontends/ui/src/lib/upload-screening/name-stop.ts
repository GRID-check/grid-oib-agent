/**
 * A file the name check (*Namensprüfung*, ADR-0086) stopped, as the upload's
 * batch records it and as the browser reads the server's refusal of it.
 *
 * The browser's check stops a file before any byte or its name leaves; the
 * server repeats the check and answers a file it would stop with a 422
 * `UPLOAD_SCREENED` carrying the matches. Either way the file is „Nicht
 * hochgeladen“, and the batch counts it by term, never by name: the name is
 * part of what the check keeps back, and the browser's stops never reached the
 * server as files at all.
 *
 * Pure and client-safe: the upload hook and the mail import both read it.
 */

import type { NameMatch, NameSegmentKind } from './name-screen'

/** The code of the server's refusal (`ScreenedUploadError`). */
export const UPLOAD_SCREENED_CODE = 'UPLOAD_SCREENED'

/** One term of the office's list and how many files it stopped; the batch's `excluded` entry. */
export interface NameStopTally {
  term: string
  count: number
}

/**
 * What the name check stopped, as the batch records it: one entry per term,
 * counting the files it caught first, in the order the terms first appear.
 * Names are dropped here.
 */
export function exclusionsByTerm(stopped: ReadonlyArray<readonly NameMatch[]>): NameStopTally[] {
  const counts = new Map<string, number>()
  for (const matches of stopped) {
    const term = matches[0]?.term
    if (term) counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  return [...counts].map(([term, count]) => ({ term, count }))
}

const SEGMENT_KINDS: ReadonlySet<string> = new Set<NameSegmentKind>(['file', 'folder'])

function isNameMatch(value: unknown): value is NameMatch {
  if (!value || typeof value !== 'object') return false
  const { term, segment, kind } = value as Record<string, unknown>
  return typeof term === 'string' && term !== '' && typeof segment === 'string' && typeof kind === 'string' && SEGMENT_KINDS.has(kind)
}

/**
 * The matches of a 422 `UPLOAD_SCREENED` envelope (`{ error, code, details: {
 * matches } }`), or null when the body is not one. A body whose matches cannot
 * be read is still the name check's refusal: an empty list, a stop with no
 * term to count.
 */
export function nameStopMatchesOf(body: unknown): NameMatch[] | null {
  if (!body || typeof body !== 'object') return null
  if ((body as { code?: unknown }).code !== UPLOAD_SCREENED_CODE) return null
  const matches = ((body as { details?: { matches?: unknown } }).details ?? {}).matches
  return Array.isArray(matches) ? matches.filter(isNameMatch) : []
}
