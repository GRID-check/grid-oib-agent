/**
 * A held mail's subject as a person reads it in a list: without the chain of
 * reply and forward leaders („AW: WG: AW[2]:“) and the gateway tags a mail
 * server puts in front of outside mail („[EXTERN]“), so the row starts with
 * what the mail is about. Case and wording stay as sent.
 *
 * Not `baseSubject` (`lib/mail-thread/mail-threading.ts`): that one case-folds
 * for matching and is never shown. This one only trims the front and the
 * RFC 5256 trailer; the full subject stays in the row's `title`.
 *
 * Pure.
 */

/** Reply and forward leaders across the languages Austrian offices receive, with Outlook's counters. */
const LEADER = /^(?:re|aw|antw|antwort|wg|fw|fwd|wtr|tr|sv|vs|rif|r|rv|enc|odp|pd|doorst|vl|ynt)(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/iu
/** Gateway tags, bracketed or followed by a separator. */
const GATEWAY = /^(?:\[\s*(?:extern|external|ext|extern\s*e-mail|caution)\s*\]|(?:extern|external|caution)\s*[:\-–])\s*/iu
/** RFC 5256 subj-trailer. */
const TRAILER = /\s*\((?:fwd|fw)\)\s*$/iu
/** A leader that says the mail was forwarded, not answered. */
const FORWARD_LEADER = /^(?:wg|fw|fwd|wtr|tr|vl|enc|pd|doorst|rv|ynt)(?:\[\d+\]|\(\d+\))?\s*[:：]/iu

/** The subject without its leaders and tags; null when nothing is left (no subject, or only „AW:“). */
export function displaySubject(subject: string | null | undefined): string | null {
  let current = (subject ?? '').replace(/\s+/gu, ' ').trim()
  for (let previous = ''; previous !== current; ) {
    previous = current
    current = current.replace(TRAILER, '').replace(LEADER, '').replace(GATEWAY, '').trim()
  }
  return current === '' ? null : current
}

/** Whether the subject as sent says the mail was forwarded („WG:“, „Fwd:“), at any depth of the leader chain. */
export function isForwardSubject(subject: string | null | undefined): boolean {
  let current = (subject ?? '').trim()
  for (let previous = ''; previous !== current; ) {
    if (FORWARD_LEADER.test(current)) return true
    previous = current
    current = current.replace(LEADER, '').replace(GATEWAY, '').trim()
  }
  return false
}
