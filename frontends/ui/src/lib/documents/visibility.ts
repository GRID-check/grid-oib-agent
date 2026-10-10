/**
 * The one visibility predicate over `documents` (ADR-0086, amended 2026-10-08).
 *
 * A person's upload is held back from its upload until its screening passes:
 * only its uploader and the quarantine's reviewers may see it, list it, probe
 * its name, read its bytes, open its model or change it. Three rounds of repair
 * found reader after reader that forgot a `status = 'quarantined'` check
 * (the overview, the name probes, the IFC list, document roles, the sharing
 * registry, the version workflow, delete and move, the status read, the agent's
 * version read). The status was a fact every reader had to remember. Now the
 * reader is an argument every query takes, and this function is the one place
 * it becomes SQL. `document-visibility.spec.ts` fails for a query over the
 * table that does not compose it, unless its allowlist says why that query
 * must see every row.
 */

import 'server-only'
import { and, eq, inArray, isNotNull, isNull, ne, not, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { documents } from '@/lib/db/schema'
import { IN_FLIGHT_DOCUMENT_STATUSES } from './document-status'
import {
  SCREENING_PASSED_OUTCOMES,
  UNSCREENED_SETTLED_STATUSES,
  type DocumentReader,
  type ShelfReader,
} from './document-reader'

export {
  internalRead,
  memberReader,
  REVIEWER_READER,
  SCREENED_ONLY,
  type DocumentReader,
  type InternalDocumentRead,
  type ShelfReader,
} from './document-reader'

/**
 * `hasPassedScreening` (`./document-reader`) as SQL. Two-valued on purpose: an
 * `IN` over a NULL verdict is NULL, not false, and `heldAtRest` negates this.
 */
function passedScreening(): SQL {
  return and(
    ne(documents.status, 'quarantined'),
    or(
      ne(documents.authoredBy, 'user'),
      and(
        // The verdict judged the bytes the row holds now (migration 0123).
        sql`${documents.screenedHash} IS NOT DISTINCT FROM ${documents.contentHash}`,
        or(
          and(isNotNull(documents.screeningOutcome), inArray(documents.screeningOutcome, [...SCREENING_PASSED_OUTCOMES])),
          and(isNull(documents.screeningOutcome), inArray(documents.status, [...UNSCREENED_SETTLED_STATUSES])),
        ),
      ),
    ),
  ) as SQL
}

/**
 * `isHeldAtRest` (`./document-reader`) as SQL: the rows the reviewers' queue
 * lists and a release may take, whether the gate quarantined them or never
 * reached a verdict on them.
 */
export function heldAtRest(): SQL {
  return and(not(passedScreening()), notInArray(documents.status, [...IN_FLIGHT_DOCUMENT_STATUSES])) as SQL
}

/** A held row this shelf reader may still see: one they uploaded, or any when they review. */
function heldRowFor(reader: ShelfReader): SQL {
  return reader.kind === 'reviewer' ? sql`true` : eq(documents.createdBy, reader.userId)
}

/**
 * The rows of `documents` this reader may see, as a predicate to AND into a
 * query's WHERE. `undefined` for a reader who sees every row (a reviewer, an
 * internal read), which `and()` drops.
 */
export function documentVisibleTo(reader: DocumentReader): SQL | undefined {
  switch (reader.kind) {
    case 'internal':
    case 'reviewer':
      return undefined
    case 'member':
      return or(passedScreening(), heldRowFor(reader))
    case 'shelves':
      return or(
        passedScreening(),
        and(eq(documents.scope, 'project'), heldRowFor(reader.project)),
        and(eq(documents.scope, 'archiv'), heldRowFor(reader.archiv)),
      )
    case 'projects':
      return or(
        passedScreening(),
        eq(documents.createdBy, reader.userId),
        ...(reader.reviewedProjectIds.length > 0
          ? [and(eq(documents.scope, 'project'), inArray(documents.projectId, [...reader.reviewedProjectIds]))]
          : []),
      )
    case 'screened-only':
      return passedScreening()
  }
}
