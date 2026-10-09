/**
 * An answer's provenance, made durable (ADR-0037).
 *
 * The Herleitung, the confidence self-assessment and the routing transparency were
 * **browser-local**. Only seven fields ever reached the server with a message —
 * `errorData`, `fileData`, `cards`, `cardInteractions`, `enabledDataSources`,
 * `messageFiles` and (since the citations fix) `citations`. Everything that
 * explains HOW an answer was reached lived in the tab that produced it.
 *
 * That has two consequences, and in a building-regulation product the provenance
 * is not decoration — it is most of the value:
 *
 *   1. **A colleague sees a bare answer.** An observer holds no agent socket by
 *      design (ADR-0033 §7), so they never receive the intermediate frames, and
 *      the server row they load instead never carried them. Anna reads "1,20 m"
 *      with nothing to say what it rests on.
 *   2. **The asker loses it too**, on any other device, after a storage prune, or
 *      in any browser that was not the one that asked. This one predates sharing.
 *
 * The fix is the same one the citations fix already made, extended: keep the
 * COMPACT form on the message row. For the Herleitung that is {@link StoredThinkingStep}:
 * the typed step the turn fold writes (chat wire v2), which carries no tool
 * input or output, so the server keeps exactly what localStorage keeps, and the
 * two cannot disagree about what a restored thread looks like.
 *
 * **The client is not trusted with the bound.** `sanitizeProvenance` is what runs
 * before anything reaches the jsonb column: unknown keys are dropped, unions are
 * checked, strings are capped and the step list is truncated. A jsonb column with
 * a client-supplied array in it is otherwise an unbounded write.
 */

import type { SourceSignal } from '@/features/layout/lib/source-presets'
import type { Shelf, SourceKind } from '@/features/chat/lib/source-kinds'
import type { RetrievalLedger } from './message-retrieval-ledger'
import { sanitizeRetrievalLedger } from './message-retrieval-ledger'
import { sanitizeQuoteStamps, type QuoteStamp } from './message-quote-stamps'
import { isChatEffort, type ChatEffort } from '@/lib/reasoning-settings/catalog'

/** The kinds of Herleitung step, one per wire v2 `Step` (`wire_v2.py`). */
export const STEP_KINDS = [
  'status',
  'retrieval',
  'sources',
  'tool',
  'skill',
  'clarification',
] as const
export type StepKind = (typeof STEP_KINDS)[number]

/**
 * What a step may say on the live line and the Herleitung spine: the key, its
 * values (what was searched, in which corpus), the model's own `reason` (its
 * checkpoint sentence, attributed and never interpolated), and the `tools`
 * that round called. Bounded on write, because the values are a
 * client-supplied record.
 */
export interface StoredTurnEvent {
  key: string
  values?: Record<string, string>
  reason?: string
  tools?: string[]
}

/** One document hit inside a lane of a `sources` step. */
export interface TraceSourceHit {
  /** Raw document identity (corpus filename, hostname): what dedupes. */
  name: string
  /** The backend's human title; absent, `documentShortName` derives one from `name`. */
  title?: string
  detail?: string
  /** The shelf the hit was read from (ADR-0047). */
  shelf?: Shelf
  /** The retrieval round that returned it. */
  round?: number
}

/**
 * One lane of a search's fan-out, as a `sources` step stores it: the wire's
 * `TraceLane`, renamed to the stored field names and tinted once, when the
 * fold takes the step (docs/design/chat-wire-v2.md §e.1).
 */
export interface TraceLaneCard {
  key: string
  label: string
  hitCount: number
  sources: TraceSourceHit[]
  /** Canonical coarse source kind (ADR-0026), as the backend classified it. */
  kind?: SourceKind
  /** Provenance signal for the --source-* tint. */
  signal: SourceSignal
}

/**
 * The compact stored form of one Herleitung step: exactly what the turn fold
 * writes (docs/design/chat-wire-v2.md §e.4), and the ONLY shape this column
 * holds. Rows written before the wire v2 cut were rewritten by migration 0097;
 * nothing here reads the older `functionName` shape.
 *
 * Which fields a step carries follows its `kind`: `retrieval` has `round` and
 * the `turnEvent`, `status` its `slot` (and the `turnEvent` when it speaks),
 * `sources` its `tool` and `traceLanes`, `tool` its `tool`, `skill` its
 * `skill`. No step carries a tool's input or output.
 */
