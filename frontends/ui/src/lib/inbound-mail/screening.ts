/**
 * The office's screening, applied to a held mail before anyone sees it
 * (ADR-0134 D10 and D13). It flags; it never drops and never files.
 *
 * - **Namensprüfung** on each attachment's name and on the thread's base
 *   subject (the default name of a new E-Mail-Verlauf): a match sets
 *   `name_stop` and its terms on the part, the part is unselected, and filing
 *   it needs the person's explicit release (`screeningRelease: 'name'`), as for
 *   any upload. A subject match keeps a reply out of a follow (D31, cond. 6).
 * - **Inhaltsprüfung** (`findSpans`) on the sender's own text, after the
 *   Python reader removed the signature, so an IBAN in a footer is no finding:
 *   the kinds found are the message part's `content_findings`, and the person
 *   decides how the text is filed („Unkenntlich ablegen“ by default).
 *
 * One policy read per mail, the same one an upload into the project uses
 * (`gatePolicy`: the office's terms and the project's own), so the flag at
 * receive and the gate at filing cannot disagree. A policy that cannot be read
 * throws (`ScreeningPolicyUnavailableError`): the job retries rather than hold
 * a mail as if nothing matched.
 */

import 'server-only'
import { chatScreeningRules, findSpans, type ContentScreenKind } from '@/lib/upload-screening/content-screen'
import { screenUploadName } from '@/lib/upload-screening/name-screen'
import type { UploadScreeningPolicy } from '@/lib/upload-screening/policy'
import { gatePolicy } from '@/lib/upload-screening/service'

/** The most terms one part keeps (`inbound_mail_parts_name_stop_terms`). */
export const MAX_NAME_STOP_TERMS = 20

/** The screening of one mail, bound to the policy read once for it. */
export interface MailScreening {
  /** The office's terms a name matches, distinct, at most {@link MAX_NAME_STOP_TERMS}; empty when it may pass. */
  nameStops(name: string): string[]
  /** The kinds of finding in the own text, distinct, in rule order; empty when there are none. */
  contentFindings(ownText: string): ContentScreenKind[]
}

/** The screening of mail held for this project. Throws when the policy cannot be read. */
export async function mailScreeningFor(organizationId: string, projectId: string): Promise<MailScreening> {
  return mailScreening(await gatePolicy(organizationId, projectId))
}

/** {@link MailScreening} for a policy already read. Pure. */
export function mailScreening(policy: UploadScreeningPolicy): MailScreening {
  // The content gate's rules for prose: the office's content terms and number
  // checks, never the name terms (far too broad for text). Null when screening is off.
  const contentRules = chatScreeningRules(policy)
  return {
    nameStops(name) {
      if (!name.trim()) return []
      const terms = screenUploadName(policy, { filename: name }).matches.map((match) => match.term)
      return [...new Set(terms)].slice(0, MAX_NAME_STOP_TERMS)
    },
    contentFindings(ownText) {
      if (!contentRules || !ownText) return []
      return [...new Set(findSpans(ownText, contentRules).map((span) => span.kind))]
    },
  }
}
