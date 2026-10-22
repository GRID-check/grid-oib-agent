/**
 * Whether a reply may join a followed E-Mail-Verlauf without a click
 * („Verlauf folgen“, ADR-0134, DECISION D31). Pure.
 *
 * Following is a person's standing decision about one conversation: later
 * replies' **text** is appended as that person, attachments always wait. It is
 * the one path that files without a per-mail decision, so it holds only while
 * every condition below holds, and the moment one fails the mail waits exactly
 * as it would without a follow. This module is conditions 1–6, the ones the
 * receive job can judge from the mail and the thread alone; it decides whether
 * `inbound_mail_follow` is enqueued at all. The follow job re-checks all nine
 * as the follower, adding 7–9 (the follower's rights, the caps, the thread
 * document's state), which need the database.
 *
 * 1. a follow is active: not ended, not expired, and created before the mail
 *    was received (held mail that arrived before the follow follows nothing);
 * 2. the sender's domain is verified (`member_verified` or `external_verified`);
 * 3. the match is `reference` to this thread, the header it rests on is
 *    signed, and so are From, Subject, Date, Message-ID and every To/Cc the
 *    mail carries;
 * 4. none of `not_addressed_to_project`, `bcc_own`, `stale_date`,
 *    `date_out_of_range`, `message_id_reused` or `already_filed`, and not
 *    automatic mail;
 * 5. no new participant domain: every domain in From/To/Cc, the project's
 *    own excluded, already took part in the thread;
 * 6. the Namensprüfung found no term in the subject, and the content check
 *    found nothing in the own text.
 */

import type { SenderTrust, ThreadMatch } from './mail-threading'
import { domainOf, restsOnSignedHeader, signedHeaderSet, VERIFIED_SENDER_TRUSTS } from './mail-threading'

/**
 * Why a reply does not join a followed thread by itself, in the order of the
 * conditions. The E-Mail-Eingang shows the reason („Neue Beteiligte: …“).
 */
export const FOLLOW_INELIGIBILITY_REASONS = [
  'no_active_follow',
  'sender_not_verified',
  'match_not_reference',
  'header_not_signed',
  'flagged',
  'automatic',
  'new_participant_domain',
  'name_stop',
  'content_finding',
] as const
export type FollowIneligibilityReason = (typeof FOLLOW_INELIGIBILITY_REASONS)[number]

/** The sender flags that keep a mail out of every follow (condition 4). */
export const FOLLOW_REFUSING_FLAGS = [
  'not_addressed_to_project',
  'bcc_own',
  'stale_date',
  'date_out_of_range',
  'message_id_reused',
  'already_filed',
] as const

/** The headers that must be inside the signature besides the one the match rests on (condition 3). */
export const FOLLOW_REQUIRED_SIGNED_HEADERS = ['from', 'subject', 'date', 'message-id'] as const

/** What the receive job knows of the mail when it asks. */
export interface FollowCandidateMail {
  receivedAt: Date
  senderTrust: SenderTrust
  senderFlags: readonly string[]
  signedHeaders: readonly string[]
  automatic: boolean
  /** Which recipient headers the mail carries; each must be signed. */
  recipientHeaders: ReadonlyArray<'to' | 'cc'>
  /** Every address in From, To and Cc. */
  participantAddresses: readonly string[]
  /** The mail's match to the followed thread, or null when it did not match it. */
  match: ThreadMatch | null
  /** Terms the Namensprüfung found in the base subject. */
  subjectNameStops: readonly string[]
  /** How many spans `findSpans` found in the own text, after the signature was removed. */
  contentFindings: number
}

/** The followed thread. */
export interface FollowedThread {
  id: string
  /** Every domain that took part in a filed entry (`mail_threads.participant_domains`). */
  participantDomains: readonly string[]
}

/** A `mail_thread_follows` row. */
export interface FollowRow {
  id: string
  userId: string
  createdAt: Date
  expiresAt: Date
  endedAt: Date | null
}

export type FollowEligibility =
  | { eligible: true; follow: FollowRow }
  | {
      eligible: false
      /** Every condition that failed, in condition order. */
      reasons: FollowIneligibilityReason[]
      /** The domains condition 5 found new, for the reason's copy. */
      newDomains: string[]
    }

export interface FollowEligibilityContext {
  now: Date
  /** The project addresses' domains (`piloti.at`), never counted as a participant. */
  ownDomains: readonly string[]
}

/**
 * Whether conditions 1–6 hold, and for which follow: the earliest active one,
 * because an append happens once, as the earliest follower.
 */
export function followEligibility(
  mail: FollowCandidateMail,
  thread: FollowedThread,
  follows: readonly FollowRow[],
  context: FollowEligibilityContext
): FollowEligibility {
  const follow = earliestActiveFollow(follows, mail.receivedAt, context.now)
  const newDomains = newParticipantDomains(mail, thread, context.ownDomains)
  const reasons: FollowIneligibilityReason[] = []
  if (!follow) reasons.push('no_active_follow')
  if (!VERIFIED_SENDER_TRUSTS.includes(mail.senderTrust)) reasons.push('sender_not_verified')
  if (!mail.match || mail.match.threadId !== thread.id || mail.match.strength !== 'reference')
    reasons.push('match_not_reference')
  else if (!signatureCovers(mail, mail.match)) reasons.push('header_not_signed')
  if (FOLLOW_REFUSING_FLAGS.some((flag) => mail.senderFlags.includes(flag))) reasons.push('flagged')
  if (mail.automatic) reasons.push('automatic')
  if (newDomains.length > 0) reasons.push('new_participant_domain')
  if (mail.subjectNameStops.length > 0) reasons.push('name_stop')
  if (mail.contentFindings > 0) reasons.push('content_finding')
  if (follow && reasons.length === 0) return { eligible: true, follow }
  return { eligible: false, reasons, newDomains }
}

/** The earliest follow that was active when the mail arrived and still is. */
export function earliestActiveFollow(follows: readonly FollowRow[], receivedAt: Date, now: Date): FollowRow | null {
  const active = follows.filter(
    (follow) =>
      follow.endedAt === null &&
      follow.expiresAt.getTime() > now.getTime() &&
      follow.createdAt.getTime() < receivedAt.getTime()
  )
  active.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
  return active[0] ?? null
}

/** Condition 3's signature half: the matched header, the four identity headers and every recipient header. */
function signatureCovers(mail: FollowCandidateMail, match: ThreadMatch): boolean {
  if (!restsOnSignedHeader(match, mail)) return false
  const signed = signedHeaderSet(mail)
  if (!FOLLOW_REQUIRED_SIGNED_HEADERS.every((header) => signed.has(header))) return false
  return mail.recipientHeaders.length > 0 && mail.recipientHeaders.every((header) => signed.has(header))
}

/** Condition 5: the From/To/Cc domains the thread has not seen, the project's own excluded, sorted. */
export function newParticipantDomains(
  mail: Pick<FollowCandidateMail, 'participantAddresses'>,
  thread: FollowedThread,
  ownDomains: readonly string[]
): string[] {
  const known = new Set([...thread.participantDomains, ...ownDomains].map((domain) => domain.toLowerCase()))
  const fresh = new Set<string>()
  for (const address of mail.participantAddresses) {
    const domain = domainOf(address)
    // An address without a domain is no participant anyone can vouch for.
    if (!domain) fresh.add('')
    else if (!known.has(domain)) fresh.add(domain)
  }
  return [...fresh].sort()
}
