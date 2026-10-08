/**
 * Who reads a document, and whether a document has been screened (ADR-0083).
 *
 * A person's upload is held back from everyone but its uploader and the people
 * who review the quarantine from the moment it is stored until the content
 * gate PASSES it. Held back is not a status a reader has to remember to check:
 * every query over `documents` states its reader, and the one SQL predicate
 * (`documentVisibleTo` in `./visibility`) turns the reader into the rows it may
 * see. This module is the pure half: the reader type, the facts that decide
 * "screened", and the same rule asked of a row already in memory, for a
 * listing whose reconcile changed a row after the query read it.
 *
 * No database import, so a unit spec can apply the rule to its fixtures and the
 * client bundle never sees it by accident.
 */

import type { DocumentScreeningOutcome } from '@/lib/db/schema/documents'
import { IN_FLIGHT_DOCUMENT_STATUSES } from './document-status'

/**
 * The verdicts that let a person's upload reach everyone who may read its
 * folder. `partial` and `unchecked` pass: a file with no readable text (a scan,
 * a photo) is screened by its name alone, which the product owner chose over
 * holding every scan (ADR-0083, "What is not screened"). `quarantined` is the
 * one verdict that holds a file, and NULL is no verdict at all.
 */
export const SCREENING_PASSED_OUTCOMES = ['clean', 'partial', 'unchecked', 'released'] as const satisfies
  readonly DocumentScreeningOutcome[]

/**
 * The statuses at which a file that carries NO verdict has been read to the
 * end: its job ran with screening switched off (`enabled: false`), or it was
 * indexed before screening existed (migration 0107). Every other verdict-less
 * row is still on its way through the gate (`uploaded`, `pending`,
 * `processing`) or never made it (`failed`, `error`), and is held: nothing
 * has said its content may be read. Lowercase, as every writer writes them.
 */
export const UNSCREENED_SETTLED_STATUSES = ['completed', 'ready', 'ingested', 'success', 'processed'] as const

/** The row facts the rule reads. */
export interface ScreeningFacts {
  status: string
  authoredBy: string
  screeningOutcome: DocumentScreeningOutcome | null
  /** The digest of the bytes the row holds now. */
  contentHash: string | null
  /** The digest of the bytes the verdict judged (migration 0121). */
  screenedHash: string | null
}

const PASSED: ReadonlySet<string> = new Set(SCREENING_PASSED_OUTCOMES)
const SETTLED: ReadonlySet<string> = new Set(UNSCREENED_SETTLED_STATUSES)

/**
 * Whether the content gate has let this file through. Piloti's own documents
 * (`authoredBy` other than `user`) were never an upload and are not held. A
 * `quarantined` status holds whatever the verdict column says.
 *
 * A verdict is about the bytes it judged, not about the document: it counts
 * only while `screenedHash` names the bytes the row holds now. A writer that
 * swaps `storage_key`/`content_hash` (a published draft, a content write to the
 * version the item mirrors) leaves the verdict behind and the file held, so no
 * writer has to remember to reset it.
 */
export function hasPassedScreening(row: ScreeningFacts): boolean {
  if (row.status === 'quarantined') return false
  if (row.authoredBy !== 'user') return true
  if ((row.screenedHash ?? null) !== (row.contentHash ?? null)) return false
  // `undefined` reads as no verdict: a row read without the column.
  const verdict = row.screeningOutcome ?? null
  if (verdict !== null) return PASSED.has(verdict)
  return SETTLED.has(row.status)
}

/**
 * Held, and nothing will move it on its own: a quarantine, or a file the gate
 * never reached a verdict on and that is no longer in flight (its reading
 * failed, it was stranded before its dispatch, its bytes were swapped after
 * the verdict). Each waits on a reviewer, who may release it
 * (`releaseQuarantinedDocument`); `heldAtRest` in `./visibility` is the same
 * rule in SQL, for the reviewers' queue.
 */
export function isHeldAtRest(row: ScreeningFacts): boolean {
  return !hasPassedScreening(row) && !IN_FLIGHT_DOCUMENT_STATUSES.has(row.status)
}

/** How a person reads one shelf: as somebody who reviews its quarantine, or not. */
export type ShelfReader = { readonly kind: 'member'; readonly userId: string } | { readonly kind: 'reviewer' }

