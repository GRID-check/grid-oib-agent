/**
 * How the waiting list is arranged: a conversation's mails grouped with one
 * button, unconfirmed and automatic mail in a quiet group at the end, and the
 * keyboard's order skipping the quiet group while it is closed.
 */

import { describe, expect, it } from 'vitest'
import { mail, summaryOf, thread } from '@/app/dev/inbound-mail/fixtures'
import { isQuietMail, listSections, visibleMails } from './list-sections'

const a = summaryOf(mail({ key: 'a' }))
const b = summaryOf(mail({ key: 'b', threadCandidates: [thread({ nextVersion: 4 })] }))
const unrelated = summaryOf(mail({ key: 'c', threadCandidates: [] }))
const unconfirmed = summaryOf(mail({ key: 'd', threadCandidates: [thread({ preselected: false, blocks: ['sender_not_verified'] })] }))
const stranger = summaryOf(mail({ key: 'e' }), { senderTrust: 'external_unverified' })
const robot = summaryOf(mail({ key: 'f' }), { automatic: true })

describe('listSections', () => {
  it('groups pre-selectable mails of one thread where the first of them stands', () => {
    const sections = listSections([unrelated, a, unconfirmed, b, stranger, robot], { grouped: true })
    expect(sections.map((section) => section.kind)).toEqual(['mail', 'thread', 'mail', 'quiet'])
    const group = sections[1]
    expect(group.kind === 'thread' && group.mails.map((mail) => mail.id)).toEqual([a.id, b.id])
    expect(group.kind === 'thread' && group.finalVersion).toBe(5)
  })

  it('never groups a mail that is not pre-selectable, nor a single mail', () => {
    expect(listSections([a, unconfirmed], { grouped: true }).map((section) => section.kind)).toEqual(['mail', 'mail'])
  })

  it('keeps the server’s order ungrouped for the handled list', () => {
    expect(listSections([a, b, stranger], { grouped: false }).map((section) => section.kind)).toEqual(['mail', 'mail', 'mail'])
  })
})

describe('visibleMails', () => {
  it('walks the quiet group only while it is open', () => {
    const sections = listSections([a, stranger, robot], { grouped: true })
    expect(visibleMails(sections, false).map((mail) => mail.id)).toEqual([a.id])
    expect(visibleMails(sections, true).map((mail) => mail.id)).toEqual([a.id, stranger.id, robot.id])
  })
})

describe('isQuietMail', () => {
  it('is quiet for an unconfirmed stranger and for a machine', () => {
    expect(isQuietMail(stranger)).toBe(true)
    expect(isQuietMail(robot)).toBe(true)
    expect(isQuietMail(a)).toBe(false)
  })
})