export interface StoredThinkingStep {
  id: string
  userMessageId: string
  timestamp: string
  isComplete: boolean
  kind: StepKind
  /** Set only for in-process deep research; a chat step stores no key. */
  scope?: 'deep'
  turnEvent?: StoredTurnEvent
  /** The sources fan-out, which is the part of a step a reader actually reads. */
  traceLanes?: TraceLaneCard[]
  round?: number
  /** A tool's basename (`tool`, `sources`). */
  tool?: string
  /** The skill's name (`skill`). */
  skill?: string
  /** The status slot (`status`), e.g. `synthesis`, `checkpoint:0`. */
  slot?: string
  /** Structured detail of a technical status record: scalars and short string lists. */
  detail?: Record<string, StepDetailValue>
}

export type StepDetailValue = string | number | boolean | string[]

/**
 * Why the deterministic overconfidence guard downgraded the model's own
 * self-assessment. Five causes, two of them about the SECOND kind of grounding:
 * an IFC measurement carries a provenance, a tolerance, a readable method and
 * the GlobalIds it came from, but has no passage to quote — so it can never
 * satisfy the citation gate.
 *
 * - `ungrounded`              nothing verified and nothing measured.
 * - `quote_unverified`        a quoted span matched no source passage.
 * - `normative_claim_uncited` the answer WAS measurement-grounded but also
 *   asserts something normative with no verified citation, so it is held at
 *   'low' rather than riding out on the measurement's evidence.
 * - `measurement_only`        measured and purely descriptive, so 'high' was
 *   reduced to 'medium' (measurement grounding never reaches 'high').
 * - `citation_fallback`       nothing the model cited survived verification, so
 *   the agent attached the one source in the session registry — real, but not a
 *   citation the answer made, and possibly captured on an earlier turn. It
 *   lifts the answer no further than a measurement does.
 *
 * Exported so the chip, the stored provenance and the wire mapper share one
 * list instead of three copies that can drift apart.
 */
export type AnswerConfidenceCappedReason = (typeof CAPPED_REASONS)[number]

/**
 * WHY a deep-research run stopped before it was finished, as the backend's own
 * stable token (`deep_researcher/models/state.py`):
 *
 * - `wall_clock` the run reached its time budget.
 * - `step_limit`  the orchestrator reached its step ceiling.
 *
 * The token is never shown; the frontend owns the words (see the `answerSources`
 * dictionary group). Allow-listed here for the same reason `CAPPED_REASONS` is:
 * this is read back out of a jsonb column that a newer backend may have written,
 * and a token this build has no sentence for must not reach a renderer.
 */
export type TruncationReason = (typeof TRUNCATION_REASONS)[number]

/**
 * Ways a salvaged answer is weaker than one from a clean run — again stable
 * tokens, again never shown raw:
 *
 * - `no_report_file`     the run produced no persisted report; the answer in the
 *   thread is the only copy.
 * - `no_valid_citations` nothing the answer cited survived verification.
 * - `cards_generation_failed` the report is whole, but the proposals a job
 *   derives from it afterwards could not be produced.
 * - `grundlage_unread` a document the reader named as Grundlage was never
 *   read; the report names which at its end.
 *
 * An EMPTY list is not a claim of "degraded in zero ways" — it is the ordinary
 * case, and it is stored as no key at all.
 */
export type AnswerDegradedReason = (typeof ANSWER_DEGRADED_REASONS)[number]

