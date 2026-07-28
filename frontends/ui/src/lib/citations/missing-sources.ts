/**
 * Missing-source candidates: the sources answers keep citing that citation
 * verification could not confirm, cross-checked against what the platform
 * actually holds, so each one carries the RIGHT next step.
 *
 * The cross-check is the point. A document key cited fifty times is only a
 * "missing document" if it genuinely is not in the base corpus; if it IS
 * there, the problem is retrieval or indexing, and telling an operator to
 * upload it again would send them down the wrong path. Same for a RIS pointer
 * already in the norm catalog.
 *
 * What can be added automatically, honestly stated:
 * - `ris`  — only when the URL carries a document number, which is the key a
 *            catalog entry is verified and stored under. Without one there is
 *            nothing to look up, so the candidate gets no add action.
 * - `document` — only a FILENAME is known; the file itself exists nowhere in
 *            the system, so the remedy is an upload the operator must supply.
 *            We prefill and point at the uploader; we do not pretend to fetch.
 * - `web`  — general web pages are not part of the grounded corpus at all.
 */

import 'server-only'
import type { FailedTargetRow } from './repository'

export type MissingSourceKind = 'document' | 'ris' | 'web'

/** What the operator can actually do about a candidate. */
export type MissingSourceAction =
  /** Verify + append to the norm catalog — fully automatic. */
  | 'add_to_norm_catalog'
  /** Upload the PDF to base knowledge — needs the file from the operator. */
  | 'upload_to_base_knowledge'
  /** Already held; the defect is retrieval/indexing, not a missing source. */
  | 'investigate_retrieval'
  /** Out of corpus scope — nothing to add. */
  | 'none'

export interface MissingSourceCandidate {
  target: string
  kind: MissingSourceKind
  reason: string
  turns: number
  organizations: number
  lastSeenAt: string
  /** True when the platform already holds this source. */
  present: boolean
  action: MissingSourceAction
  /** For `document` candidates: the bare filename to upload. */
  fileName: string | null
  /** For `ris` candidates: the RIS document number, when the URL carries one. */
  documentNumber: string | null
}

const RIS_HOST_RE = /^https?:\/\/(?:[\w-]+\.)*ris\.bka\.gv\.at\b/i
const URL_RE = /^https?:\/\//i
/** `filename.ext` optionally followed by a page reference, as citation keys carry. */
const FILE_KEY_RE = /^(.+?\.[A-Za-z0-9]{2,5})(?:\s*,\s*(?:p\.?|page|S\.)\s*\d+)?$/i
/** RIS URLs carry the document identity in a `Dokumentnummer` query/path segment. */
const RIS_DOCUMENT_NUMBER_RE = /(?:Dokumentnummer=|\/)(N[A-Z]{2}\d{6,}|[A-Z]{2,}_\d{8}_[\w]+)/i

export function classifyTarget(target: string): MissingSourceKind {
  if (RIS_HOST_RE.test(target)) return 'ris'
  if (URL_RE.test(target)) return 'web'
  return FILE_KEY_RE.test(target) ? 'document' : 'web'
}

/** Strip a trailing page reference so the key matches a corpus filename. */
export function fileNameFromTarget(target: string): string | null {
  const match = FILE_KEY_RE.exec(target.trim())
  if (!match) return null
  return match[1].trim().replace(/^.*[/\\]/, '')
}

export function risDocumentNumber(target: string): string | null {
  return RIS_DOCUMENT_NUMBER_RE.exec(target)?.[1] ?? null
}

/** Case-insensitive filename comparison — corpus casing is not guaranteed. */
const normalizeFileName = (name: string): string => name.trim().toLowerCase()

/**
 * Decide each candidate's kind, whether the platform already holds it, and the
 * one action that follows from those two facts.
 *
 * `corpusFileNames` / `catalogedDocumentNumbers` are the live inventories; an
 * EMPTY inventory is treated as "unknown, assume absent" rather than "nothing
 * is held", because the caller degrades to empty sets when the backend is
 * unreachable and a false "everything is missing" is the safer error than a
 * false "everything is fine". The service says so in its own docstring.
 */
export function buildMissingSourceCandidates(
  rows: FailedTargetRow[],
  corpusFileNames: string[],
  catalogedDocumentNumbers: string[],
): MissingSourceCandidate[] {
  const corpus = new Set(corpusFileNames.map(normalizeFileName))
  const cataloged = new Set(catalogedDocumentNumbers.map((value) => value.trim().toLowerCase()))

  return rows.map((row) => {
    const kind = classifyTarget(row.target)
    const fileName = kind === 'document' ? fileNameFromTarget(row.target) : null
    const documentNumber = kind === 'ris' ? risDocumentNumber(row.target) : null

    let present = false
    if (kind === 'document' && fileName) present = corpus.has(normalizeFileName(fileName))
    if (kind === 'ris' && documentNumber) present = cataloged.has(documentNumber.toLowerCase())

    let action: MissingSourceAction = 'none'
    if (present) action = 'investigate_retrieval'
    // A norm-catalog entry is keyed by its RIS document number. Without one
    // there is nothing to verify or append, so the candidate must not be
    // offered as an add — nor counted among the "only needs its rank
    // confirmed" additions the findings copy promises.
    else if (kind === 'ris' && documentNumber) action = 'add_to_norm_catalog'
    else if (kind === 'document' && fileName) action = 'upload_to_base_knowledge'

    return {
      target: row.target,
      kind,
      reason: row.reason,
      turns: row.turns,
      organizations: row.organizations,
      lastSeenAt: row.lastSeenAt.toISOString(),
      present,
      action,
      fileName,
      documentNumber,
    }
  })
}
