/**
 * The run ledger: what a run DID, as the reader is told it.
 *
 * A deep-research run and a task run are one assistant message in the
 * conversation the work was commissioned in, and this is the account that
 * message carries: the phases the run walked, the steps it took inside them —
 * each described by the INTENT the runner stated — the documents each step
 * reached, and the terminal fact (a filed document and a report, or an error).
 * It is produced by the tier that produces the events, persisted on the message
 * beside `retrieval_ledger`, and it is the only thing any surface renders from,
 * so a live stream, a reload and a shared thread cannot tell three stories.
 *
 * ## Why this module has no `server-only` and no drizzle
 *
 * It is the contract, and the contract has four readers that are not the
 * service: the internal route handler, the browser, the typed client
 * (`./run-ledger-client`), and — through the JSON Schema written from these zod
 * schemas into `tests/fixtures/run-ledger.schema.json` — the Python agent tier
 * (`src/aiq_agent/common/run_ledger.py`). Importing the database schema here
 * would drag drizzle into the transport layer, which
 * `server-component-db-access.spec.ts` fails on, and it would make the Python
 * export impossible to build without a database. Same arrangement as
 * `lib/documents/lifecycle-types.ts` (ADR-0055).
 *
 * ## The vocabularies are ASCII keys; the German is rendered from a dictionary
 *
 * `planen` and `laeuft` are KEYS. The reader sees „Planen" and „läuft", and the
 * umlaut lives in `src/i18n/dictionaries` where every other user-facing string
 * lives. A key with an umlaut in it is a key that arrives differently normalised
 * depending on who serialised it, which is a bug nobody can see.
 *
 * ## The bounds are the retrieval ledger's
 *
 * `docs` and their `loci` reuse `RetrievalLedgerDoc`'s vocabulary and budgets
 * (`lib/conversations/message-retrieval-ledger.ts`) on purpose: they describe
 * the same thing — a document a step reached, and where in it — and two
 * different caps on one fact is how a Herleitung and a run ledger start
 * disagreeing about the same file. The enforcement lives in `./run-ledger`,
 * which sanitises on write and again on read; these schemas are what the WIRE
 * promises, and they promise the same numbers.
 */

import { z } from 'zod'

/**
 * The five phases a run walks, in order.
 *
 * A tuple, so the set is enumerable at runtime and the type is derived rather
 * than restated. `abgelegt` is a phase and not a status because filing is work
 * the run does — it takes time and it can be the thing that failed.
 */
export const RUN_PHASES = ['planen', 'recherchieren', 'pruefen', 'schreiben', 'abgelegt'] as const
export type RunPhase = (typeof RUN_PHASES)[number]

/**
 * The seven display states a run is shown in.
 *
 * Not `task_runs.status` — that column is the row's lifecycle and it keeps its
 * own CHECK. These are what the reader is told, derived from the row plus a
 * pending ask plus this ledger's terminal fields. `wartet` is the one with no
 * column behind it at all: a run that has asked the person a question is not
 * running and is not finished, and showing it as either is how a run sits
 * unanswered for a day.
 */
export const RUN_STATUSES = [
  'angelegt',
  'laeuft',
  'wartet',
  'fertig',
  'fehlgeschlagen',
  'abgebrochen',
  'unterbrochen',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** The states from which nothing more happens on its own. */
export const TERMINAL_RUN_STATUSES = [
  'fertig',
  'fehlgeschlagen',
  'abgebrochen',
  'unterbrochen',
] as const satisfies readonly RunStatus[]

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status)
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------
//
// The client is not trusted with any of them. This lands in message
// metadata/jsonb, which is fed from a browser and from a worker, so the key set
// is closed, lists are truncated and every string is capped — on WRITE and again
// on READ (`server-message-mapper`), so a row written by an older or a malicious
// client still renders safely.

/** A run id is a uuid; the cap is headroom, not a format check. */
export const MAX_RUN_ID_CHARS = 64
/** A run that has taken fifty described steps has told the reader enough. */
export const MAX_STEPS = 50
export const MAX_STEP_ID_CHARS = 64
/** Mirrors `turn_status.MAX_REASON_CHARS`: an intent is one sentence. */
export const MAX_INTENT_CHARS = 160
/** Mirrors `RetrievalLedger`'s `MAX_DOCS_PER_ROUND`. */
export const MAX_DOCS_PER_STEP = 100
export const MAX_NAME_CHARS = 256
export const MAX_TITLE_CHARS = 256
export const MAX_SHELF_CHARS = 64
/** Mirrors `RetrievalLedgerDoc.detail` — one page or Punkt, spelled out. */
export const MAX_LOCUS_CHARS = 128
/** Twenty places in one document; past that the document itself is the fact. */
export const MAX_LOCI_PER_DOC = 20
export const MAX_OPEN_POINTS = 20
export const MAX_OPEN_POINT_CHARS = 200
/** What a round established, one claim per line. Mirrors `run_ledger.MAX_FINDINGS_PER_STEP`. */
export const MAX_FINDINGS_PER_STEP = 8
export const MAX_FINDING_CHARS = 200
/**
 * The run's error, as the reader sees it. Shorter than the 2000 the outcome
 * route accepts, because this one is rendered in the thread rather than stored
 * for an operator: a paragraph of stack trace is not an explanation.
 */
