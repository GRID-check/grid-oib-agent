/**
 * The document-status vocabulary, declared once, as data.
 *
 * `documents.status` is an open `text` column and THREE vocabularies disagree
 * about what may be in it:
 *
 *   - the schema and its docs describe `pending → processing → processed | error`;
 *   - `reconcile-status.ts` writes `completed` and `failed`, and nothing else
 *     ever writes `processed` or `error`;
 *   - the Files badge knew eleven strings (`ready`, `uploaded`, `ingested`,
 *     `success`, `completed`, `ingesting`, `pending`, `processing`,
 *     `uploading`, `failed`, `error`) through a `Record<string, …>` with a
 *     silent fallback, so a twelfth cost nothing to add and nothing noticed.
 *
 * This module DOES NOT resolve that disagreement — it records it. Unifying what
 * the writers emit is a bigger, riskier change (a migration over live rows and
 * every reader of the column), and doing half of it here would leave the badge
 * telling a reader something the database no longer says. What changes is that
 * the set is now KNOWABLE: every value anything is known to emit is declared
 * here with what it means, `document-status.tsx` and `reconcile-status.ts`
 * DERIVE their tables from it instead of restating it, and
 * `document-status.spec.ts` fails when a writer emits a value nobody declared.
 * The next drift is a failing test rather than a grey badge.
 *
 * Two facts per value:
 *
 *   - `variant` — the Badge colour, which is also the FAMILY. Green is not
 *     decoration: it is the product telling the reader "Piloti can quote this",
 *     which is why `isCitableStatus` is exactly the `success` set and
 *     `isFailedStatus` exactly the `destructive` one. They were separate sets
 *     that happened to be identical; here they are one statement.
 *   - `phase` — whether the row will change on its own. This is the
 *     load-bearing one for `reconcile-status.ts`, which polls the backend for
 *     every in-flight row, and for the workspace, which re-reads the listing
 *     while anything is unsettled.
 */

/** Badge variants the Files chrome uses for a status. */
export type DocumentStatusVariant = 'success' | 'info' | 'destructive' | 'secondary'

/** Whether a status resolves itself, or is where the document has come to rest. */
export type DocumentStatusPhase = 'in-flight' | 'terminal'

export interface DocumentStatusFacts {
  readonly variant: DocumentStatusVariant
  readonly phase: DocumentStatusPhase
  /** `files` dictionary key for the badge label. */
  readonly labelKey: string
}

/**
 * Every status this codebase is known to render or write, and what it means.
 *
 * Grouped by family rather than alphabetically, because the grouping is the
 * point: five spellings of "indexed" exist because five writers arrived at the
 * question separately, and seeing them stacked is what makes that visible.
 */
export const DOCUMENT_STATUS_FACTS = {
  // --- Indexed: Piloti can quote it. Five spellings, one meaning. -----------
  ready: { variant: 'success', phase: 'terminal', labelKey: 'status.ready' },
  uploaded: { variant: 'success', phase: 'terminal', labelKey: 'status.ready' },
  ingested: { variant: 'success', phase: 'terminal', labelKey: 'status.ready' },
  success: { variant: 'success', phase: 'terminal', labelKey: 'status.ready' },
  /** What `reconcile-status.ts` actually writes when ingestion finishes. */
  completed: { variant: 'success', phase: 'terminal', labelKey: 'status.ready' },
  /**
   * The schema's documented terminal success. NOTHING in this repo emits it —
   * it is declared because the column's documentation names it, and because a
   * value that arrives from outside should render as what it means rather than
   * fall through to a grey badge. Declaring it is not a claim that anything
   * writes it; it is the fourth disagreement, written down.
   */
  processed: { variant: 'success', phase: 'terminal', labelKey: 'status.ready' },

  // --- In flight: the row will change on its own, so it gets polled. --------
  uploading: { variant: 'info', phase: 'in-flight', labelKey: 'status.uploading' },
  pending: { variant: 'info', phase: 'in-flight', labelKey: 'status.processing' },
  processing: { variant: 'info', phase: 'in-flight', labelKey: 'status.processing' },
  ingesting: { variant: 'info', phase: 'in-flight', labelKey: 'status.processing' },

  // --- Failed: terminal, and the card says why. ----------------------------
  failed: { variant: 'destructive', phase: 'terminal', labelKey: 'status.failed' },
  error: { variant: 'destructive', phase: 'terminal', labelKey: 'status.failed' },

  // --- Neither: the bytes are here and indexing was deliberately skipped. ---
  /**
   * An agent-authored report (migration 0063). Terminal, and NEUTRAL on
   * purpose: it is not a success — the document is not in the knowledge base
   * and never will be — and it is not a failure, because nothing went wrong.
   * A green badge would promise a citation the retrieval path cannot make;
   * a red one would report a fault that did not happen.
   *
   * Its phase is the load-bearing half: `stored` must stay OUT of the
   * in-flight set, or every read polls a backend that has never heard of the
   * job (there is no job — the document was never dispatched to `/v1/ingest`)
   * and the card spins forever on a row that is already at rest.
   */
  stored: { variant: 'secondary', phase: 'terminal', labelKey: 'status.stored' },
} as const satisfies Record<string, DocumentStatusFacts>

/** The declared vocabulary as a type — `keyof`, so it cannot drift from the data. */
export type KnownDocumentStatus = keyof typeof DOCUMENT_STATUS_FACTS

/**
 * A Map rather than the object itself, because the lookup key comes from the
 * database: `FACTS['constructor']` on a plain object answers with something
 * from `Object.prototype` and every predicate below would then be reading
 * facts off a function.
 */
const FACTS_BY_STATUS: ReadonlyMap<string, DocumentStatusFacts> = new Map(
  Object.entries(DOCUMENT_STATUS_FACTS),
)

/**
 * Every declared status, in declaration order.
 *
 * The cast is the one TypeScript forces: `Object.keys` is typed `string[]`
 * because a JS object may carry more keys than its type declares, which a
 * `const` literal in this file cannot. Narrowing it back to the literal union
 * is sound HERE and nowhere else.
 */
export const KNOWN_DOCUMENT_STATUSES: readonly KnownDocumentStatus[] = Object.keys(
  DOCUMENT_STATUS_FACTS,
) as KnownDocumentStatus[]

/**
 * What is known about a status, or `null` when it was never declared.
 *
 * Case-insensitive because the reading surfaces have always been: the column is
 * written lowercase, and a caller that lower-cases first would otherwise get a
 * different answer from one that does not.
 */
export function documentStatusFacts(status: string | null | undefined): DocumentStatusFacts | null {
  return FACTS_BY_STATUS.get((status ?? '').toLowerCase()) ?? null
}

export function isKnownDocumentStatus(status: string | null | undefined): status is KnownDocumentStatus {
  return documentStatusFacts(status) !== null
}

/**
 * The statuses whose outcome is not yet known — the set `reconcile-status.ts`
 * polls the backend about. Derived, so a new in-flight state is declared once
 * above and reaches the poller without anyone remembering to add it here.
 */
export const IN_FLIGHT_DOCUMENT_STATUSES: ReadonlySet<string> = new Set(
  KNOWN_DOCUMENT_STATUSES.filter((status) => DOCUMENT_STATUS_FACTS[status].phase === 'in-flight'),
)
