/**
 * What the E-Mail-Eingang says about who a mail is from (DECISION §3
 * „Sender trust“, D4, C2), as data the components word through the
 * dictionary.
 *
 * DKIM proves a domain, never a person, so no label claims more than the
 * domain: „Domain bestätigt: statik-weber.at“, never „Absender bestätigt“.
 * „Gibt sich als … aus“ is reserved for the two results that are evidence of
 * a forgery (a signature that failed, or a DMARC policy that refused the
 * mail); a member's address that simply carries no signature is „Mitglied ·
 * Domain nicht bestätigt“, because most unsigned mail is a misconfigured
 * server and not an attack.
 *
 * Pure. The server's own rules live in `lib/inbound-mail/decision.ts`
 * (server-only); {@link senderNeedsAcknowledgement} restates the one the
 * decision bar needs and its spec holds the two to the same cases.
 */

import type { InboundMailSenderView } from '@/lib/inbound-mail/inbound-mail-wire'
import type { SenderFlag } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import { FOLLOW_REFUSING_FLAGS } from '@/lib/mail-thread/follow-eligibility'
import { isOwnBccCopy, senderPreselectionBlocks } from '@/lib/mail-thread/mail-threading'

/** The one line that says how far the sender is confirmed. */
export type SenderTrustLine =
  /** An aligned DKIM pass: the signing domain is named. */
  | { kind: 'verified'; domain: string }
  /** A member's own Bcc copy of a mail they sent elsewhere (D4). */
  | { kind: 'bcc_own'; domain: string | null }
  /** A member's address without a valid signature: shown as a member, unconfirmed. */
  | { kind: 'member_unverified' }
  /** A failed signature or a refusing policy on a member's address: someone claims to be them. */
  | { kind: 'impersonation'; name: string }
  /** Anyone else whose domain did not sign. */
  | { kind: 'unverified' }

/** How the line is drawn: a quiet fact, or a warning the reader must see before filing. */
export type SenderTone = 'confirmed' | 'neutral' | 'warning'

/** The reasons that are evidence of a forgery rather than of a missing signature. */
const FORGERY_REASONS = new Set<InboundMailSenderView['reason']>(['dkim_fail', 'dkim_policy'])

export function senderTrustLine(sender: InboundMailSenderView): SenderTrustLine {
  if (isOwnBccCopy({ senderTrust: sender.trust, senderFlags: sender.flags })) {
    return { kind: 'bcc_own', domain: sender.signerDomain ?? sender.domain }
  }
  if (sender.trust === 'member_verified' || sender.trust === 'external_verified') {
    return { kind: 'verified', domain: sender.signerDomain ?? sender.domain ?? sender.address }
  }
  if (FORGERY_REASONS.has(sender.reason)) {
    return { kind: 'impersonation', name: sender.name?.trim() || sender.address }
  }
  return sender.trust === 'member_unverified' ? { kind: 'member_unverified' } : { kind: 'unverified' }
}

export function senderTone(line: SenderTrustLine): SenderTone {
  switch (line.kind) {
    case 'verified':
    case 'bcc_own':
      return 'confirmed'
    case 'impersonation':
    case 'member_unverified':
      return 'warning'
    case 'unverified':
      return 'neutral'
  }
}

/**
 * The flags worth a line of their own under the trust line, in reading order.
 * `bcc_own` is said by the trust line itself, and `not_addressed_to_project`
 * belongs to it there; `message_id_reused` alone says nothing a person can
 * act on (the genuine message is never blocked), so it is not shown.
 */
export function senderFlagLines(sender: Pick<InboundMailSenderView, 'trust' | 'flags'>): SenderFlag[] {
  const ownBcc = isOwnBccCopy({ senderTrust: sender.trust, senderFlags: sender.flags })
  const shown: SenderFlag[] = []
  if (sender.flags.includes('not_addressed_to_project') && !ownBcc) shown.push('not_addressed_to_project')
  if (sender.flags.includes('stale_date')) shown.push('stale_date')
  else if (sender.flags.includes('date_out_of_range')) shown.push('date_out_of_range')
  if (sender.flags.includes('already_filed')) shown.push('already_filed')
  return shown
}

/**
 * Whether filing anything of this mail needs the person to accept its sender
 * („Domain nicht bestätigt. Trotzdem ablegen“, `acknowledgeSender`): a
 * member's address without their domain's signature, a failed signature or a
 * refusing policy, a mail addressed to others outside the member's own Bcc
 * copy, or a Date more than seven days old. A stranger's plain unsigned mail
 * needs none: it is labelled and never pre-selected.
 *
 * The mirror of `senderNeedsAcknowledgement` in `lib/inbound-mail/decision.ts`.
 */
export function senderNeedsAcknowledgement(sender: Pick<InboundMailSenderView, 'trust' | 'reason' | 'flags'>): boolean {
  if (sender.trust === 'member_unverified') return true
  if (FORGERY_REASONS.has(sender.reason)) return true
  if (sender.flags.includes('not_addressed_to_project') && !isOwnBccCopy({ senderTrust: sender.trust, senderFlags: sender.flags })) {
    return true
  }
  return sender.flags.includes('stale_date')
}

/**
 * Whether a Fassung of an earlier document from this sender needs the
 * `unverified_thread` acknowledgement (D11): the same blocks that keep a
 * thread from being pre-selected.
 */
export function revisionNeedsAcknowledgement(sender: Pick<InboundMailSenderView, 'trust' | 'flags'>): boolean {
  return senderPreselectionBlocks({ senderTrust: sender.trust, senderFlags: sender.flags }).length > 0
}

/** Initials-free fallback name for a sender: the display name, else the local part of the address. */
export function senderDisplayName(sender: Pick<InboundMailSenderView, 'name' | 'address'>): string {
  const name = sender.name?.trim()
  if (name) return name
  const at = sender.address.indexOf('@')
  return at > 0 ? sender.address.slice(0, at) : sender.address
}

/**
 * Whether „Diesem E-Mail-Verlauf folgen“ is offered after this mail's text was
 * filed (DECISION §9 step 7): only where a later reply from this sender could
 * ever qualify (D31 conditions 2 and 4). A stranger whose domain did not sign,
 * a member's Bcc copy, a replayed or misdated mail and a machine never could,
 * so offering the follow there would promise what it cannot do.
 */
export function followOffered(view: { sender: Pick<InboundMailSenderView, 'trust' | 'flags'> | null; automatic: boolean }): boolean {
  if (!view.sender || view.automatic) return false
  if (view.sender.trust !== 'member_verified' && view.sender.trust !== 'external_verified') return false
  return !view.sender.flags.some((flag) => (FOLLOW_REFUSING_FLAGS as readonly string[]).includes(flag))
}