export const MAX_ERROR_REASON_CHARS = 400
export const MAX_REFERENCE_ID_CHARS = 128
/**
 * The run's title as the block's header shows it (`metadata.run_title`): a
 * task's title or the question a deep-research run was asked. The same 200 a
 * `task_runs.title` is cut to, so the thread and the Aufträge index name one
 * run the same way. Not part of the ledger schema: it is known at submit time,
 * before the worker has said anything, and it never changes.
 */
export const MAX_RUN_TITLE_CHARS = 200
/** An ISO-8601 instant with an offset is at most this long. */
export const MAX_TIMESTAMP_CHARS = 40

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/**
 * An instant, ISO-8601. Offsets are accepted on the wire because the producer
 * is a Python worker; `sanitizeRunLedger` normalises every one of them to UTC,
 * so what is STORED is always `…Z` and two ledgers are comparable as strings.
 *
 * The format check is the bound: an ISO-8601 instant cannot exceed
 * {@link MAX_TIMESTAMP_CHARS}, so a second `.max()` would only be a second place
 * to disagree with the first.
 */
const instantSchema = z.string().datetime({ offset: true })

/**
 * One document a step reached, plus where in it.
 *
 * `loci` is the list `RetrievalLedgerDoc.detail` holds one of: a step is a
 * longer unit than a retrieval round and reaches the same file at several pages,
 * and collapsing those into one entry per page would make the reader count the
 * same document four times.
 */
export const runLedgerDocSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME_CHARS),
    title: z.string().trim().min(1).max(MAX_TITLE_CHARS).optional(),
    shelf: z.string().trim().min(1).max(MAX_SHELF_CHARS).optional(),
    loci: z.array(z.string().trim().min(1).max(MAX_LOCUS_CHARS)).max(MAX_LOCI_PER_DOC),
    /**
     * The step reached this document a second time — the producer's own verdict,
     * which is the only side that can reach it (it needs every earlier step).
     */
    repeat: z.boolean().optional(),
  })
  .strict()

export type RunLedgerDoc = z.infer<typeof runLedgerDocSchema>

/**
 * One step of a run.
 *
 * There is deliberately NO tool-name field: the reader is told what the run was
 * trying to do, in the runner's own words, because a tool name is an
 * implementation detail that changes when we rename a function and means nothing
 * to the person waiting for a Befund.
 */
export const runStepSchema = z
  .object({
    id: z.string().trim().min(1).max(MAX_STEP_ID_CHARS),
    phase: z.enum(RUN_PHASES),
    /** The runner's own words for what this step is for. Narration, not a verdict. */
    intent: z.string().trim().min(1).max(MAX_INTENT_CHARS),
    startedAt: instantSchema,
    docs: z.array(runLedgerDocSchema).max(MAX_DOCS_PER_STEP),
    /** What this step could not settle. Absent when it settled everything. */
    openPoints: z
      .array(z.string().trim().min(1).max(MAX_OPEN_POINT_CHARS))
      .max(MAX_OPEN_POINTS)
      .optional(),
    /** What this round established so far, in the researcher's own claims. */
    findings: z
      .array(z.string().trim().min(1).max(MAX_FINDING_CHARS))
      .max(MAX_FINDINGS_PER_STEP)
      .optional(),
  })
  .strict()

export type RunStep = z.infer<typeof runStepSchema>

/** One phase the run entered, and — once it is over — left. */
export const runPhaseEntrySchema = z
  .object({
    phase: z.enum(RUN_PHASES),
    startedAt: instantSchema,
    endedAt: instantSchema.optional(),
  })
  .strict()

export type RunPhaseEntry = z.infer<typeof runPhaseEntrySchema>

/** What a finished run left behind. */
export const runResultSchema = z
  .object({
    /** The document the report was filed as, when the kind files one. */
    fileId: z.string().trim().min(1).max(MAX_REFERENCE_ID_CHARS).optional(),
    /** The message carrying the report, when it is not this run's own message. */
    reportMessageId: z.string().trim().min(1).max(MAX_REFERENCE_ID_CHARS).optional(),
    filedAt: instantSchema,
  })
  .strict()

