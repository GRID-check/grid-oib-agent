/**
 * A human-in-the-loop prompt, made visible to everyone in the thread (ADR-0037).
 *
 * `addAgentPrompt` never persisted anything: a clarification card existed only in
 * the browser whose socket received the frame. In a shared conversation that means
 * an observer's server-authoritative load (ADR-0033 §2) shows **no card at all** —
 * the thread simply stops, and the "Piloti is answering …" banner ages out after
 * five minutes. A reader is left with a conversation that looks broken when in fact
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
 * **`promptFor` is the addressee, and it is not decoration.** The agent tier now
 * refuses an answer from anybody but the person asked (`_may_answer_interaction`),
 * so a UI that offered a colleague the buttons would be offering a refusal. This is
 * what lets a reader be shown the question read-only.
 *
 * Bounded and whitelisted here, for the reason `sanitizeProvenance` is: this lands
 * in a jsonb column from a client payload, and "it is typed" is not a bound.
 */

/** Prompt shape as stored on the message row. */
export interface StoredPromptDetail {
  promptType?: string
  promptId?: string
  promptParentId?: string
  promptInputType?: string
  promptOptions?: string[]
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

export function sanitizePromptDetail(input: unknown): StoredPromptDetail | null {
  if (!isRecord(input)) return null
  const out: StoredPromptDetail = {}

  const type = cap(input.promptType, 40)
  if (type) out.promptType = type
  const id = cap(input.promptId, MAX_ID_CHARS)
  if (id) out.promptId = id
  const parentId = cap(input.promptParentId, MAX_ID_CHARS)
  if (parentId) out.promptParentId = parentId
  const inputType = cap(input.promptInputType, 40)
  if (inputType) out.promptInputType = inputType
  const placeholder = cap(input.promptPlaceholder, MAX_PLACEHOLDER_CHARS)
  if (placeholder) out.promptPlaceholder = placeholder
  const promptFor = cap(input.promptFor, MAX_ID_CHARS)
  if (promptFor) out.promptFor = promptFor

  if (Array.isArray(input.promptOptions)) {
    const options = input.promptOptions
      .slice(0, MAX_PROMPT_OPTIONS)
      .map((option) => cap(option, MAX_OPTION_CHARS))
      .filter((option): option is string => option !== undefined)
    if (options.length > 0) out.promptOptions = options
  }

  return Object.keys(out).length > 0 ? out : null
}

export function sanitizePromptState(input: unknown): StoredPromptState | null {
  if (!isRecord(input)) return null
  // An empty answer is not an answer; `''` would render as "responded" with
  // nothing to show, which is worse than still asking.
  const response = cap(input.response, MAX_RESPONSE_CHARS)
  if (response === undefined) return null
  const respondedAt = cap(input.respondedAt, 40)
  return { response, respondedAt: respondedAt ?? new Date().toISOString() }
}