export interface MessageProvenance {
  thinkingSteps?: StoredThinkingStep[]
  answerConfidence?: 'low' | 'medium' | 'high'
  answerConfidenceCappedReason?: AnswerConfidenceCappedReason
  answerConfidenceReason?: string
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  escalationReason?: string
  /** How long the answer took, in whole milliseconds, as the asking browser measured it. */
  answerDurationMs?: number
  /**
   * The Aufwand the turn ran at, as the asking browser sent it. Stored so the
   * thorough retry steps up from this answer's level on any device, not from
   * wherever the reader's dial stands now.
   */
  reasoningEffort?: ChatEffort
  /**
   * The skills the turn activated, and the subset the disclosure de-emphasises.
   * Stored because the disclosure calls itself the RECORD of what shaped the
   * answer, and a record that vanished on reload was not one.
   */
  skillsActivated?: string[]
  skillsHidden?: string[]
  citationsRemoved?: { count: number; reasons: string[] }
  /**
   * The turn's research was cut off at its budget ceiling. Stored, because a
   * reloaded conversation that quietly dropped it would show a truncated
   * answer as a complete one — the record has to keep saying what the live
   * answer said.
   */
  researchTruncated?: true
  /**
   * The asker pressed Stop: the answer is the prose the turn had produced by
   * then (`RUN_FINISHED{outcome: 'cancelled'}`, persisted by the agent tier).
   * Stored so a reload shows what the reader saw, marked as stopped, rather
   * than a fragment that reads as a finished answer.
   */
  stopped?: true
  /**
   * Why it was cut off. Stored beside the flag rather than folded into it: the
   * flag is what the reader is told, the reason is what turns "it stopped" into
   * "it ran out of time", and a reopened thread that kept only the first half
   * would show less than the live turn did.
   */
  truncationReason?: TruncationReason
  /**
   * How the salvaged answer is weaker than a clean one. A list because a run
   * can degrade in more than one way at once, and absent — never `[]` — when it
   * degraded in none.
   */
  degradedReasons?: AnswerDegradedReason[]
  /**
   * The deep-research job, so a colleague can fetch the report rather than be
   * handed a copy of it. The POINTER is small and the report is large and already
   * has a retrieval path; storing the payload here would put a document in a
   * message row.
   */
  deepResearchJobId?: string
  /**
   * The backend's own account of this turn's retrieval rounds. Stored beside
   * the thinking steps because it IS Herleitung data — the compact form the
   * server keeps must equal what localStorage keeps, or two restores of one
   * thread disagree about what a restored thread looks like.
   */
  retrievalLedger?: RetrievalLedger
  /**
   * The server's check of each quote line (`message-quote-stamps.ts`). Stored
   * so a reload still says „Wortlaut belegt [N]" where the live answer did.
   */
  quoteStamps?: QuoteStamp[]
}

/** One answer's Herleitung is tens of steps; a thousand is a runaway client. */
const MAX_THINKING_STEPS = 200
/** Reasons are one sentence. */
const MAX_REASON_CHARS = 600
/** `citationsRemoved.reasons` is a short list of short codes. */
const MAX_REMOVED_REASONS = 20
const MAX_REMOVED_REASON_CHARS = 120
/** A deep-research turn can run for hours; a week is a broken clock, not an answer. */
const MAX_ANSWER_DURATION_MS = 7 * 24 * 60 * 60 * 1000
/** Skill names are short slugs; a turn activates a handful. */
const MAX_SKILLS = 20
const MAX_SKILL_CHARS = 80
const MAX_TRACE_LANES = 40
/** A turn event is one dotted key and a few short interpolation values. */
const MAX_TURN_EVENT_KEY_CHARS = 64
const MAX_TURN_EVENT_VALUES = 8
const MAX_TURN_EVENT_VALUE_KEY_CHARS = 32
const MAX_TURN_EVENT_VALUE_CHARS = 64
/** A tool basename; the wire bounds a step id at 200. */
const MAX_NAME_CHARS = 200
/** A technical record's detail is a handful of counts and reasons. */
const MAX_DETAIL_ENTRIES = 16
const MAX_DETAIL_VALUE_CHARS = 200

const CONFIDENCES = ['low', 'medium', 'high'] as const
export const CAPPED_REASONS = [
  'ungrounded',
  'quote_unverified',
  'normative_claim_uncited',
  'measurement_only',
  'citation_fallback',
] as const
const ROUTING_DECISIONS = ['meta', 'shallow', 'deep', 'error'] as const
/** The cutoff causes the deep researcher records. See {@link TruncationReason}. */
export const TRUNCATION_REASONS = [
  'wall_clock',
  'step_limit',
  'upstream_timeout',
  'user_requested',
] as const
/** The degradations it records. See {@link AnswerDegradedReason}. */
export const ANSWER_DEGRADED_REASONS = [
  'no_report_file',
  'no_valid_citations',
  'cards_generation_failed',
  'grundlage_unread',
] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cap = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined

/** A bounded list of bounded strings, or undefined when nothing survives. */
const stringList = (value: unknown, maxItems: number, maxChars: number): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const items = value
    .slice(0, maxItems)
    .map((item) => cap(item, maxChars))
    .filter((item): item is string => item !== undefined)
  return items.length > 0 ? items : undefined
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined

const isStepKind = (value: unknown): value is StepKind =>
  typeof value === 'string' && (STEP_KINDS as readonly string[]).includes(value)

const nonNegativeInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined

