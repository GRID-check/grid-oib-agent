/**
 * The run ledger, bounded — and the pure moves that grow one.
 *
 * The sibling of `sanitizeRetrievalLedger`
 * (`lib/conversations/message-retrieval-ledger.ts`) and the same doctrine, for
 * the same reason: this lands in `messages.metadata.run_ledger`, a jsonb blob
 * fed by a worker and read back by a build that may not be the one that wrote
 * it. So the key set is CLOSED (a new object is built field by field, never
 * spread), lists are truncated, every string is capped, and anything the ledger
 * can work out for itself is DERIVED rather than copied — a tampered payload
 * must not be able to claim a phase was completed that never ended.
 *
 * Applied on WRITE (`lib/runs/service.ts`) and again on READ
 * (`features/chat/lib/server-message-mapper.ts`), so a row written by an older
 * or a hostile client still renders safely.
 *
 * ## Why the moves live here and not in the service
 *
 * `appendStep`, `openPhase`, `closePhase`, `finishRun` and `failRun` are the
 * whole vocabulary of "what happened next". They are pure — ledger in, new
 * ledger out, nothing mutated — because three tiers need the same fold: the BFF
 * service applying an op, the Python fold that will emit the snapshots, and the
 * UI applying a streamed snapshot optimistically. A fold that lived in the
 * service would be reimplemented twice, and the copies would disagree about the
 * one thing this file exists to make single: what the reader is told.
 *
 * Every move re-sanitises its own output. That is not belt and braces: the moves
 * are the write path, so sanitising here is what makes „sanitised on write" true
 * without every caller remembering it.
 */

import {
  MAX_DOCS_PER_STEP,
  MAX_ERROR_REASON_CHARS,
  MAX_INTENT_CHARS,
  MAX_LOCI_PER_DOC,
  MAX_LOCUS_CHARS,
  MAX_NAME_CHARS,
  MAX_OPEN_POINTS,
  MAX_OPEN_POINT_CHARS,
  MAX_REFERENCE_ID_CHARS,
  MAX_RUN_ID_CHARS,
  MAX_RUN_TITLE_CHARS,
  MAX_SHELF_CHARS,
  MAX_STEPS,
  MAX_STEP_ID_CHARS,
  MAX_TITLE_CHARS,
  RUN_PHASES,
  RUN_STATUSES,
  type RunError,
  type RunLedger,
  type RunLedgerDoc,
  type RunPhase,
  type RunPhaseEntry,
  type RunResult,
  type RunStatus,
  type RunStep,
} from './run-ledger-types'

/** A plain JSON object — never an array, never null. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A trimmed non-empty string within budget, or undefined. */
const cap = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : undefined

/** A bounded string list: capped items, dropped empties, `[]` when none survive. */
function capList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return []
  const items: string[] = []
  for (const raw of value) {
    if (items.length >= maxItems) break
    const text = cap(raw, maxChars)
    if (text !== undefined) items.push(text)
  }
  return items
}

/**
 * An instant, normalised to UTC, or undefined.
 *
 * Normalised rather than passed through: the producer is a Python worker that
 * may send an offset, the browser sends `…Z`, and a ledger whose timestamps are
 * spelled two ways cannot be ordered by string compare — which is exactly what
 * every renderer of it does.
 */
function instant(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = new Date(value)
  const time = parsed.getTime()
  return Number.isFinite(time) ? parsed.toISOString() : undefined
}

const isPhase = (value: unknown): value is RunPhase =>
  typeof value === 'string' && (RUN_PHASES as readonly string[]).includes(value)

const isStatus = (value: unknown): value is RunStatus =>
  typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value)

/** One bounded document, or undefined when it has no name. */
function sanitizeDoc(input: unknown): RunLedgerDoc | undefined {
  if (!isRecord(input)) return undefined
  const name = cap(input.name, MAX_NAME_CHARS)
  if (!name) return undefined
  const doc: RunLedgerDoc = { name, loci: capList(input.loci, MAX_LOCI_PER_DOC, MAX_LOCUS_CHARS) }
  const title = cap(input.title, MAX_TITLE_CHARS)
  if (title !== undefined) doc.title = title
  const shelf = cap(input.shelf, MAX_SHELF_CHARS)
  if (shelf !== undefined) doc.shelf = shelf
  // Copied, not derived: "did an earlier step already reach this" is a fact
  // about every earlier step, which this payload does not carry. A boolean is
  // self-bounding, and the worst a tampered one can do is mute or unmute one
  // pill.
  if (typeof input.repeat === 'boolean') doc.repeat = input.repeat
  return doc
}