/**
 * Why an internal path reads every row, held ones included. A closed list on
 * purpose: a new reason is a change to this type, which review sees, rather
 * than a string any caller can make up.
 *
 *   - `just-written`: the caller inserted or replaced this row a moment ago
 *     (filing Piloti's document, recording an upload's version) and reads it
 *     back to carry on with the same gesture.
 *   - `ingest`: the dispatch, the reconcile and the pipeline's own lookups of
 *     the file they are working on, which is held by definition.
 *   - `quarantine-review`: a row loaded to ask whether this session reviews it,
 *     or acted on after `mayReviewQuarantine` said so.
 *   - `identity`: "does a document by this name (or this run's reference)
 *     exist here", which a unique index answers for every row, held ones
 *     included; an upload answers a held row its uploader may not see as a
 *     taken name (`assertMayReplaceHeld`).
 *   - `audit`: the trail and the reviewers' notification about a verdict.
 *   - `reloaded`: the same request already loaded this row through its
 *     reader's rule a moment ago (an IFC model's header, before the query
 *     that runs on it) and reads it again to act on it.
 *   - `resolve-document`: a row of another table read through its document
 *     only to learn WHICH document to ask the rule about (an IFC model's
 *     header, whose document `findDocumentForSession` then loads).
 */
export type InternalDocumentRead =
  | 'just-written'
  | 'ingest'
  | 'quarantine-review'
  | 'identity'
  | 'audit'
  | 'reloaded'
  | 'resolve-document'

/**
 * Who a query over `documents` reads for. Every repository read takes one, so
 * a new query cannot forget the hold; `documentVisibleTo` is what it composes.
 *
 *   - `member`: a person who does not review this shelf's quarantine. Screened
 *     rows, and the held rows they uploaded themselves.
 *   - `reviewer`: a person who does (`mayReviewQuarantine`). Every row.
 *   - `shelves`: one person reading two shelves at once (the IFC model list,
 *     a project's models and the Büroablage's), asked per row of its own shelf.
 *   - `projects`: one person reading many projects at once (the project grid's
 *     counts), a reviewer of some of them: held rows of those, and their own.
 *   - `screened-only`: nobody's own uploads count. What reaches a model, and
 *     every path that serves no particular person.
 *   - `internal`: every row, for a reason {@link InternalDocumentRead} names.
 */
export type DocumentReader =
  | ShelfReader
  | { readonly kind: 'shelves'; readonly project: ShelfReader; readonly archiv: ShelfReader }
  | { readonly kind: 'projects'; readonly userId: string; readonly reviewedProjectIds: readonly string[] }
  | { readonly kind: 'screened-only' }
  | { readonly kind: 'internal'; readonly why: InternalDocumentRead }

export const memberReader = (userId: string): ShelfReader => ({ kind: 'member', userId })
export const REVIEWER_READER: ShelfReader = { kind: 'reviewer' }
export const SCREENED_ONLY: DocumentReader = { kind: 'screened-only' }
export const internalRead = (why: InternalDocumentRead): DocumentReader => ({ kind: 'internal', why })

/** The row facts {@link mayReadDocument} reads. */
export interface ReadableFacts extends ScreeningFacts {
  createdBy: string
  scope: string
  projectId: string | null
}

function shelfMayRead(row: ReadableFacts, reader: ShelfReader): boolean {
  return reader.kind === 'reviewer' || row.createdBy === reader.userId
}

/**
 * `documentVisibleTo` asked of a row in memory. The same rule over the same
 * facts; `visibility.integration.spec.ts` holds the two to the same answer for
 * every combination of status, verdict, author and reader.
 */
export function mayReadDocument(row: ReadableFacts, reader: DocumentReader): boolean {
  if (reader.kind === 'internal' || reader.kind === 'reviewer') return true
  if (hasPassedScreening(row)) return true
  switch (reader.kind) {
    case 'member':
      return shelfMayRead(row, reader)
    case 'shelves':
      if (row.scope === 'project') return shelfMayRead(row, reader.project)
      if (row.scope === 'archiv') return shelfMayRead(row, reader.archiv)
      return false
    case 'projects':
      return (
        row.createdBy === reader.userId ||
        (row.scope === 'project' && row.projectId !== null && reader.reviewedProjectIds.includes(row.projectId))
      )
    case 'screened-only':
      return false
  }
}

/**
 * The rows of ONE shelf's listing this reader may still read, after a reconcile
 * changed some of them: the first read after a file's verdict can find it in
 * flight with an earlier pass on record (a re-index), and the reconcile turns
 * it `quarantined`.
 */
export function keepReadable<T extends ScreeningFacts & { createdBy: string }>(rows: T[], reader: ShelfReader): T[] {
  return rows.filter((row) => reader.kind === 'reviewer' || hasPassedScreening(row) || row.createdBy === reader.userId)
}
