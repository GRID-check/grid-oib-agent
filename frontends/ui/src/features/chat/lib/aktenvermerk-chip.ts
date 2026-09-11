/**
 * „Als Aktenvermerk schreiben" — the one client-side offer under a long answer
 * (ledger 23).
 *
 * Nobody learns that Piloti WRITES. Discovery today is a person happening to
 * phrase a request as a commission („schreib mir dazu einen Aktenvermerk"), and
 * everyone who phrases it as a question — which is everyone — gets an answer
 * they then copy into Word by hand. This is the chip that says the other thing
 * is possible, at the only moment it is obviously worth doing: under an answer
 * long enough that the reader is already thinking about where to put it.
 *
 * ## It is a chip, not a stage
 *
 * The follow-up chips beside it come from a post-answer STAGE: the backend
 * computes them seconds after the answer and delivers them on the message
 * (`lib/conversations/message-stages.ts`). This one is decided in the browser
 * from three facts the browser already holds, and costs no round trip: a turn
 * that ends in a walkthrough or a ruling, inside a project, with a body past
 * {@link AKTENVERMERK_MIN_CHARS}.
 *
 * Pressing it fills the composer and does nothing else — the same contract every
 * chip here has, and the same one `DocumentDraftCard`'s „Ins Projekt übernehmen"
 * keeps. The person still presses send, so the draft is written under their
 * permissions, in their session, with their audit actor (ADR-0054 §4). A chip
 * that filed a document by itself would be a second door onto a primitive that
 * has one (ADR-0055).
 */

import type { AnswerKind } from '@/lib/conversations/message-answer-meta'

/**
 * How long an answer has to be before the offer is worth making.
 *
 * Derived, not chosen: the thread column is 680px and the answer prose renders
 * at the product's 16px measure, which is about 75 characters to a line and
 * about twelve lines before the answer card is taller than the space between
 * the question and the composer. One screenful is therefore ~900 characters,
 * and one screenful is exactly the point where a reader stops re-reading and
 * starts scrolling back — which is the moment „put this in the project" becomes
 * a thought they were going to have anyway.
 *
 * Below it the offer is noise: a four-line answer copied into a document is a
 * worse four-line answer, filed somewhere. The number is a floor for *making an
 * offer*, never a rule about what may be written — a person who asks for a
 * two-sentence Aktenvermerk still gets one.
 */
export const AKTENVERMERK_MIN_CHARS = 900

/**
 * The answer shapes worth filing.
 *
 * `walkthrough` (a guided answer) and `ruling` (a copyable legal value) are the
 * two an office puts in a folder. `direct` is a Hinweis — a greeting, a
 * capability question, a Rückfrage — and `handoff` is a turn that ended by
 * pointing somewhere else; neither is a document, and offering to file one
 * would teach the reader that the chip means nothing.
 */
const FILEABLE_KINDS: ReadonlySet<AnswerKind> = new Set<AnswerKind>(['walkthrough', 'ruling'])

export interface AktenvermerkContext {
  /** The envelope's own answer shape. Absent on a legacy turn — see below. */
  kind?: AnswerKind
  /** The project this turn belongs to; `null` outside one. */
  projectId?: string | null
  /** The answer's rendered body. */
  body?: string | null
}

/**
 * Whether this turn earns the chip.
 *
 * A legacy answer with no `kind` gets NO offer even when it is long and in a
 * project: an envelope that never named its shape is one this build cannot
 * classify, and guessing "probably a walkthrough" would put the chip under
 * greetings in every thread old enough to predate the field.
 */
export function offersAktenvermerk({ kind, projectId, body }: AktenvermerkContext): boolean {
  if (!kind || !FILEABLE_KINDS.has(kind)) return false
  if (!projectId) return false
  return (body?.trim().length ?? 0) > AKTENVERMERK_MIN_CHARS
}
