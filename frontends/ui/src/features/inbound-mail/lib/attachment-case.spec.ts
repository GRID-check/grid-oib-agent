/**
 * Each attachment's case (DECISION §9, the case table): offered checked only
 * when filing it asks nothing of the person; otherwise unchecked with its
 * reason, or not offered at all.
 */

import { describe, expect, it } from 'vitest'
import { mail, part } from '@/app/dev/inbound-mail/fixtures'
import { attachmentCase, notStagedSummary } from './attachment-case'

const view = mail()

describe('attachmentCase', () => {
  it('offers a clean, accepted, unflagged part checked', () => {
    const entry = attachmentCase(part({ name: 'a.pdf' }), view)
    expect(entry).toMatchObject({ status: 'waiting', selectable: true, defaultChecked: true, risk: null, previewable: true })
  })

  it.each<[string, Parameters<typeof part>[0], { status: string; selectable: boolean; defaultChecked: boolean }]>([
    ['scan pending', { scan: 'pending' }, { status: 'scan_pending', selectable: false, defaultChecked: false }],
    ['scan failed', { scan: 'failed' }, { status: 'scan_failed', selectable: false, defaultChecked: false }],
    ['infected', { scan: 'infected' }, { status: 'scan_infected', selectable: false, defaultChecked: false }],
    ['type not accepted', { offered: false, riskFlags: ['type_not_accepted'] }, { status: 'not_offered', selectable: false, defaultChecked: false }],
    ['identical bytes in the project', { duplicateOf: { documentId: 'd', name: 'a.pdf', folderPath: 'A' } }, { status: 'waiting', selectable: true, defaultChecked: false }],
    ['name stop', { riskFlags: ['name_stop'], nameStopTerms: ['Honorar'] }, { status: 'waiting', selectable: true, defaultChecked: false }],
    ['macro', { riskFlags: ['macro'] }, { status: 'waiting', selectable: true, defaultChecked: false }],
    ['type mismatch', { riskFlags: ['type_mismatch'] }, { status: 'waiting', selectable: true, defaultChecked: false }],
    ['a picture pasted into the mail', { filename: null, contentType: 'image/png' }, { status: 'waiting', selectable: true, defaultChecked: false }],
    ['filed', { state: 'filed' }, { status: 'filed', selectable: false, defaultChecked: false }],
    ['dismissed', { state: 'dismissed' }, { status: 'dismissed', selectable: false, defaultChecked: false }],
  ])('%s', (_, overrides, expected) => {
    expect(attachmentCase(part(overrides), view)).toMatchObject(expected)
  })

  it('offers a Fassung checked from a confirmed sender, unchecked from one that cannot vouch (D11)', () => {
    const revisionCandidate = { documentId: 'd', name: 'S-101_B.pdf', folderPath: 'Tragwerk', nextVersion: 3 }
    expect(attachmentCase(part({ revisionCandidate }), view).defaultChecked).toBe(true)
    const unverified = mail({ sender: { ...view.sender!, trust: 'external_unverified', reason: 'dkim_none', signerDomain: null } })
    const entry = attachmentCase(part({ revisionCandidate }), unverified)
    expect(entry.defaultChecked).toBe(false)
    expect(entry.notes).toContainEqual(expect.objectContaining({ kind: 'revision', verified: false }))
    expect(attachmentCase(part({ revisionCandidate, riskFlags: ['unverified_thread'] }), view).defaultChecked).toBe(false)
  })

  it('offers nothing in a closed project', () => {
    expect(attachmentCase(part(), mail({ projectClosed: true }))).toMatchObject({ selectable: false, defaultChecked: false })
  })

  it('draws a thumbnail only for a clean picture or PDF (RT-S19)', () => {
    expect(attachmentCase(part({ contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), view).previewable).toBe(false)
    expect(attachmentCase(part({ contentType: 'image/png', scan: 'pending' }), view).previewable).toBe(false)
    expect(attachmentCase(part({ contentType: 'image/jpeg' }), view).previewable).toBe(true)
  })
})

describe('notStagedSummary', () => {
  it('lists what is only in the original and counts layout images', () => {
    expect(
      notStagedSummary([
        { filename: 'winmail.dat', reason: 'tnef' },
        { filename: 'a.zip', reason: 'archive' },
        { filename: 'logo.png', reason: 'embedded' },
        { filename: 'smime.p7s', reason: 'signature' },
        { filename: 'empty.txt', reason: 'empty' },
      ])
    ).toEqual({
      listed: [
        { filename: 'winmail.dat', reason: 'tnef' },
        { filename: 'a.zip', reason: 'archive' },
      ],
      layoutImages: 1,
    })
  })
})
