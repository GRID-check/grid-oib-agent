/**
 * mailThread namespace: the E-Mail-Verlauf, one conversation filed as one
 * document (ADR-0134). The „Mails“ tab, following and detaching (D16) add to
 * it; the closed code lists of `lib/mail-thread` are worded here so every
 * surface says them the same way.
 *
 * The rendition's own words (section headings, „received …“, „quoted in the
 * mail of …“) are NOT here: they live in `lib/mail-thread/render-copy.ts`,
 * versioned, because changing them would rewrite every thread's sections.
 */
export const mailThread = {
  /** Why a reply's text waited although someone follows the mail thread (`FOLLOW_INELIGIBILITY_REASONS`). */
  followIneligible: {
    no_active_follow: 'Nobody follows this mail thread',
    sender_not_verified: 'The sender’s domain is not verified',
    match_not_reference: 'The mail does not refer to a mail of this mail thread',
    header_not_signed: 'The reference to the mail thread is not signed by the domain',
    flagged: 'The mail is addressed to others, or its date is not plausible',
    automatic: 'The mail was sent automatically',
    new_participant_domain: 'New participants: {domains}',
    name_stop: 'The name check stopped the subject',
    content_finding: 'The content check found something in the text',
  },
  /** Why a follow ended (`MAIL_THREAD_FOLLOW_END_REASONS`). */
  followEnd: {
    unfollowed: 'You stopped following',
    expired: 'The follow ran out',
    access_lost: 'Access to the mail thread was lost',
    address_rotated: 'The project mail address was replaced',
    detached: 'A mail was detached from the mail thread',
    document_gone: 'The mail thread was deleted',
    revoked_by_manager: 'Ended by a project manager',
  },
}