/**
 * One bounded step, or undefined.
 *
 * A step with no id, no known phase, no intent or no start is dropped and the
 * rest of the run's account survives it: an unplaceable step is corrupt, and one
 * bad step must not blank the whole ledger. The intent is required because a
 * step without one is precisely the thing this ledger exists to avoid — a row
 * the reader cannot read.
 */
function sanitizeStep(input: unknown): RunStep | undefined {
  if (!isRecord(input)) return undefined
  const id = cap(input.id, MAX_STEP_ID_CHARS)
  const intent = cap(input.intent, MAX_INTENT_CHARS)
  const startedAt = instant(input.startedAt)
  if (!id || !intent || !startedAt || !isPhase(input.phase)) return undefined

  const docs: RunLedgerDoc[] = []
  if (Array.isArray(input.docs)) {
    for (const raw of input.docs) {
      if (docs.length >= MAX_DOCS_PER_STEP) break
      const doc = sanitizeDoc(raw)
      if (doc) docs.push(doc)
    }
  }
  const step: RunStep = { id, phase: input.phase, intent, startedAt, docs }
  const openPoints = capList(input.openPoints, MAX_OPEN_POINTS, MAX_OPEN_POINT_CHARS)
  if (openPoints.length > 0) step.openPoints = openPoints
  return step
}

/**
 * The phases, at most one entry per key.
 *
 * Deduplicated by key rather than truncated by count: a phase is entered once,
 * and a payload naming `recherchieren` five times is a replaying fold or a
 * tampered blob, not five phases. The first entry wins, so a later copy cannot
 * rewrite when a phase began.
 */
function sanitizePhases(input: unknown): RunPhaseEntry[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<RunPhase>()
  const entries: RunPhaseEntry[] = []
  for (const raw of input) {
    if (!isRecord(raw) || !isPhase(raw.phase) || seen.has(raw.phase)) continue
    const startedAt = instant(raw.startedAt)
    if (!startedAt) continue
    seen.add(raw.phase)
    const entry: RunPhaseEntry = { phase: raw.phase, startedAt }
    const endedAt = instant(raw.endedAt)
    if (endedAt !== undefined) entry.endedAt = endedAt
    entries.push(entry)
  }
  return entries
}

/** The terminal result, or undefined when it does not say when it was filed. */
function sanitizeResult(input: unknown): RunResult | undefined {
  if (!isRecord(input)) return undefined
  const filedAt = instant(input.filedAt)
  if (!filedAt) return undefined
  const result: RunResult = { filedAt }
  const fileId = cap(input.fileId, MAX_REFERENCE_ID_CHARS)
  if (fileId !== undefined) result.fileId = fileId
  const reportMessageId = cap(input.reportMessageId, MAX_REFERENCE_ID_CHARS)
  if (reportMessageId !== undefined) result.reportMessageId = reportMessageId
  return result
}

/**
 * The terminal error, or undefined when it gives no reason.
 *
 * `completedBefore` is filtered against the phases that ACTUALLY ended in this
 * same ledger — the claim is checkable here, so it is checked rather than
 * trusted, exactly as the retrieval ledger derives its tallies from its own
 * bounded docs.
 */
function sanitizeError(input: unknown, phases: readonly RunPhaseEntry[]): RunError | undefined {
  if (!isRecord(input)) return undefined
  const reason = cap(input.reason, MAX_ERROR_REASON_CHARS)
  if (!reason) return undefined
  const ended = new Set(phases.filter((entry) => entry.endedAt).map((entry) => entry.phase))
  const claimed = Array.isArray(input.completedBefore) ? input.completedBefore : []
  const completedBefore: RunPhase[] = []
  for (const value of claimed) {
    if (isPhase(value) && ended.has(value) && !completedBefore.includes(value)) {
      completedBefore.push(value)
    }
  }
  return { reason, completedBefore }
}

/**
 * The status a ledger is in when it does not name a known one.
 *
 * Derived, never defaulted to a constant: a ledger with a result that rendered
 * as „angelegt" would be a lie the reader has no way to check, and a status is
 * the one field a tampered payload would most want to choose.
 */
function deriveStatus(ledger: {
  error?: RunError
  result?: RunResult
  steps: readonly RunStep[]
  phases: readonly RunPhaseEntry[]
}): RunStatus {
  if (ledger.error) return 'fehlgeschlagen'
  if (ledger.result) return 'fertig'
  return ledger.steps.length > 0 || ledger.phases.length > 0 ? 'laeuft' : 'angelegt'
}

