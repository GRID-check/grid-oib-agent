/**
 * „Als Kontakt sichern“: the project's mail address as a contact card
 * (RFC 6350, vCard 4.0), so forwarding from a phone's mail app is one tap on
 * a name instead of typing a 30-character token.
 *
 * Pure: the text and its file name. The browser download is the caller's.
 */

import { fileSlug } from '@/lib/text/latinize'

/** RFC 6350 §3.4: backslash, comma, semicolon and newlines are escaped in a text value. */
function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\r\n|\r|\n/g, '\\n')
}

/** RFC 6350 §3.2: a line longer than 75 octets continues on the next, after CRLF and one space. */
function fold(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line
  const out: string[] = []
  let current = ''
  for (const char of line) {
    const limit = out.length === 0 ? 75 : 74
    if (encoder.encode(current + char).length > limit) {
      out.push(current)
      current = char
    } else {
      current += char
    }
  }
  out.push(current)
  return out.join('\r\n ')
}

export interface ContactCard {
  /** The contact's name as the phone lists it („Piloti · Bauplatz 12“). */
  name: string
  address: string
  /** One line in the card's note: what the address is for. */
  note?: string
}

export function contactCard({ name, address, note }: ContactCard): string {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:4.0',
    `FN:${escapeText(name)}`,
    'KIND:individual',
    `EMAIL;TYPE=work:${escapeText(address)}`,
    ...(note ? [`NOTE:${escapeText(note)}`] : []),
    'END:VCARD',
  ]
  return `${lines.map(fold).join('\r\n')}\r\n`
}

/** The file name the card downloads as. */
export function contactCardFileName(projectName: string): string {
  return `piloti-${fileSlug(projectName, { maxLength: 60 }) || 'project'}.vcf`
}
