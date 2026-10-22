/**
 * What the E-Mail-Eingang says about a sender, and what it asks before
 * filing. `senderNeedsAcknowledgement` restates the server's rule in
 * `lib/inbound-mail/decision.ts`; the table below is the C2 list, so the two
 * cannot drift without one of these rows failing.
 */

import { describe, expect, it } from 'vitest'
import type { InboundMailSenderView } from '@/lib/inbound-mail/inbound-mail-wire'
import {
  followOffered,
  revisionNeedsAcknowledgement,
  senderDisplayName,
  senderFlagLines,
  senderNeedsAcknowledgement,
  senderTone,
  senderTrustLine,
} from './sender'

const sender = (overrides: Partial<InboundMailSenderView> = {}): InboundMailSenderView => ({
  name: 'DI Petra Weber',
  address: 'p.weber@statik-weber.at',
  domain: 'statik-weber.at',
  signerDomain: 'statik-weber.at',
  trust: 'external_verified',
  reason: 'dkim_pass',
  flags: [],
  ...overrides,
})

describe('senderTrustLine', () => {
  it('names the signing domain, never the person', () => {
    expect(senderTrustLine(sender())).toEqual({ kind: 'verified', domain: 'statik-weber.at' })
  })

  it('says a member’s own Bcc copy', () => {
    expect(senderTrustLine(sender({ trust: 'member_verified', flags: ['not_addressed_to_project', 'bcc_own'] })).kind).toBe('bcc_own')
  })

  it('reserves „Gibt sich als … aus“ for a failed signature or a refusing policy', () => {
    expect(senderTrustLine(sender({ trust: 'member_unverified', reason: 'dkim_fail', signerDomain: null }))).toEqual({
      kind: 'impersonation',
      name: 'DI Petra Weber',
    })
    expect(senderTrustLine(sender({ trust: 'external_unverified', reason: 'dkim_policy', name: null })).kind).toBe('impersonation')
    expect(senderTrustLine(sender({ trust: 'member_unverified', reason: 'dkim_none', signerDomain: null })).kind).toBe('member_unverified')
    expect(senderTrustLine(sender({ trust: 'external_unverified', reason: 'dkim_none', signerDomain: null })).kind).toBe('unverified')
  })

  it('draws only the two cases a person must not miss as warnings', () => {
    expect(senderTone({ kind: 'verified', domain: 'x' })).toBe('confirmed')
    expect(senderTone({ kind: 'unverified' })).toBe('neutral')
    expect(senderTone({ kind: 'member_unverified' })).toBe('warning')
    expect(senderTone({ kind: 'impersonation', name: 'x' })).toBe('warning')
  })
})

describe('senderFlagLines', () => {
  it('says „addressed to others“ except for the member’s own Bcc copy', () => {
    expect(senderFlagLines(sender({ flags: ['not_addressed_to_project'] }))).toEqual(['not_addressed_to_project'])
    expect(senderFlagLines(sender({ trust: 'member_verified', flags: ['not_addressed_to_project', 'bcc_own'] }))).toEqual([])
  })

  it('says one date flag, the stale one first, and nothing for a reused Message-ID alone', () => {
    expect(senderFlagLines(sender({ flags: ['stale_date', 'date_out_of_range'] }))).toEqual(['stale_date'])
    expect(senderFlagLines(sender({ flags: ['message_id_reused'] }))).toEqual([])
    expect(senderFlagLines(sender({ flags: ['message_id_reused', 'already_filed'] }))).toEqual(['already_filed'])
  })
})

describe('senderNeedsAcknowledgement (C2, mirrors decision.ts)', () => {
  it.each<[string, Partial<InboundMailSenderView>, boolean]>([
    ['a confirmed stranger', {}, false],
    ['an unsigned stranger: labelled, never asked', { trust: 'external_unverified', reason: 'dkim_none' }, false],
    ['a member’s address without a signature', { trust: 'member_unverified', reason: 'dkim_none' }, true],
    ['a failed signature', { trust: 'external_unverified', reason: 'dkim_fail' }, true],
    ['a refusing policy', { trust: 'external_unverified', reason: 'dkim_policy' }, true],
    ['a mail addressed to others', { flags: ['not_addressed_to_project'] }, true],
    ['the member’s own Bcc copy', { trust: 'member_verified', flags: ['not_addressed_to_project', 'bcc_own'] }, false],
    ['a date more than seven days old', { flags: ['stale_date'] }, true],
    ['a date outside the clamp only', { flags: ['date_out_of_range'] }, false],
  ])('%s → %s', (_, overrides, expected) => {
    expect(senderNeedsAcknowledgement(sender(overrides))).toBe(expected)
  })
})

describe('revisionNeedsAcknowledgement (D11)', () => {
  it('asks wherever the sender keeps a thread from being pre-selected', () => {
    expect(revisionNeedsAcknowledgement(sender())).toBe(false)
    expect(revisionNeedsAcknowledgement(sender({ trust: 'external_unverified' }))).toBe(true)
    expect(revisionNeedsAcknowledgement(sender({ flags: ['date_out_of_range'] }))).toBe(true)
  })
})

describe('followOffered (D31 conditions 2 and 4)', () => {
  it('offers the follow only where a later reply could qualify', () => {
    expect(followOffered({ sender: sender(), automatic: false })).toBe(true)
    expect(followOffered({ sender: sender({ trust: 'member_verified' }), automatic: false })).toBe(true)
    expect(followOffered({ sender: sender({ trust: 'external_unverified' }), automatic: false })).toBe(false)
    expect(followOffered({ sender: sender({ trust: 'member_verified', flags: ['not_addressed_to_project', 'bcc_own'] }), automatic: false })).toBe(false)
    expect(followOffered({ sender: sender({ flags: ['message_id_reused'] }), automatic: false })).toBe(false)
    expect(followOffered({ sender: sender(), automatic: true })).toBe(false)
    expect(followOffered({ sender: null, automatic: false })).toBe(false)
  })
})

describe('senderDisplayName', () => {
  it('falls back to the local part of the address', () => {
    expect(senderDisplayName({ name: '  ', address: 'office@clean-shine.example' })).toBe('office')
    expect(senderDisplayName({ name: 'Jo', address: 'jo@example.com' })).toBe('Jo')
  })
})
