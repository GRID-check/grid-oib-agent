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

import { PROJECT_MEMORY_KINDS } from '@/lib/db/schema'

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
 * One `project_memory` row the post-answer reflection stage wrote for this turn.
 *
 * A NOTIFICATION, not the record: the row itself lives in `project_memory`,
 * where `grid_app` is the single writer and the memory panel is where a reader
 * curates it. What is stored on the message is the fact that THIS TURN produced
 * it — the identity the row has never had (§1.6), and the reason the chip could
 * only ever say the same „Piloti hat sich gemerkt 5" against every answer in
 * the thread.
 *
 * `provenanceType` is not carried: this key holds the reflection stage's items
 * and nothing else, so it is `'distillation'` by construction. The in-turn
 * `remember` half of the chip is derived from the turn's own cards, and the two
 * are labelled apart where they are rendered.
 */
export interface StoredMemoryItem {
  id: string
  kind: string
  content: string
}

/** `memory_reflection` payload, v1 (§5.1). */
export interface StoredMemoryReflectionStage {
  items: StoredMemoryItem[]
}

/**
 * Every stage whose output a message may carry. One optional key per stage, so
 * two stages targeting the same turn write to different keys and neither erases
 * the other (§7.7) — and a duplicate delivery overwrites rather than appends,
 * which makes two chip sets structurally impossible (§7.2).
 */
export interface MessageStages {
  followUps?: StoredFollowUpsStage
  memoryReflection?: StoredMemoryReflectionStage
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

/**
 * Reflection writes at most `MAX_NEW_ITEMS = 5` items per turn
 * (`agents/project_memory/reflection.py`). Six is that ceiling plus room for it
 * to move by one without this cap silently swallowing a real item.
 */
export const MAX_MEMORY_ITEMS = 6
/** The backend's own `_MAX_CONTENT_CHARS`, so a full finding survives verbatim. */
const MAX_MEMORY_CONTENT_CHARS = 500
/** A uuid is 36; the slack is for an id shape that is not one. */
const MAX_MEMORY_ID_CHARS = 64

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
 * The kinds a `project_memory` row can carry — the DB's own enum, so an item
 * naming anything else describes a row that cannot exist and is dropped rather
 * than stored. Not a display concern: it is what keeps an arbitrary client
 * string out of a jsonb column on a hot table.
 */
const MEMORY_KINDS: ReadonlySet<string> = new Set(PROJECT_MEMORY_KINDS)

/**
 * Reduce an untrusted `memory_reflection` payload to a bounded one, or null
 * when nothing survives.
 *
 * An item needs all three fields to be worth storing: without `content` there is
 * nothing to show the reader, and without `id` two deliveries of the same item
 * could not be told apart in a list. Items are dropped individually — one
 * malformed row must not cost the reader the other four, because unlike a set
 * of suggestion chips these are things that were WRITTEN to their project.
 */
export function sanitizeMemoryReflectionStage(input: unknown): StoredMemoryReflectionStage | null {
  if (!isRecord(input) || !Array.isArray(input.items)) return null

  const items: StoredMemoryItem[] = []
  for (const raw of input.items) {
    if (items.length >= MAX_MEMORY_ITEMS) break
    if (!isRecord(raw)) continue
    const id = cap(raw.id, MAX_MEMORY_ID_CHARS)
    const content = cap(raw.content, MAX_MEMORY_CONTENT_CHARS)
    const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
    if (!id || !content || !MEMORY_KINDS.has(kind)) continue
    items.push({ id, kind, content })
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

  const memoryReflection = sanitizeMemoryReflectionStage(input.memoryReflection)
  if (memoryReflection) out.memoryReflection = memoryReflection

  return Object.keys(out).length > 0 ? out : null
}