/** A technical record's detail: bounded keys, scalars and short string lists only. */
function sanitizeDetail(input: unknown): Record<string, StepDetailValue> | undefined {
  if (!isRecord(input)) return undefined
  const detail: Record<string, StepDetailValue> = {}
  for (const [name, value] of Object.entries(input).slice(0, MAX_DETAIL_ENTRIES)) {
    const safeName = cap(name, MAX_TURN_EVENT_VALUE_KEY_CHARS)
    if (!safeName) continue
    if (typeof value === 'boolean') detail[safeName] = value
    else if (typeof value === 'number' && Number.isFinite(value)) detail[safeName] = value
    else if (typeof value === 'string') detail[safeName] = value.slice(0, MAX_DETAIL_VALUE_CHARS)
    else {
      const list = stringList(value, MAX_TURN_EVENT_VALUES, MAX_TURN_EVENT_VALUE_CHARS)
      if (list) detail[safeName] = list
    }
  }
  return Object.keys(detail).length > 0 ? detail : undefined
}

/** A lane with the fields every reader dereferences; its hits are bounded by the lane cap above. */
const isTraceLane = (value: unknown): value is TraceLaneCard =>
  isRecord(value) &&
  typeof value.key === 'string' &&
  typeof value.label === 'string' &&
  typeof value.signal === 'string' &&
  typeof value.hitCount === 'number' &&
  Array.isArray(value.sources)

/**
 * One step, or null. A step without a known `kind` is not a step: this is the
 * v2 shape only, and an older shape reaching this function is a writer bug,
 * not something to interpret.
 */
function sanitizeStep(input: unknown): StoredThinkingStep | null {
  if (!isRecord(input) || !isStepKind(input.kind)) return null
  const id = cap(input.id, 128)
  const userMessageId = cap(input.userMessageId, 128)
  if (!id || !userMessageId) return null

  const step: StoredThinkingStep = {
    id,
    userMessageId,
    // Accepts the ISO string the client sends AND a Date that survived a
    // structured clone, because JSON turns Dates into strings at exactly one
    // boundary that is easy to get wrong.
    timestamp:
      cap(input.timestamp, 40) ??
      (input.timestamp instanceof Date ? input.timestamp.toISOString() : ''),
    isComplete: input.isComplete === true,
    kind: input.kind,
  }
  if (input.scope === 'deep') step.scope = 'deep'
  const { turnEvent } = sanitizeTurnEvent(input.turnEvent)
  if (turnEvent) step.turnEvent = turnEvent
  const traceLanes = Array.isArray(input.traceLanes)
    ? input.traceLanes.slice(0, MAX_TRACE_LANES).filter(isTraceLane)
    : []
  if (traceLanes.length > 0) step.traceLanes = traceLanes
  const round = nonNegativeInt(input.round)
  if (round !== undefined) step.round = round
  const tool = cap(input.tool, MAX_NAME_CHARS)
  if (tool) step.tool = tool
  const skill = cap(input.skill, MAX_SKILL_CHARS)
  if (skill) step.skill = skill
  const slot = cap(input.slot, MAX_TURN_EVENT_KEY_CHARS)
  if (slot) step.slot = slot
  const detail = sanitizeDetail(input.detail)
  if (detail) step.detail = detail
  return step
}

/**
 * Bound an untrusted step list: the v2 shape only, at most
 * {@link MAX_THINKING_STEPS}, every field capped. Exported for the history
 * mapper, which reads the same column back and must agree with the write.
 */
export function sanitizeThinkingSteps(input: unknown): StoredThinkingStep[] | undefined {
  if (!Array.isArray(input)) return undefined
  const steps = input
    .slice(0, MAX_THINKING_STEPS)
    .map(sanitizeStep)
    .filter((step): step is StoredThinkingStep => step !== null)
  return steps.length > 0 ? steps : undefined
}

/** The hoisted turn event, whitelisted and capped like everything else here. */
function sanitizeTurnEvent(input: unknown): { turnEvent?: StoredThinkingStep['turnEvent'] } {
  if (!isRecord(input)) return {}
  const key = cap(input.key, MAX_TURN_EVENT_KEY_CHARS)
  if (!key) return {}
  const values: Record<string, string> = {}
  if (isRecord(input.values)) {
    for (const [name, value] of Object.entries(input.values).slice(0, MAX_TURN_EVENT_VALUES)) {
      const safeName = cap(name, MAX_TURN_EVENT_VALUE_KEY_CHARS)
      const safeValue = cap(value, MAX_TURN_EVENT_VALUE_CHARS)
      if (safeName && safeValue !== undefined) values[safeName] = safeValue
    }
  }
  const reason = cap(input.reason, MAX_REASON_CHARS)
  const event: NonNullable<StoredThinkingStep['turnEvent']> = { key }
  if (Object.keys(values).length > 0) event.values = values
  if (reason) event.reason = reason
  if (Array.isArray(input.tools)) {
    const tools = input.tools
      .slice(0, MAX_TURN_EVENT_VALUES)
      .map((name) => cap(name, MAX_TURN_EVENT_VALUE_CHARS))
      .filter((name): name is string => Boolean(name))
    if (tools.length > 0) event.tools = tools
  }
  return { turnEvent: event }
}

