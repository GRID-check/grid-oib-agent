/**
 * Which session — if any — a returning user should land in.
 *
 * Opening the app with no `?session=` in the URL used to always drop you on an
 * empty composer, even when you were mid-conversation ninety seconds earlier and
 * only reloaded the tab. Re-finding that session meant opening the sessions
 * panel and picking the top row: three deliberate actions to undo an accident.
 *
 * The rule is deliberately narrow, because the opposite failure is worse. Silently
 * reopening a week-old thread makes the composer lie about its context — the
 * model still has that history, the user has forgotten it, and the next question
 * gets answered against the wrong project. So a session is only resumed when
 * continuing it is the obviously intended act:
 *
 *  1. It is the most recently touched session (never reach past a newer one).
 *  2. It was touched within {@link RESUME_WINDOW_MS} — a working day, so lunch,
 *     a meeting or an accidental tab close resume, while "yesterday" does not.
 *  3. It actually has messages. A pristine empty draft is indistinguishable from
 *     the fresh start the user would get anyway, so resuming it buys nothing and
 *     would suppress the welcome state for no reason.
 *
 * Everything else — including "the newest session is stale" — starts fresh, and
 * the sessions panel remains the way back.
 */

/** A working day. Long enough for lunch and meetings, short enough that a new
 *  morning starts clean rather than silently inheriting yesterday's topic. */
export const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000

/** The fields the rule needs — kept structural so tests need no full Conversation. */
export interface ResumableSession {
  id: string
  updatedAt: Date | string | number
  messages: readonly unknown[]
}

/** Milliseconds since epoch for a wire value that may be a string or a Date. */
const timeOf = (value: Date | string | number): number => {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY
}

/**
 * The session to auto-open, or `null` to start fresh.
 *
 * `now` is injected so the boundary is testable without faking timers.
 */
export function resumableSessionId(
  sessions: readonly ResumableSession[],
  now: number = Date.now(),
  windowMs: number = RESUME_WINDOW_MS
): string | null {
  let newest: ResumableSession | null = null
  let newestAt = Number.NEGATIVE_INFINITY
  for (const session of sessions) {
    const at = timeOf(session.updatedAt)
    if (at > newestAt) {
      newestAt = at
      newest = session
    }
  }
  if (!newest || newest.messages.length === 0) return null

  // A future timestamp (clock skew, a bad import) is still "recent" — clamping
  // the age at 0 keeps skew from reading as infinitely old and blocking resume.
  const age = Math.max(0, now - newestAt)
  return age <= windowMs ? newest.id : null
}
