/**
 * A turn's POST-ANSWER STAGE output, made durable
 * (`docs/architecture/post-answer-stages.md` §4.4, §7.8).
 *
 * A stage runs after the answer exists and produces at most one payload
 * addressed to that turn. The payload lands in `messages.metadata.stages`
 * rather than in a table of its own, for two hard reasons: `messages` is
 * already covered by `grid_secure_table`, so tenant isolation comes for free
 * and correct (§7.3), and `server-message-mapper` already restores that column,
 * so `stages` is one more key on a path that exists.
 *
 * **The client is not trusted with the bound**, exactly as `sanitizeProvenance`
 * is not. This is jsonb on a hot table fed from a browser: the key set is
 * closed, the item list is truncated and every string is capped. A stage that
 * this build does not know is dropped rather than stored — an unbounded map of
 * stage ids is how "one more key" becomes a column of arbitrary client JSON.
 *
 * Shared by the sanitiser (write) and the mapper (read) so the two cannot
 * disagree about what a stored stage looks like.
 */

/** One follow-up question, the same shape the `follow_ups` card has always had. */
export interface StoredFollowUp {
  question: string
  hint?: string
}

/** `follow_ups` payload, v1 (§4.2). */
export interface StoredFollowUpsStage {
  items: StoredFollowUp[]
}

/**
 * Every stage whose output a message may carry. One optional key per stage, so
 * two stages targeting the same turn write to different keys and neither erases
 * the other (§7.7) — and a duplicate delivery overwrites rather than appends,
 * which makes two chip sets structurally impossible (§7.2).
 */
export interface MessageStages {
  followUps?: StoredFollowUpsStage
}

/**
 * At most four questions. The set is meant to be taken in at a glance; a fifth
 * is a list, and a list is not an offer. The backend already bounds this — the
 * cap here is the one that holds when the backend is wrong.
 */
export const MAX_FOLLOW_UPS = 4
/** A follow-up is a sendable sentence, not a paragraph. */
const MAX_QUESTION_CHARS = 300
/** The hint rides in a tooltip; anything longer is not readable there anyway. */
const MAX_HINT_CHARS = 200

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cap = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : undefined

/**
 * Reduce an untrusted `follow_ups` payload to a bounded one, or null when
 * nothing survives.
 *
 * An items list with no usable question in it is null, not `{ items: [] }`: an
 * empty offer is an unkept promise, and storing one would make a turn where the
 * stage produced nothing indistinguishable from one where it produced something
 * unreadable.
 */
export function sanitizeFollowUpsStage(input: unknown): StoredFollowUpsStage | null {
  if (!isRecord(input) || !Array.isArray(input.items)) return null

  const items: StoredFollowUp[] = []
  for (const raw of input.items) {
    if (items.length >= MAX_FOLLOW_UPS) break
    if (!isRecord(raw)) continue
    const question = cap(raw.question, MAX_QUESTION_CHARS)
    if (!question) continue
    const hint = cap(raw.hint, MAX_HINT_CHARS)
    items.push(hint ? { question, hint } : { question })
  }

  return items.length > 0 ? { items } : null
}

/**
 * Reduce an untrusted `stages` map to the closed set this build knows.
 *
 * Returns null when nothing survives, so a caller can skip the write entirely
 * rather than stamping an empty object onto a message — the same discipline
 * `sanitizeProvenance` follows.
 */
export function sanitizeStages(input: unknown): MessageStages | null {
  if (!isRecord(input)) return null
  const out: MessageStages = {}

  const followUps = sanitizeFollowUpsStage(input.followUps)
  if (followUps) out.followUps = followUps

  return Object.keys(out).length > 0 ? out : null
}
