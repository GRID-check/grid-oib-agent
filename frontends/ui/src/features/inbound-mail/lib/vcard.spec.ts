/**
 * „Als Kontakt sichern“: a vCard 4.0 a phone imports, escaped and folded as
 * RFC 6350 says.
 */

import { describe, expect, it } from 'vitest'
import { contactCard, contactCardFileName } from './vcard'

describe('contactCard', () => {
  it('writes a vCard 4.0 with CRLF line ends', () => {
    const card = contactCard({ name: 'Piloti · Bauplatz 12', address: 'bauplatz-12.k3x7q2m9p4ab@piloti.at' })
    expect(card.startsWith('BEGIN:VCARD\r\nVERSION:4.0\r\n')).toBe(true)
    expect(card).toContain('FN:Piloti · Bauplatz 12\r\n')
    expect(card).toContain('EMAIL;TYPE=work:bauplatz-12.k3x7q2m9p4ab@piloti.at\r\n')
    expect(card.endsWith('END:VCARD\r\n')).toBe(true)
  })

  it('escapes commas, semicolons, backslashes and newlines (§3.4)', () => {
    const card = contactCard({ name: 'A, B; C\\D', address: 'a@b.at', note: 'one\ntwo' })
    expect(card).toContain(String.raw`FN:A\, B\; C\\D`)
    expect(card).toContain('NOTE:one\\ntwo')
  })

  it('folds lines past 75 octets without splitting a character (§3.2)', () => {
    const card = contactCard({ name: 'Ä'.repeat(60), address: 'a@b.at' })
    const encoder = new TextEncoder()
    for (const line of card.split('\r\n')) expect(encoder.encode(line).length).toBeLessThanOrEqual(75)
    expect(card).toContain('\r\n ')
    expect(card.replace(/\r\n /g, '')).toContain(`FN:${'Ä'.repeat(60)}`)
  })
})

describe('contactCardFileName', () => {
  it('is a latin slug of the project', () => {
    expect(contactCardFileName('Bauplatz 12 – Wohnbau Seestadt')).toBe('piloti-bauplatz-12-wohnbau-seestadt.vcf')
    expect(contactCardFileName('工程')).toMatch(/^piloti-.+\.vcf$/)
  })
})
