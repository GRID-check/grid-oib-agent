/**
 * Where a transcript goes in the composer: at the caret, or at the end when
 * there is none. Existing text is never replaced, not even a selection: the
 * transcript goes after it. Pure, so the rule has one home and one spec.
 */

/** The composer's selection, as `selectionStart`/`selectionEnd` reported it. */
export interface ComposerCaret {
  start: number
  end: number
}

export interface InsertedTranscript {
  value: string
  /** Where the caret belongs afterwards: straight after the inserted text. */
  caret: number
}

/** What a transcript may abut without a space: closing punctuation after it, an opening bracket before it. */
const ABUTS_AFTER = /^[\s.,;:!?)\]}»“"']/
const ABUTS_BEFORE = /[\s([{„«"']$/

/**
 * `value` with `transcript` inserted at `caret` (its end) or appended when
 * `caret` is null, spaced from its neighbours. `null` when there is nothing
 * to insert, so silence changes nothing.
 */
export function insertTranscript(
  value: string,
  transcript: string,
  caret: ComposerCaret | null,
): InsertedTranscript | null {
  const text = transcript.trim()
  if (!text) return null
  const at = caret === null ? value.length : Math.min(Math.max(caret.end, 0), value.length)
  const before = value.slice(0, at)
  const after = value.slice(at)
  const lead = before.length > 0 && !ABUTS_BEFORE.test(before) ? ' ' : ''
  const trail = after.length > 0 && !ABUTS_AFTER.test(after) ? ' ' : ''
  return {
    value: `${before}${lead}${text}${trail}${after}`,
    caret: before.length + lead.length + text.length,
  }
}