/**
 * Reduce an untrusted payload to a bounded, well-typed provenance record.
 *
 * Returns null when nothing survives, so a caller can skip the write entirely
 * rather than stamping an empty object onto a message.
 */
export function sanitizeProvenance(input: unknown): MessageProvenance | null {
  if (!isRecord(input)) return null
  const out: MessageProvenance = {}

  const steps = sanitizeThinkingSteps(input.thinkingSteps)
  if (steps) out.thinkingSteps = steps

  const confidence = oneOf(input.answerConfidence, CONFIDENCES)
  if (confidence) out.answerConfidence = confidence

  const cappedReason = oneOf(input.answerConfidenceCappedReason, CAPPED_REASONS)
  if (cappedReason) out.answerConfidenceCappedReason = cappedReason

  const confidenceReason = cap(input.answerConfidenceReason, MAX_REASON_CHARS)
  if (confidenceReason) out.answerConfidenceReason = confidenceReason

  const routing = oneOf(input.routingDecision, ROUTING_DECISIONS)
  if (routing) out.routingDecision = routing

  const escalationReason = cap(input.escalationReason, MAX_REASON_CHARS)
  if (escalationReason) out.escalationReason = escalationReason

  if (
    typeof input.answerDurationMs === 'number' &&
    Number.isFinite(input.answerDurationMs) &&
    input.answerDurationMs > 0 &&
    input.answerDurationMs <= MAX_ANSWER_DURATION_MS
  ) {
    out.answerDurationMs = Math.round(input.answerDurationMs)
  }

  if (isChatEffort(input.reasoningEffort)) out.reasoningEffort = input.reasoningEffort

  const skillsActivated = stringList(input.skillsActivated, MAX_SKILLS, MAX_SKILL_CHARS)
  if (skillsActivated) out.skillsActivated = skillsActivated
  const skillsHidden = stringList(input.skillsHidden, MAX_SKILLS, MAX_SKILL_CHARS)
  if (skillsHidden) out.skillsHidden = skillsHidden

  if (isRecord(input.citationsRemoved) && typeof input.citationsRemoved.count === 'number') {
    const reasons = Array.isArray(input.citationsRemoved.reasons)
      ? input.citationsRemoved.reasons
          .slice(0, MAX_REMOVED_REASONS)
          .map((reason) => cap(reason, MAX_REMOVED_REASON_CHARS))
          .filter((reason): reason is string => reason !== undefined)
      : []
    out.citationsRemoved = {
      // Coerced, not trusted: this number is rendered as a count.
      count: Math.max(0, Math.trunc(input.citationsRemoved.count)),
      reasons,
    }
  }

  // `=== true`, not truthiness: this comes off untrusted stored JSON, and the
  // field is a fact the reader is shown. A stray "yes" must not become one.
  if (input.researchTruncated === true) out.researchTruncated = true
  if (input.stopped === true) out.stopped = true

  // The reason survives on its own, without the flag: a row that recorded WHY
  // the run stopped but lost the boolean still knows something true, and the
  // backend reads the two independently for exactly that reason
  // (`jobs/runner._extract_answer_transparency`).
  const truncationReason = oneOf(input.truncationReason, TRUNCATION_REASONS)
  if (truncationReason) out.truncationReason = truncationReason

  if (Array.isArray(input.degradedReasons)) {
    // De-duplicated: two tokens that say the same thing would put the same
    // sentence under the answer twice. An empty result stores no key — the
    // ordinary case is "not degraded", and `[]` would read as a claim about it.
    const reasons = [
      ...new Set(
        input.degradedReasons
          .map((reason) => oneOf(reason, ANSWER_DEGRADED_REASONS))
          .filter((reason): reason is AnswerDegradedReason => reason !== undefined)
      ),
    ]
    if (reasons.length > 0) out.degradedReasons = reasons
  }

  const jobId = cap(input.deepResearchJobId, 128)
  if (jobId) out.deepResearchJobId = jobId

  // Re-bounded on write like everything else here, through the same sanitizer
  // the wire boundary uses: one bound in one place instead of two that drift.
  const ledger = sanitizeRetrievalLedger(input.retrievalLedger)
  if (ledger) out.retrievalLedger = ledger

  const stamps = sanitizeQuoteStamps(input.quoteStamps)
  if (stamps) out.quoteStamps = stamps

  return Object.keys(out).length > 0 ? out : null
}
