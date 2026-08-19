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
 * COMPACT form on the message row. `stripThinkingStepsForStorage` already defines
 * what "compact" means for the Herleitung — display fields plus the trace lanes,
 * with payloads dropped, which is precisely what `ChatThinking` renders — so the
 * server keeps exactly what localStorage keeps, and the two cannot disagree about
 * what a restored thread looks like.
 *
 * **The client is not trusted with the bound.** `sanitizeProvenance` is what runs
 * before anything reaches the jsonb column: unknown keys are dropped, unions are
 * checked, strings are capped and the step list is truncated. A jsonb column with
 * a client-supplied array in it is otherwise an unbounded write.
 */

/** The compact stored form of one Herleitung step. */
export interface StoredThinkingStep {
  id: string
  userMessageId: string
  functionName: string
  displayName: string
  category: string
  timestamp: string
  isComplete: boolean
  isTopLevel?: boolean
  /** The sources fan-out, which is the part of a step a reader actually reads. */
  traceLanes?: unknown[]
}

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
  routingReason?: string
  escalationReason?: string
  citationsRemoved?: { count: number; reasons: string[] }
  /**
   * The turn's research was cut off at its budget ceiling. Stored, because a
   * reloaded conversation that quietly dropped it would show a truncated
   * answer as a complete one — the record has to keep saying what the live
   * answer said.
   */
  researchTruncated?: true
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
  showViewReport?: boolean
}

/** One answer's Herleitung is tens of steps; a thousand is a runaway client. */
const MAX_THINKING_STEPS = 200
/** Reasons are one sentence. */
const MAX_REASON_CHARS = 600
/** `citationsRemoved.reasons` is a short list of short codes. */
const MAX_REMOVED_REASONS = 20
const MAX_REMOVED_REASON_CHARS = 120
const MAX_TRACE_LANES = 40

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
export const TRUNCATION_REASONS = ['wall_clock', 'step_limit'] as const
/** The degradations it records. See {@link AnswerDegradedReason}. */
export const ANSWER_DEGRADED_REASONS = ['no_report_file', 'no_valid_citations'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cap = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined

function sanitizeStep(input: unknown): StoredThinkingStep | null {
  if (!isRecord(input)) return null
  const id = cap(input.id, 128)
  const userMessageId = cap(input.userMessageId, 128)
  if (!id || !userMessageId) return null

  return {
    id,
    userMessageId,
    functionName: cap(input.functionName, 200) ?? '',
    displayName: cap(input.displayName, 200) ?? '',
    category: cap(input.category, 40) ?? '',
    // Accepts the ISO string the client sends AND a Date that survived a
    // structured clone, because the store holds Dates and JSON turns them into
    // strings at exactly one boundary that is easy to get wrong.
    timestamp:
      cap(input.timestamp, 40) ??
      (input.timestamp instanceof Date ? input.timestamp.toISOString() : ''),
    isComplete: input.isComplete === true,
    ...(input.isTopLevel === true ? { isTopLevel: true } : {}),
    ...(Array.isArray(input.traceLanes) && input.traceLanes.length > 0
      ? { traceLanes: input.traceLanes.slice(0, MAX_TRACE_LANES) }
      : {}),
  }
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

  if (Array.isArray(input.thinkingSteps)) {
    const steps = input.thinkingSteps
      .slice(0, MAX_THINKING_STEPS)
      .map(sanitizeStep)
      .filter((step): step is StoredThinkingStep => step !== null)
    if (steps.length > 0) out.thinkingSteps = steps
  }

  const confidence = oneOf(input.answerConfidence, CONFIDENCES)
  if (confidence) out.answerConfidence = confidence

  const cappedReason = oneOf(input.answerConfidenceCappedReason, CAPPED_REASONS)
  if (cappedReason) out.answerConfidenceCappedReason = cappedReason

  const confidenceReason = cap(input.answerConfidenceReason, MAX_REASON_CHARS)
  if (confidenceReason) out.answerConfidenceReason = confidenceReason

  const routing = oneOf(input.routingDecision, ROUTING_DECISIONS)
  if (routing) out.routingDecision = routing

  const routingReason = cap(input.routingReason, MAX_REASON_CHARS)
  if (routingReason) out.routingReason = routingReason

  const escalationReason = cap(input.escalationReason, MAX_REASON_CHARS)
  if (escalationReason) out.escalationReason = escalationReason

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

  if (input.showViewReport === true) out.showViewReport = true

  return Object.keys(out).length > 0 ? out : null
}