export type RunResult = z.infer<typeof runResultSchema>

/**
 * Why a run stopped, and what it had finished by then.
 *
 * `completedBefore` is what makes a failure readable: „beim Prüfen gescheitert,
 * Planen und Recherchieren waren fertig" is a different message from „failed".
 * It is DERIVED from the phases that had ended (see `failRun`), never taken from
 * the caller, for the same reason the retrieval ledger derives its tallies.
 */
export const runErrorSchema = z
  .object({
    reason: z.string().trim().min(1).max(MAX_ERROR_REASON_CHARS),
    completedBefore: z.array(z.enum(RUN_PHASES)).max(RUN_PHASES.length),
  })
  .strict()

export type RunError = z.infer<typeof runErrorSchema>

/** The whole account of one run. */
export const runLedgerSchema = z
  .object({
    runId: z.string().trim().min(1).max(MAX_RUN_ID_CHARS),
    status: z.enum(RUN_STATUSES),
    phases: z.array(runPhaseEntrySchema).max(RUN_PHASES.length),
    steps: z.array(runStepSchema).max(MAX_STEPS),
    result: runResultSchema.optional(),
    error: runErrorSchema.optional(),
    startedAt: instantSchema,
    updatedAt: instantSchema,
    finishedAt: instantSchema.optional(),
  })
  .strict()

export type RunLedger = z.infer<typeof runLedgerSchema>

/**
 * `POST /api/internal/runs/[runId]/ledger` — the two ops, and no others.
 *
 * `append` is what the fold flushes: more steps, the phases it opened or closed,
 * and the status it believes the run is in. `finish` is the terminal one and it
 * carries exactly one of `result` or `error` — both or neither is a 400, checked
 * in the route rather than in the schema because a `.refine()` cannot live
 * inside a discriminated union.
 *
 * The run id is in the PATH and never in the body: it is the only identity this
 * route has, and a body that could name a second run would be a body that could
 * write another tenant's ledger.
 */
export const runLedgerAppendRequestSchema = z
  .object({
    op: z.literal('append'),
    steps: z.array(runStepSchema).max(MAX_STEPS).optional(),
    phases: z.array(runPhaseEntrySchema).max(RUN_PHASES.length).optional(),
    status: z.enum(RUN_STATUSES).optional(),
  })
  .strict()

export const runLedgerFinishRequestSchema = z
  .object({
    op: z.literal('finish'),
    result: runResultSchema.optional(),
    error: z
      .object({ reason: z.string().trim().min(1).max(MAX_ERROR_REASON_CHARS) })
      .strict()
      .optional(),
  })
  .strict()

export const runLedgerRequestSchema = z.discriminatedUnion('op', [
  runLedgerAppendRequestSchema,
  runLedgerFinishRequestSchema,
])

export type RunLedgerAppendRequest = z.infer<typeof runLedgerAppendRequestSchema>
export type RunLedgerFinishRequest = z.infer<typeof runLedgerFinishRequestSchema>
export type RunLedgerRequest = z.infer<typeof runLedgerRequestSchema>

/** What every op answers with: the ledger as it now stands, sanitised. */
export const runLedgerResponseSchema = z
  .object({ runId: z.string().min(1).max(MAX_RUN_ID_CHARS), ledger: runLedgerSchema })
  .strict()

export type RunLedgerResponse = z.infer<typeof runLedgerResponseSchema>

/** `GET /api/projects/[id]/runs/[runId]` — one run, with its ledger. */
export const runViewSchema = z
  .object({
    runId: z.string().min(1).max(MAX_RUN_ID_CHARS),
    backendJobId: z.string().nullable(),
    conversationId: z.string().nullable(),
    messageId: z.string().nullable(),
    /** The row's own lifecycle status, unmapped. The display state is derived. */
    status: z.string(),
    ledger: runLedgerSchema.nullable(),
  })
  .strict()

export type RunView = z.infer<typeof runViewSchema>

/**
 * The schemas exported to JSON Schema for the Python tier, by name.
 *
 * A map rather than "every export that happens to be a zod object", so what
 * crosses the language boundary is a decision somebody took rather than a
 * consequence of a rename. `tests/fixtures/run-ledger.schema.json` is generated
 * from exactly this, and `run-ledger-schema.spec.ts` fails when the file and the
 * code disagree.
 */
export const RUN_LEDGER_WIRE_SCHEMAS = {
  runLedger: runLedgerSchema,
  runLedgerRequest: runLedgerRequestSchema,
  runLedgerResponse: runLedgerResponseSchema,
  runView: runViewSchema,
} as const
