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

export interface MessageProvenance {
  thinkingSteps?: StoredThinkingStep[]
  answerConfidence?: 'low' | 'medium' | 'high'
  answerConfidenceCappedReason?: 'ungrounded' | 'quote_unverified'
  answerConfidenceReason?: string
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  routingReason?: string
  escalationReason?: string
  citationsRemoved?: { count: number; reasons: string[] }
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
const CAPPED_REASONS = ['ungrounded', 'quote_unverified'] as const
const ROUTING_DECISIONS = ['meta', 'shallow', 'deep', 'error'] as const

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

  const jobId = cap(input.deepResearchJobId, 128)
  if (jobId) out.deepResearchJobId = jobId

  if (input.showViewReport === true) out.showViewReport = true

  return Object.keys(out).length > 0 ? out : null
}