/**
 * The instant a ledger started, from the first source that gives one.
 *
 * `startedAt` is not optional in the type, and fabricating "now" for a stored
 * row would date a week-old run to the moment somebody opened it. So the fall
 * back is to another instant the ledger itself carries, and a ledger with no
 * instant anywhere is corrupt rather than guessable.
 */
function resolveStartedAt(
  raw: Record<string, unknown>,
  phases: readonly RunPhaseEntry[],
  steps: readonly RunStep[],
): string | undefined {
  return (
    instant(raw.startedAt) ??
    instant(raw.updatedAt) ??
    phases[0]?.startedAt ??
    steps[0]?.startedAt ??
    instant(raw.finishedAt)
  )
}

/**
 * Reduce an untrusted `run_ledger` payload to a bounded one, or null when
 * nothing survives.
 *
 * A run with no steps is KEPT: „angelegt, noch nichts passiert" is exactly the
 * state the reader most needs to see. Null means the payload did not identify a
 * run at all — no id, or no instant anywhere — which is corruption, not a state.
 */
export function sanitizeRunLedger(input: unknown): RunLedger | null {
  if (!isRecord(input)) return null
  const runId = cap(input.runId, MAX_RUN_ID_CHARS)
  if (!runId) return null

  const phases = sanitizePhases(input.phases)
  const steps: RunStep[] = []
  if (Array.isArray(input.steps)) {
    for (const raw of input.steps) {
      if (steps.length >= MAX_STEPS) break
      const step = sanitizeStep(raw)
      if (step) steps.push(step)
    }
  }
  const startedAt = resolveStartedAt(input, phases, steps)
  if (!startedAt) return null

  const result = sanitizeResult(input.result)
  const error = sanitizeError(input.error, phases)
  const ledger: RunLedger = {
    runId,
    status: isStatus(input.status) ? input.status : deriveStatus({ error, result, steps, phases }),
    phases,
    steps,
    startedAt,
    updatedAt: instant(input.updatedAt) ?? startedAt,
  }
  if (result) ledger.result = result
  if (error) ledger.error = error
  const finishedAt = instant(input.finishedAt)
  if (finishedAt !== undefined) ledger.finishedAt = finishedAt
  return ledger
}

/**
 * The run's title, as `metadata.run_title` may carry it, or undefined.
 *
 * One line: whitespace runs (a newline in a task goal, a tab from a paste)
 * collapse to one space, control characters are dropped, and the result is cut
 * to {@link MAX_RUN_TITLE_CHARS}. Applied on write (`createRunMessage`) and on
 * read (`server-message-mapper`), like the ledger beside it.
 */
export function sanitizeRunTitle(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  // eslint-disable-next-line no-control-regex -- dropping them is the point
  const oneLine = input.replace(/[ -]+/g, ' ').replace(/\s+/g, ' ').trim()
  return oneLine.length > 0 ? oneLine.slice(0, MAX_RUN_TITLE_CHARS) : undefined
}

/** The ledger of a run that has just been submitted and has done nothing yet. */
export function emptyRunLedger(runId: string, at: Date = new Date()): RunLedger {
  const startedAt = at.toISOString()
  return {
    runId: runId.trim().slice(0, MAX_RUN_ID_CHARS),
    status: 'angelegt',
    phases: [],
    steps: [],
    startedAt,
    updatedAt: startedAt,
  }
}

/**
 * Re-sanitise a ledger a move just built.
 *
 * The fallback is total rather than decorative: a move only ever makes a valid
 * ledger more complete, so `null` here would mean this file contradicts itself,
 * and returning the input keeps a caller's ledger rather than losing a run's
 * whole account to a bug in a move.
 */
function settled(next: RunLedger, previous: RunLedger): RunLedger {
  return sanitizeRunLedger(next) ?? previous
}

/**
 * Append one step.
 *
 * A run that has taken a step is running, so a ledger still „angelegt" moves to
 * „läuft" — the two facts are one fact and letting them disagree is how a run
 * shows as not-yet-started while its steps scroll past. A step past
 * {@link MAX_STEPS} is dropped by the sanitiser, keeping the FIRST fifty: the
 * beginning of a run is what explains it, and an unbounded list is what this
 * file exists to refuse.
 */
