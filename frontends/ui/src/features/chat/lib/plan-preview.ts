/**
 * The research-plan preview as it used to be a prompt (before ADR-0068).
 *
 * Threads written before the plan became a row of its own still carry these
 * messages: an English envelope sentence and a fenced JSON copy of the plan.
 * Nothing on the backend waits for an answer to one any more, so an
 * unanswered one is history, never a pending question.
 */

/** The approval envelope an old plan preview carries, either variant. */
const APPROVAL_PROMPT_RE = /Reply\s+\*{0,2}approve\*{0,2}\s+to proceed,/i

/** Whether a prompt's text is an old plan preview. */
export const isLegacyPlanPreview = (content: string): boolean => APPROVAL_PROMPT_RE.test(content)
