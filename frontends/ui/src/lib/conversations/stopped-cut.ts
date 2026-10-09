/**
 * The cut of a stored answer to what its asker had on screen when they
 * pressed Stop (`docs/design/chat-wire-v2.md` §c, Stop).
 *
 * The agent tier cuts a stopped turn's row itself (`cancel_turn.shown`). It
 * cannot when the Stop reaches it after the answer finished: the paced reveal
 * runs up to about a second behind the wire, so the reader may stop an answer
 * the server has already stored whole, and the server answers the cancel with
 * `turn_not_found`. The asker's browser then asks the BFF to cut that row
 * (`cutStoppedAnswer` in `service.ts`), and this is the cut: pure, so the
 * service decides who may ask and the repository owns the write.
 *
 * It only ever shortens what the row holds. The browser sends the text that
 * was on screen; the cut takes the stored text up to where the two part and
 * applies the stop rule to it (`stopped-answer.ts`, the rule the agent tier
 * and the browser's own write use), so no byte the browser sends is stored.
 */

import { v5 as uuidv5 } from 'uuid'
import type { Message } from '@/lib/db/schema'
import { ConflictError } from '@/lib/api/errors'
import { holdsNoMoreThan, sharedPrefixChars, stoppedAnswer } from '@/features/chat/lib/stopped-answer'

/**
 * How long after the stored answer was written its asker may still cut it.
 * A Stop crosses a finished answer by the length of the reveal's lag, about a
 * second; the margin is for a slow BFF and a reconnecting socket. Past it the
 * answer is history, and nobody rewrites history from a browser.
 */
export const STOP_CUT_WINDOW_MS = 10 * 60_000

/**
 * The answer's id for a turn, as the agent tier derives it
 * (`answer_message_id`, `src/aiq_agent/turn/response.py`): uuid5 in the URL
 * namespace of `grid:assistant:<conversation>:<turn>`. This is what ties an
 * answer to the question that opened its turn, and so to its asker.
 */
export const answerMessageId = (conversationId: string, turnId: string): string =>
  uuidv5(`grid:assistant:${conversationId}:${turnId}`, uuidv5.URL)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Stored as stopped by either writer: the agent tier's row (normalised into `provenance`) or the browser's. */
const storedAsStopped = (metadata: Record<string, unknown>): boolean =>
  metadata.stopped === true || (isRecord(metadata.provenance) && metadata.provenance.stopped === true)

/** A row that stands for something other than an answer the reader watched arrive: a run hand-off, a queue notice. */
const answeredElsewhere = (metadata: Record<string, unknown>): boolean =>
  metadata.run !== undefined || metadata.job_admission_rejected === true

/**
 * The row's new content and metadata, or null when it already holds no more
 * than the reader saw (a cut the agent tier, the browser or an earlier call
 * made). Throws `ConflictError` for a row that is not a recent chat answer,
 * and for a cut that would keep nothing.
 *
 * The stopped mark alone does not end it. The browser's provenance mirror
 * writes the mark too, and any collaborator may PATCH provenance: a mark on a
 * row that still holds the whole answer would otherwise leave it whole for
 * good. What decides is the text, so a retry is still harmless.
 */
export const cutStoppedRow = (
  existing: Message,
  shown: string,
  now: number
): { content: string; metadata: Record<string, unknown> } | null => {
  const metadata = isRecord(existing.metadata) ? existing.metadata : {}
  if (existing.role !== 'assistant' || existing.runId || answeredElsewhere(metadata)) {
    throw new ConflictError('Only a chat answer can be stopped.', { reason: 'not_an_answer' })
  }
  if (now - new Date(existing.createdAt).getTime() > STOP_CUT_WINDOW_MS) {
    throw new ConflictError('This answer can no longer be stopped.', { reason: 'too_late' })
  }
  if (storedAsStopped(metadata) && holdsNoMoreThan(existing.content, shown)) return null

  const cards: unknown[] = Array.isArray(metadata.cards) ? metadata.cards : []
  // The stored text is the settled answer, so its `[N]` resolve to the stored
  // citations. The rule keeps sources only where the kept text says
  // something; the envelope stands in for the list it encodes.
  const citations = metadata.citations === undefined ? [] : [metadata.citations]
  const kept = stoppedAnswer(
    { text: existing.content, settled: existing.content, sources: citations, cards },
    sharedPrefixChars(existing.content, shown)
  )
  // A Stop crosses a finished answer by the reveal's lag, with some of it on
  // screen. A cut to nothing is not that: it would let the asker blank any of
  // their answers of the last minutes, so it is refused and the row kept.
  if (!kept.text && kept.cards.length === 0) {
    throw new ConflictError('Nothing of this answer was on screen to keep.', { reason: 'nothing_shown' })
  }
  const { cards: _cards, citations: _citations, ...rest } = metadata
  const provenance = isRecord(metadata.provenance) ? metadata.provenance : {}
  return {
    content: kept.text,
    metadata: {
      ...rest,
      ...(kept.cards.length > 0 && { cards: kept.cards }),
      ...(kept.sources.length > 0 && { citations: metadata.citations }),
      provenance: { ...provenance, stopped: true },
    },
  }
}