export function appendStep(ledger: RunLedger, step: RunStep, at: Date = new Date()): RunLedger {
  return settled(
    {
      ...ledger,
      status: ledger.status === 'angelegt' ? 'laeuft' : ledger.status,
      steps: [...ledger.steps, step],
      updatedAt: at.toISOString(),
    },
    ledger,
  )
}

/**
 * Enter a phase.
 *
 * Entering one that is already on the ledger changes nothing: a phase begins
 * once, and a fold that replays its events must not be able to rewrite when.
 */
export function openPhase(ledger: RunLedger, phase: RunPhase, at: Date = new Date()): RunLedger {
  if (ledger.phases.some((entry) => entry.phase === phase)) return ledger
  const now = at.toISOString()
  return settled(
    {
      ...ledger,
      status: ledger.status === 'angelegt' ? 'laeuft' : ledger.status,
      phases: [...ledger.phases, { phase, startedAt: now }],
      updatedAt: now,
    },
    ledger,
  )
}

/**
 * Leave a phase.
 *
 * A phase that was never entered, or that already ended, is left alone — the
 * end of a phase is a fact recorded once, and a second `closePhase` is a replay.
 */
export function closePhase(ledger: RunLedger, phase: RunPhase, at: Date = new Date()): RunLedger {
  const target = ledger.phases.find((entry) => entry.phase === phase)
  if (!target || target.endedAt) return ledger
  const now = at.toISOString()
  return settled(
    {
      ...ledger,
      phases: ledger.phases.map((entry) =>
        entry.phase === phase ? { ...entry, endedAt: now } : entry,
      ),
      updatedAt: now,
    },
    ledger,
  )
}

/** Set the display status — the one field a live stream can move on its own. */
export function setRunStatus(ledger: RunLedger, status: RunStatus, at: Date = new Date()): RunLedger {
  if (ledger.status === status) return ledger
  return settled({ ...ledger, status, updatedAt: at.toISOString() }, ledger)
}

/**
 * The run finished, with something to show for it.
 *
 * Every open phase is closed at the same instant: the run is over, so a phase
 * left open would render as still running forever.
 */
export function finishRun(ledger: RunLedger, result: RunResult, at: Date = new Date()): RunLedger {
  const now = at.toISOString()
  return settled(
    {
      ...ledger,
      status: 'fertig',
      phases: ledger.phases.map((entry) => (entry.endedAt ? entry : { ...entry, endedAt: now })),
      result,
      updatedAt: now,
      finishedAt: now,
    },
    ledger,
  )
}

/**
 * The run stopped without one.
 *
 * Open phases are deliberately NOT closed: the phase the run died in did not
 * complete, and saying it did is the difference between „beim Prüfen
 * gescheitert" and a ledger that claims the check was done. `completedBefore` is
 * derived from the phases that genuinely ended, in the order they ended.
 */
export function failRun(ledger: RunLedger, reason: string, at: Date = new Date()): RunLedger {
  const now = at.toISOString()
  return settled(
    {
      ...ledger,
      status: 'fehlgeschlagen',
      error: {
        reason,
        completedBefore: ledger.phases.filter((entry) => entry.endedAt).map((entry) => entry.phase),
      },
      updatedAt: now,
      finishedAt: now,
    },
    ledger,
  )
}

/**
 * Apply an `append` op: the phases it opened or closed, the steps it took, the
 * status it believes the run is in.
 *
 * Phases first, so a step naming a phase arrives after that phase is on the
 * ledger; status last, so an explicit one wins over the „läuft" a step implies.
 */
export function applyRunLedgerAppend(
  ledger: RunLedger,
  patch: {
    phases?: readonly RunPhaseEntry[]
    steps?: readonly RunStep[]
    status?: RunStatus
  },
  at: Date = new Date(),
): RunLedger {
  let next = ledger
  for (const entry of patch.phases ?? []) {
    next = openPhase(next, entry.phase, new Date(entry.startedAt))
    if (entry.endedAt) next = closePhase(next, entry.phase, new Date(entry.endedAt))
  }
  for (const step of patch.steps ?? []) next = appendStep(next, step, at)
  return patch.status ? setRunStatus(next, patch.status, at) : next
}

/** Apply a `finish` op: exactly one of a result or an error. */
export function applyRunLedgerFinish(
  ledger: RunLedger,
  outcome: { result: RunResult } | { error: { reason: string } },
  at: Date = new Date(),
): RunLedger {
  return 'result' in outcome
    ? finishRun(ledger, outcome.result, at)
    : failRun(ledger, outcome.error.reason, at)
}
