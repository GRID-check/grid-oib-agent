/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { INLINE_IMAGE_MAX_BYTES, parseMail, safeFilename } from './mime'

interface Part {
  type: string
  disposition?: 'attachment' | 'inline'
  filename?: string
  contentId?: string
  bytes: Buffer
}

/** A multipart/mixed message with a text body and the given parts. */
function message(parts: Part[], headers: Record<string, string> = {}): Uint8Array {
  const boundary = 'grid-boundary'
  const head = {
    From: 'Anna Muster <anna@buero-muster.at>',
    To: 'wohnbau.abcdefgh2345@piloti-post.at',
    Subject: 'Pläne',
    Date: 'Mon, 28 Sep 2026 10:15:00 +0200',
    'Message-ID': '<m1@buero-muster.at>',
    'MIME-Version': '1.0',
    'Content-Type': `multipart/mixed; boundary="${boundary}"`,
    ...headers,
  }
  const lines = Object.entries(head).map(([key, value]) => `${key}: ${value}`)
  lines.push('', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', 'Hallo, anbei die Pläne.')
  for (const part of parts) {
    lines.push(`--${boundary}`, `Content-Type: ${part.type}`, 'Content-Transfer-Encoding: base64')
    if (part.disposition) {
      lines.push(`Content-Disposition: ${part.disposition}${part.filename ? `; filename="${part.filename}"` : ''}`)
    }
    if (part.contentId) lines.push(`Content-ID: <${part.contentId}>`)
    lines.push('', part.bytes.toString('base64'))
  }
  lines.push(`--${boundary}--`, '')
  return new Uint8Array(Buffer.from(lines.join('\r\n')))
}

const pdf = (text: string) => Buffer.from(`%PDF-1.4 ${text}`)

describe('parseMail', () => {
  it('keeps real attachments and reads the headers the filing needs', async () => {
    const mail = await parseMail(
      message([{ type: 'application/pdf', disposition: 'attachment', filename: 'Grundriss.pdf', bytes: pdf('a') }])
    )
    expect(mail.messageId).toBe('<m1@buero-muster.at>')
    expect(mail.subject).toBe('Pläne')
    expect(mail.fromName).toBe('Anna Muster')
    expect(new Date(mail.dateHeader ?? '').toISOString()).toBe('2026-09-28T08:15:00.000Z')
    expect(mail.files.map((f) => f.filename)).toEqual(['Grundriss.pdf'])
    expect(Buffer.from(mail.files[0].bytes).toString()).toBe('%PDF-1.4 a')
    expect(mail.skipped).toEqual([])
  })

  it('skips a small inline image with a Content-ID (a signature logo)', async () => {
    const mail = await parseMail(
      message([
        { type: 'image/png', disposition: 'inline', filename: 'logo.png', contentId: 'logo@x', bytes: Buffer.alloc(2_000, 1) },
        { type: 'application/pdf', disposition: 'attachment', filename: 'Plan.pdf', bytes: pdf('b') },
      ])
    )
    expect(mail.files.map((f) => f.filename)).toEqual(['Plan.pdf'])
    expect(mail.skipped).toEqual([{ filename: 'logo.png', reason: 'inline' }])
  })

  it('keeps an inline image that is large, or that has no Content-ID (a photo, not a logo)', async () => {
    const mail = await parseMail(
      message([
        {
          type: 'image/jpeg',
          disposition: 'inline',
          filename: 'Baustelle.jpg',
          contentId: 'photo@x',
          bytes: Buffer.alloc(INLINE_IMAGE_MAX_BYTES + 1, 2),
        },
        { type: 'image/png', disposition: 'inline', filename: 'Skizze.png', bytes: Buffer.alloc(100, 3) },
      ])
    )
    expect(mail.files.map((f) => f.filename)).toEqual(['Baustelle.jpg', 'Skizze.png'])
  })

  it('skips winmail.dat and application/ms-tnef as tnef', async () => {
    const mail = await parseMail(
      message([
        { type: 'application/ms-tnef', disposition: 'attachment', filename: 'winmail.dat', bytes: Buffer.from('tnef') },
        { type: 'application/octet-stream', disposition: 'attachment', filename: 'WINMAIL.DAT', bytes: Buffer.from('tnef') },
        { type: 'application/vnd.ms-tnef', disposition: 'attachment', filename: 'x.bin', bytes: Buffer.from('tnef') },
      ])
    )
    expect(mail.files).toEqual([])
    expect(mail.skipped.map((s) => s.reason)).toEqual(['tnef', 'tnef', 'tnef'])
  })

  it('skips a zero-byte part', async () => {
    const mail = await parseMail(
      message([{ type: 'application/pdf', disposition: 'attachment', filename: 'leer.pdf', bytes: Buffer.alloc(0) }])
    )
    expect(mail.files).toEqual([])
    expect(mail.skipped).toEqual([{ filename: 'leer.pdf', reason: 'empty' }])
  })

  it('numbers duplicate filenames within one mail', async () => {
    const mail = await parseMail(
      message([
        { type: 'application/pdf', disposition: 'attachment', filename: 'Plan.pdf', bytes: pdf('1') },
        { type: 'application/pdf', disposition: 'attachment', filename: 'Plan.pdf', bytes: pdf('2') },
        { type: 'application/pdf', disposition: 'attachment', filename: 'plan.PDF', bytes: pdf('3') },
      ])
    )
    expect(mail.files.map((f) => f.filename)).toEqual(['Plan.pdf', 'Plan (2).pdf', 'plan (3).PDF'])
  })

  it('reads a message without a Message-ID as having none', async () => {
    const raw = Buffer.from(
      ['From: a@b.at', 'Subject: x', 'Content-Type: text/plain', '', 'body', ''].join('\r\n')
    )
    const mail = await parseMail(new Uint8Array(raw))
    expect(mail.messageId).toBeNull()
    expect(mail.files).toEqual([])
  })
})

describe('safeFilename', () => {
  it('keeps the last path segment and strips control characters', () => {
    expect(safeFilename('C:\\Users\\anna\\Plan.pdf', 'application/pdf')).toBe('Plan.pdf')
    expect(safeFilename('../../etc/passwd', 'text/plain')).toBe('passwd')
    expect(safeFilename('Pl\u0000an\u001f.pdf', 'application/pdf')).toBe('Plan.pdf')
  })

  it('names a nameless part from its type', () => {
    expect(safeFilename(null, 'application/pdf')).toBe('Anhang.pdf')
    expect(safeFilename('', 'application/x-unknown')).toBe('Anhang')
  })

  it('bounds a long name and keeps its extension', () => {
    const name = safeFilename(`${'x'.repeat(400)}.pdf`, 'application/pdf')
    expect(name.length).toBe(200)
    expect(name.endsWith('.pdf')).toBe(true)
  })
})
