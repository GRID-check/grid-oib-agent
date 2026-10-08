/**
 * A human-in-the-loop prompt, made visible to everyone in the thread (ADR-0037).
 *
 * A prompt card that exists only in the browser whose socket received the frame
 * is invisible to everyone else. In a shared conversation, an observer's
 * server-authoritative load (ADR-0033 §2) shows **no card at all** — the thread
 * simply stops, and the "Piloti is answering …" banner ages out after five
 * minutes. A reader is left with a conversation that looks broken when in fact
 * the assistant is waiting on a colleague.
 *
 * Persisting it fixes three things at once:
 *
 *   1. an observer sees WHAT was asked and WHO it was asked of;
 *   2. the asker's own reload — or a second device — gets the card back instead of
 *      a thread that ends mid-question;
 *   3. the answer becomes part of the record, so the transcript says what was
 *      decided rather than only that something was.
 *
 * **`promptFor` is the addressee, and it is not decoration.** The agent tier
 * refuses an answer from anybody but the person asked (`_may_answer_interaction`),
 * so a UI that offered a colleague the buttons would be offering a refusal. This is
 * what lets a reader be shown the question read-only.
 *
 * Bounded and whitelisted here, for the reason `sanitizeProvenance` is: this lands
 * in a jsonb column from a client payload, and "it is typed" is not a bound.
 */

/** One option of a `choice` prompt (`interaction_request`). */
export interface StoredPromptOption {
  id: string
  label: string
}

/** Prompt shape as stored on the message row. */
export interface StoredPromptDetail {
  /** The `interaction_id`. */
  promptId?: string
  /** The turn it belongs to. */
  promptParentId?: string
  promptInputType?: 'text' | 'choice'
  /** A `choice` prompt's options; its answer is an option's `id`. */
  promptOptions?: StoredPromptOption[]
  promptPlaceholder?: string
  /** WorkOS user id the prompt is addressed to — the person the agent asked. */
  promptFor?: string
}

/** The answer, merged onto the same row once it is given. */
export interface StoredPromptState {
  response: string
  respondedAt: string
}

/** A choice prompt offers a handful of options; hundreds is a runaway client. */
const MAX_PROMPT_OPTIONS = 32
const MAX_OPTION_CHARS = 400
const MAX_PLACEHOLDER_CHARS = 400
const MAX_RESPONSE_CHARS = 4_000
const MAX_ID_CHARS = 128

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const cap = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined

/** A `choice` prompt's options, bounded; anything that is not `{id, label}` is dropped. */
export function sanitizePromptOptions(input: unknown): StoredPromptOption[] | undefined {
  if (!Array.isArray(input)) return undefined
  const options = input.slice(0, MAX_PROMPT_OPTIONS).flatMap((option): StoredPromptOption[] => {
    if (!isRecord(option)) return []
    const id = cap(option.id, MAX_ID_CHARS)
    const label = cap(option.label, MAX_OPTION_CHARS)
    return id && label ? [{ id, label }] : []
  })
  return options.length > 0 ? options : undefined
}

export function sanitizePromptDetail(input: unknown): StoredPromptDetail | null {
  if (!isRecord(input)) return null
  const out: StoredPromptDetail = {}

  const id = cap(input.promptId, MAX_ID_CHARS)
  if (id) out.promptId = id
  const parentId = cap(input.promptParentId, MAX_ID_CHARS)
  if (parentId) out.promptParentId = parentId
  if (input.promptInputType === 'text' || input.promptInputType === 'choice') {
    out.promptInputType = input.promptInputType
  }
  const placeholder = cap(input.promptPlaceholder, MAX_PLACEHOLDER_CHARS)
  if (placeholder) out.promptPlaceholder = placeholder
  const promptFor = cap(input.promptFor, MAX_ID_CHARS)
  if (promptFor) out.promptFor = promptFor

  const options = sanitizePromptOptions(input.promptOptions)
  if (options) out.promptOptions = options

  return Object.keys(out).length > 0 ? out : null
}

export function sanitizePromptState(input: unknown): StoredPromptState | null {
  if (!isRecord(input)) return null
  // An empty answer is not an answer; `''` would render as "responded" with
  // nothing to show, which is worse than still asking.
  const response = cap(input.response, MAX_RESPONSE_CHARS)
  if (response === undefined) return null
  // The instant is the SERVER'S, never the client's: a copied `respondedAt` lets
  // a participant backdate or future-date a persisted decision, and the ordering
  // of a shared transcript is exactly the thing that must not be forgeable. The
  // clock here is the same one that stamped the row, so the two agree.
  return { response, respondedAt: new Date().toISOString() }
}
