/**
 * @vitest-environment node
 */
/**
 * „Verlauf folgen“, conditions 1–6 of DECISION D31. One mail meets every
 * condition; each case breaks exactly one, and the mail must then wait with
 * exactly that reason. Conditions 7–9 need the database and are the follow
 * job's (`follow.integration.spec.ts`).
 */

import { describe, expect, it } from 'vitest'
import {
  FOLLOW_REFUSING_FLAGS,
  followEligibility,
  newParticipantDomains,
  type FollowCandidateMail,
  type FollowedThread,
  type FollowIneligibilityReason,
  type FollowRow,
} from './follow-eligibility'

const DAY = 86_400_000
const NOW = new Date('2026-10-14T07:15:00Z')
const THREAD_ID = '00000000-0000-4000-8000-0000000000aa'

const thread: FollowedThread = {
  id: THREAD_ID,
  participantDomains: ['berger-architektur.at', 'statik-weber.at', 'ma37.wien.gv.at'],
}

const follow: FollowRow = {
  id: 'follow-1',
  userId: 'user_01HZXYZABCDEFGHJKMNPQRSTVW',
  createdAt: new Date(NOW.getTime() - 10 * DAY),
  expiresAt: new Date(NOW.getTime() + 50 * DAY),
  endedAt: null,
}

/** A reply that meets all six conditions. */
function mail(overrides: Partial<FollowCandidateMail> = {}): FollowCandidateMail {
  return {
    receivedAt: new Date(NOW.getTime() - 60_000),
    senderTrust: 'external_verified',
    senderFlags: [],
    signedHeaders: ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'in-reply-to', 'references'],
    automatic: false,
    recipientHeaders: ['to', 'cc'],
    participantAddresses: [
      'weber@statik-weber.at',
      'berger@berger-architektur.at',
      'Huber@MA37.wien.gv.at',
      'bauplatz-12.k3x7q2m9p4ab@piloti.at',
    ],
    match: { threadId: THREAD_ID, strength: 'reference', headers: ['in-reply-to', 'references'] },
    subjectNameStops: [],
    contentFindings: 0,
    ...overrides,
  }
}

const context = { now: NOW, ownDomains: ['piloti.at'] }

function reasons(candidate: FollowCandidateMail, follows: FollowRow[] = [follow]): FollowIneligibilityReason[] {
  const result = followEligibility(candidate, thread, follows, context)
  return result.eligible ? [] : result.reasons
}

