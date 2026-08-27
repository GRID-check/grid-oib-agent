/**
 * Recall scoring — which notes are worth a slot in the prompt.
 *
 * The shared answer to a question both note stores were getting wrong. Project
 * memory served `ORDER BY pinned, updated_at LIMIT 20`, which the memory audit
 * called "an effectively random-by-recency subset" once a project passes
 * twenty items (memory-system-audit-2026-07 F3) — `salience` was written and
 * never read, `last_referenced_at` was written and never read, so nothing in
 * the system ever asked which notes matter *for this question*.
 *
 * The model is Generative Agents' retrieval score (Park et al., UIST '23):
 *
 *     score = w_relevance·relevance + w_importance·importance + w_recency·recency
 *
 * with three deliberate choices taken from the SHIPPED implementation rather
 * than the paper, because they differ:
 *
 *  - **Weights are not equal.** The paper says α = 1 for all three; the
 *    released code multiplies by `[0.5, 3, 2]` — relevance 3, importance 2,
 *    recency 0.5. Relevance-dominant by six to one over recency is the
 *    configuration that was actually run, so it is the one copied here.
 *  - **Recency decays over RANK, not wall-clock.** The released code uses
 *    `decay ** i` over the recency-ordered list. That removes "how long is an
 *    hour" from a system with no simulated clock, and it is immune to a burst
 *    of writes compressing every timestamp into one afternoon.
 *  - **Each term is min-max normalised across the candidate set before the sum**,
 *    so a cosine in [0.3, 0.5] and a salience in [0, 1] are commensurable.
 *
 * On top of that sits MemoryBank's reinforcement, which is the mechanism the
 * shipping systems converge on (Copilot Memory deletes a memory unused for 28
 * days and resets that clock on every successful use):
 *
 *     retention = e^(−t / S)     t = days since last use, S = 1 + times used
 *
 * Used here as a read-time MULTIPLIER, clamped to Mem0's published band
 * [0.3, 1.5], and never as a delete: a note that stops being retrieved fades
 * out of the prompt and stays in the table, so nothing is destroyed by a
 * scoring change and "what did we know" is still answerable.
 */

/** Generative Agents' shipped weights (`gw = [0.5, 3, 2]`). */
export const WEIGHT_RELEVANCE = 3
export const WEIGHT_IMPORTANCE = 2
export const WEIGHT_RECENCY = 0.5

/** Rank-decay base from the released implementation (`recency_decay = 0.99`). */
export const RECENCY_DECAY = 0.99

/**
 * A floor under the weighted sum, before reinforcement multiplies it.
 *
 * Min-max normalisation maps the WORST candidate on each axis to exactly 0, so
 * a note that is last on relevance, importance and recency scores 0 — and zero
 * times any multiplier is still zero, which means its track record could never
 * lift it no matter how often it had proved useful. That is not the intent of
 * a reinforcement term; it is an artefact of normalising to [0,1].
 *
 * Sized deliberately at the recency weight: a well-used note can overcome a
 * recency deficit (which is what reinforcement is FOR), and cannot overcome a
 * real relevance gap (weight 3), which is what keeps the ranking
 * relevance-dominant the way the shipped Generative Agents weights are.
 */
const BASE_FLOOR = 0.5

/** Mem0's published reinforcement band: dampen the unused, boost the used. */
export const REINFORCEMENT_MIN = 0.3
export const REINFORCEMENT_MAX = 1.5

export interface ScorableNote {
  /** Cosine similarity to the query, or null when nothing was embedded. */
  relevance: number | null
  /** Author-or-model-assigned importance in [0,1] (`project_memory.salience`). */
  importance: number
  /** Days since this note was last recalled; null when never recalled. */
  daysSinceUse: number | null
  /** How often it has been recalled — MemoryBank's strength term `S`. */
  timesUsed: number
}

/**
 * MemoryBank retention as a bounded multiplier.
 *
 * `S = 1 + timesUsed` so a never-used note starts at S=1 and each recall both
 * resets `t` and flattens the curve. A note never yet recalled is NOT punished
 * (multiplier 1): it has had no chance to prove itself, and punishing it would
 * make the store self-confirming — only what was already surfaced could ever
 * be surfaced again.
 */
export function reinforcementMultiplier(daysSinceUse: number | null, timesUsed: number): number {
  if (daysSinceUse === null) return 1
  const strength = 1 + Math.max(0, timesUsed)
  const retention = Math.exp(-Math.max(0, daysSinceUse) / strength)
  // Map retention (0,1] onto the band: fully-retained earns the boost, faded
  // is damped rather than dropped.
  const scaled = REINFORCEMENT_MIN + retention * (REINFORCEMENT_MAX - REINFORCEMENT_MIN)
  return Math.min(REINFORCEMENT_MAX, Math.max(REINFORCEMENT_MIN, scaled))
}

/** Min-max normalise, mapping a degenerate (all-equal) set to all-zeros. */
function normalize(values: number[]): number[] {
  if (values.length === 0) return []
  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  const span = max - min
  if (span === 0) return values.map(() => 0)
  return values.map((value) => (value - min) / span)
}

/**
 * Score a candidate set, best first. Returns the input indices in ranked
 * order, so the caller keeps its own row objects.
 *
 * `notes` must already be ordered most-recent-first — recency is rank-based,
 * so the caller's ordering IS the recency signal.
 */
export function rankByRecallScore(notes: ScorableNote[]): { index: number; score: number }[] {
  if (notes.length === 0) return []

  // A candidate set where nothing was embedded scores relevance 0 across the
  // board; normalisation then flattens it and the ranking falls back to
  // importance + recency, which is exactly the pre-embedding behaviour.
  const relevance = normalize(notes.map((note) => note.relevance ?? 0))
  const importance = normalize(notes.map((note) => note.importance))
  const recency = normalize(notes.map((_, index) => RECENCY_DECAY ** (index + 1)))

  return notes
    .map((note, index) => {
      const base =
        BASE_FLOOR +
        WEIGHT_RELEVANCE * relevance[index] +
        WEIGHT_IMPORTANCE * importance[index] +
        WEIGHT_RECENCY * recency[index]
      return {
        index,
        score: base * reinforcementMultiplier(note.daysSinceUse, note.timesUsed),
      }
    })
    .sort((a, b) => b.score - a.score)
}

/** Days between `then` and now, or null when `then` is absent. */
export function daysSince(then: Date | null | undefined): number | null {
  if (!then) return null
  return Math.max(0, (Date.now() - then.getTime()) / (24 * 60 * 60 * 1000))
}