describe('followEligibility', () => {
  it('lets a reply that meets every condition join, as the follow', () => {
    expect(followEligibility(mail(), thread, [follow], context)).toEqual({ eligible: true, follow })
  })

  describe('1. an active follow, older than the mail', () => {
    it.each<[string, FollowRow[]]>([
      ['no follow', []],
      ['an ended follow', [{ ...follow, endedAt: new Date(NOW.getTime() - DAY) }]],
      ['an expired follow', [{ ...follow, expiresAt: new Date(NOW.getTime() - 1) }]],
      ['a follow that expires now', [{ ...follow, expiresAt: NOW }]],
      ['a follow started after the mail arrived', [{ ...follow, createdAt: new Date(NOW.getTime() - 1) }]],
      ['a follow started the instant the mail arrived', [{ ...follow, createdAt: mail().receivedAt }]],
    ])('fails alone with %s', (_case, follows) => {
      expect(reasons(mail(), follows)).toEqual(['no_active_follow'])
    })

    it('appends as the earliest of several active followers', () => {
      const later = { ...follow, id: 'follow-2', createdAt: new Date(NOW.getTime() - 2 * DAY) }
      const earliest = { ...follow, id: 'follow-0', createdAt: new Date(NOW.getTime() - 20 * DAY) }
      const ended = { ...follow, id: 'follow-x', createdAt: new Date(NOW.getTime() - 30 * DAY), endedAt: NOW }
      const result = followEligibility(mail(), thread, [later, ended, earliest, follow], context)
      expect(result).toEqual({ eligible: true, follow: earliest })
    })
  })

  describe('2. a verified domain', () => {
    it.each(['member_unverified', 'external_unverified', 'not_checked'] as const)('fails alone for %s', (trust) => {
      expect(reasons(mail({ senderTrust: trust }))).toEqual(['sender_not_verified'])
    })

    it('holds for a verified member', () => {
      expect(reasons(mail({ senderTrust: 'member_verified' }))).toEqual([])
    })
  })

  describe('3. a signed reference to this thread', () => {
    it.each<[string, Partial<FollowCandidateMail>]>([
      ['no match', { match: null }],
      ['a match to another thread', { match: { threadId: 'other', strength: 'reference', headers: ['references'] } }],
      ['a Thread-Index match', { match: { threadId: THREAD_ID, strength: 'thread_index', headers: ['thread-index'] } }],
      ['a subject match', { match: { threadId: THREAD_ID, strength: 'subject', headers: ['subject'] } }],
      [
        'a reference under a changed subject',
        { match: { threadId: THREAD_ID, strength: 'reference_subject_changed', headers: ['references'] } },
      ],
    ])('fails alone with %s', (_case, overrides) => {
      expect(reasons(mail(overrides))).toEqual(['match_not_reference'])
    })

    it.each([
      ['References and In-Reply-To added outside h=', ['from', 'to', 'cc', 'subject', 'date', 'message-id']],
      ['an unsigned From', ['to', 'cc', 'subject', 'date', 'message-id', 'in-reply-to', 'references']],
      ['an unsigned Subject', ['from', 'to', 'cc', 'date', 'message-id', 'in-reply-to']],
      ['an unsigned Date', ['from', 'to', 'cc', 'subject', 'message-id', 'in-reply-to']],
      ['an unsigned Message-ID', ['from', 'to', 'cc', 'subject', 'date', 'in-reply-to']],
      ['an unsigned To', ['from', 'cc', 'subject', 'date', 'message-id', 'in-reply-to']],
      ['an unsigned Cc the mail carries', ['from', 'to', 'subject', 'date', 'message-id', 'in-reply-to']],
    ])('fails alone with %s', (_case, signedHeaders) => {
      expect(reasons(mail({ signedHeaders }))).toEqual(['header_not_signed'])
    })

    it('holds when only one of the matched headers is signed', () => {
      expect(reasons(mail({ signedHeaders: ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'references'] }))).toEqual(
        []
      )
    })

    it('does not ask for a Cc the mail does not carry', () => {
      const signedHeaders = ['from', 'to', 'subject', 'date', 'message-id', 'in-reply-to']
      expect(reasons(mail({ recipientHeaders: ['to'], signedHeaders }))).toEqual([])
    })

    it('fails alone without any recipient header', () => {
      expect(reasons(mail({ recipientHeaders: [] }))).toEqual(['header_not_signed'])
    })
  })

  describe('4. no refusing flag, not automatic', () => {
    it.each(FOLLOW_REFUSING_FLAGS)('fails alone with %s', (flag) => {
      expect(reasons(mail({ senderFlags: [flag] }))).toEqual(['flagged'])
    })

    it('fails alone for a member’s own Bcc copy, which is never followable', () => {
      expect(
        reasons(mail({ senderTrust: 'member_verified', senderFlags: ['not_addressed_to_project', 'bcc_own'] }))
      ).toEqual(['flagged'])
    })

    it('fails alone for automatic mail', () => {
      expect(reasons(mail({ automatic: true }))).toEqual(['automatic'])
    })

    it('ignores a flag that refuses nothing', () => {
      expect(reasons(mail({ senderFlags: ['something_else'] }))).toEqual([])
    })
  })

  describe('5. no new participant domain', () => {
    it('fails alone when a new domain joins, and names it', () => {
      const result = followEligibility(
        mail({ participantAddresses: [...mail().participantAddresses, 'neu@extern-bau.at'] }),
        thread,
        [follow],
        context
      )
      expect(result).toEqual({ eligible: false, reasons: ['new_participant_domain'], newDomains: ['extern-bau.at'] })
    })

    it('counts a subdomain as new', () => {
      expect(reasons(mail({ participantAddresses: ['x@post.statik-weber.at'] }))).toEqual(['new_participant_domain'])
    })

    it('fails alone for an address without a domain', () => {
      expect(reasons(mail({ participantAddresses: ['undisclosed-recipients'] }))).toEqual(['new_participant_domain'])
    })

    it('never counts the project’s own address', () => {
      expect(newParticipantDomains({ participantAddresses: ['a@PILOTI.at'] }, thread, ['piloti.at'])).toEqual([])
    })
  })

  describe('6. nothing for the name or content check', () => {
    it('fails alone when the subject holds a stopped term', () => {
      expect(reasons(mail({ subjectNameStops: ['Honorar'] }))).toEqual(['name_stop'])
    })

    it('fails alone when the own text holds a finding', () => {
      expect(reasons(mail({ contentFindings: 1 }))).toEqual(['content_finding'])
    })
  })

  it('reports every failing condition, in order', () => {
    expect(
      reasons(mail({ senderTrust: 'external_unverified', automatic: true, contentFindings: 2, match: null }), [])
    ).toEqual(['no_active_follow', 'sender_not_verified', 'match_not_reference', 'automatic', 'content_finding'])
  })
})
