/**
 * @vitest-environment node
 */
/**
 * Selection against messages shaped like the clients that send them (reviewer
 * B's fixtures, cut down to the bytes that matter): Apple Mail's inline PDFs
 * and photos, Outlook's pasted images, forwards as attachments, S/MIME and
 * PGP/MIME, scanners without names.
 */
import { describe, expect, it } from 'vitest'
import { cleanSubject, deliveryKey, MAX_FORWARD_DEPTH, parseMail, safeFilename } from './mime'

const PDF = (tag: string) => Buffer.from(`%PDF-1.7\n${tag}\n%%EOF\n`)
const PNG = (size: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size, 7),
  ])
const JPEG = (size: number) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, 9)])

interface Part {
  headers: string[]
  body: string
}

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/.{76}/g, '$&\r\n')

/** A leaf part carrying `bytes` in base64. */
function file(type: string, bytes: Buffer, extra: string[] = []): Part {
  return {
    headers: [`Content-Type: ${type}`, 'Content-Transfer-Encoding: base64', ...extra],
    body: b64(bytes),
  }
}

function text(type: string, body: string, extra: string[] = []): Part {
  return { headers: [`Content-Type: ${type}; charset=utf-8`, ...extra], body }
}

let boundaryCount = 0
function multipart(subtype: string, parts: Part[], params = ''): Part {
  boundaryCount += 1
  const boundary = `b${boundaryCount}`
  const body = [
    ...parts.flatMap((part) => [`--${boundary}`, ...part.headers, '', part.body]),
    `--${boundary}--`,
    '',
  ].join('\r\n')
  return { headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"${params}`], body }
}

function message(root: Part, headers: Record<string, string> = {}): string {
  const head = {
    From: 'Anna Berger <anna@buero-berger.at>',
    To: 'wohnbau.abcdefgh2345@piloti-post.at',
    Subject: 'Einreichplan',
    Date: 'Wed, 30 Sep 2026 10:15:00 +0200',
    'Message-ID': '<m1@buero-berger.at>',
    'MIME-Version': '1.0',
    ...headers,
  }
  return [
    ...Object.entries(head).map(([key, value]) => `${key}: ${value}`),
    ...root.headers,
    '',
    root.body,
  ].join('\r\n')
}

const BODY = text('text/plain', 'Hallo, anbei.')

async function parse(raw: string | Buffer, maxFiles = 100) {
  return parseMail(new Uint8Array(Buffer.from(raw)), { maxFiles })
}

async function selected(raw: string | Buffer, maxFiles = 100) {
  const mail = await parse(raw, maxFiles)
  return {
    files: mail.attachments.map((attachment) => attachment.filename),
    skipped: mail.skipped.map((entry) => `${entry.filename}:${entry.reason}`),
  }
}

describe('parseMail: the message', () => {
  it('reads the Message-ID, the sender name and a cleaned subject, never the body', async () => {
    const raw = message(
      multipart('mixed', [
        BODY,
        file('application/pdf', PDF('a'), ['Content-Disposition: attachment; filename="Plan.pdf"']),
      ]),
      {
        Subject: 'AW: WG: Einreichplan \u202Egnalp',
      }
    )
    const mail = await parse(raw)
    expect(mail.messageId).toBe('<m1@buero-berger.at>')
    expect(mail.fromName).toBe('Anna Berger')
    expect(mail.subject).toBe('Einreichplan gnalp')
    expect(mail.attachments).toHaveLength(1)
    expect(mail.attachments[0]).toMatchObject({
      filename: 'Plan.pdf',
      contentType: 'application/pdf',
    })
    expect(Buffer.from(mail.attachments[0].content).toString()).toContain('%PDF-1.7')
    expect(mail.attachments[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('decodes RFC 2231 continuations and RFC 2047 names (Thunderbird, Outlook)', async () => {
    const raw = message(
      multipart('mixed', [
        BODY,
        file('application/pdf', PDF('1'), [
          'Content-Disposition: attachment;',
          " filename*0*=UTF-8''Einreichplan%20Stra%C3%9Fenseite%20;",
          ' filename*1*=Rev%20C.pdf',
        ]),
        file('application/pdf', PDF('2'), [
          'Content-Disposition: attachment; filename="=?iso-8859-1?Q?Gr=FCnfl=E4chen_Nachweis.pdf?="',
        ]),
      ])
    )
    expect((await selected(raw)).files).toEqual([
      'Einreichplan Straßenseite Rev C.pdf',
      'Grünflächen Nachweis.pdf',
    ])
  })
})

describe('parseMail: every part that names itself is a file (B5, B10)', () => {
  it('files Apple Mail inline PDFs and inline photos, in NFC', async () => {
    const nfd = 'Pläne Geschoß.pdf'.normalize('NFD')
    const raw = message(
      multipart('mixed', [
        text('text/html', '<html><body>Anbei<img src="cid:9A1F@apple"></body></html>'),
        file('application/pdf', PDF('apple'), [
          `Content-Disposition: inline; filename*=utf-8''${encodeURIComponent(nfd)}`,
        ]),
        file('image/jpeg', JPEG(38 * 1024), [
          'Content-Disposition: inline; filename=IMG_4711.jpeg',
          'Content-Id: <9A1F@apple>',
        ]),
      ])
    )
    expect(await selected(raw)).toEqual({
      files: ['Pläne Geschoß.pdf'.normalize('NFC'), 'IMG_4711.jpeg'],
      skipped: [],
    })
  })

  it('files text parts that carry a filename, which postal-mime would fold into the body', async () => {
    const raw = message(
      multipart('mixed', [
        BODY,
        text('text/plain', 'Pos 1  Beton  12 m3', [
          'Content-Disposition: inline; filename="Massenliste.txt"',
        ]),
        text('text/csv', 'x;y;z', ['Content-Disposition: inline; filename="Koordinaten.csv"']),
        text('text/html; name="Protokoll.html"', '<h1>Protokoll</h1>'),
      ])
    )
    const mail = await parse(raw)
    expect(mail.attachments.map((attachment) => attachment.filename)).toEqual([
      'Massenliste.txt',
      'Koordinaten.csv',
      'Protokoll.html',
    ])
    expect(Buffer.from(mail.attachments[0].content).toString()).toContain('Beton')
  })

  it('names a nameless part by its bytes, and skips one nothing recognises (B15)', async () => {
    const raw = message(
      multipart('mixed', [
        BODY,
        file('application/octet-stream', PDF('nameless'), ['Content-Disposition: attachment']),
        file('application/octet-stream', Buffer.from('just some bytes, no magic'), [
          'Content-Disposition: attachment',
        ]),
      ])
    )
    const mail = await parse(raw)
    expect(mail.attachments.map((a) => [a.filename, a.contentType])).toEqual([
      ['Anhang.pdf', 'application/pdf'],
    ])
    expect(mail.skipped).toEqual([{ filename: 'Anhang', reason: 'unknown-type' }])
  })
})

describe('parseMail: embedded parts (B5)', () => {
  it('skips what mail clients paste into the HTML, by filename pattern', async () => {
    const raw = message(
      multipart('related', [
        text('text/html', '<img src="cid:image001.png@01DB"><img src="cid:logo@x">'),
        file('image/png', PNG(45 * 1024), [
          'Content-Disposition: inline; filename="image001.png"',
          'Content-ID: <image001.png@01DB>',
        ]),
        file('image/png', PNG(8 * 1024), ['Content-Disposition: inline', 'Content-ID: <logo@x>']),
        file('image/png', PNG(8 * 1024), [
          'Content-Disposition: inline; filename="Outlook-a1b2c3.png"',
        ]),
        file('image/png', PNG(8 * 1024), [
          'Content-Disposition: attachment; filename="~WRL0001.png"',
        ]),
        file('image/gif', Buffer.from('GIF89a' + 'x'.repeat(40)), [
          'Content-Disposition: attachment; filename="pixel.gif"',
        ]),
      ])
    )
    expect(await selected(raw)).toEqual({
      files: [],
      skipped: [
        'image001.png:embedded',
        'Anhang:embedded',
        'Outlook-a1b2c3.png:embedded',
        '~WRL0001.png:embedded',
        'pixel.gif:embedded',
      ],
    })
  })
})

describe('parseMail: forwarded mail (B6)', () => {
  const inner = message(
    multipart('mixed', [
      BODY,
      file('application/pdf', PDF('bescheid'), [
        'Content-Disposition: attachment; filename="Bescheid_MA37.pdf"',
      ]),
    ]),
    { From: 'Bauamt <ma37@wien.gv.at>', Subject: 'Bescheid', 'Message-ID': '<inner@wien.gv.at>' }
  )

  it.each([
    ['as an attachment', ['Content-Disposition: attachment; filename="Bescheid.eml"']],
    ['without a disposition', []],
  ])('opens a forward %s and files its attachments, never the .eml', async (_label, extra) => {
    const raw = message(
      multipart('mixed', [
        BODY,
        { headers: ['Content-Type: message/rfc822', ...extra], body: inner },
      ]),
      { Subject: 'WG: Bescheid' }
    )
    expect(await selected(raw)).toEqual({ files: ['Bescheid_MA37.pdf'], skipped: [] })
  })

  it(`opens forwards ${MAX_FORWARD_DEPTH} levels deep and no deeper`, async () => {
    let nested = inner
    for (let level = 0; level <= MAX_FORWARD_DEPTH; level += 1) {
      nested = message(
        multipart('mixed', [BODY, { headers: ['Content-Type: message/rfc822'], body: nested }]),
        {
          'Message-ID': `<level${level}@x>`,
        }
      )
    }
    expect(await selected(nested)).toEqual({ files: [], skipped: ['Weitergeleitet.eml:limit'] })
  })
})

describe('parseMail: the skip reasons (B10, B15)', () => {
  it('reports signatures, encryption, calendars, TNEF and empty parts by their codes', async () => {
    const signed = message(
      multipart(
        'signed',
        [
          multipart('mixed', [
            BODY,
            file('application/pdf', PDF('s'), [
              'Content-Disposition: attachment; filename="Plan.pdf"',
            ]),
          ]),
          file('application/pkcs7-signature; name="smime.p7s"', Buffer.alloc(200, 1), [
            'Content-Disposition: attachment; filename="smime.p7s"',
          ]),
        ],
        '; protocol="application/pkcs7-signature"; micalg=sha-256'
      )
    )
    expect(await selected(signed)).toEqual({
      files: ['Plan.pdf'],
      skipped: ['smime.p7s:signature'],
    })

    const opaque = message(
      file(
        'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
        Buffer.alloc(400, 2),
        ['Content-Disposition: attachment; filename="smime.p7m"']
      )
    )
    expect((await selected(opaque)).skipped).toEqual(['smime.p7m:encrypted'])

    const pgp = message(
      multipart(
        'encrypted',
        [
          { headers: ['Content-Type: application/pgp-encrypted'], body: 'Version: 1' },
          text('application/octet-stream; name="encrypted.asc"', '-----BEGIN PGP MESSAGE-----', [
            'Content-Disposition: inline; filename="encrypted.asc"',
          ]),
        ],
        '; protocol="application/pgp-encrypted"'
      )
    )
    expect(await selected(pgp)).toEqual({
      files: [],
      skipped: ['Anhang:encrypted', 'encrypted.asc:encrypted'],
    })

    const misc = message(
      multipart('mixed', [
        BODY,
        text('text/calendar; method=REQUEST', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR'),
        file('application/ms-tnef; name="winmail.dat"', Buffer.alloc(300, 3), [
          'Content-Disposition: attachment; filename="winmail.dat"',
        ]),
        file('application/pdf', Buffer.alloc(0), [
          'Content-Disposition: attachment; filename="Leer.pdf"',
        ]),
      ])
    )
    expect((await selected(misc)).skipped).toEqual([
      'Anhang:calendar',
      'winmail.dat:tnef',
      'Leer.pdf:empty',
    ])
  })
})

describe('parseMail: names and the cap (A4, A8, B12)', () => {
  it('makes names distinct in one pass and files the same bytes once', async () => {
    const attach = (name: string, tag: string) =>
      file('application/pdf', PDF(tag), [`Content-Disposition: attachment; filename="${name}"`])
    const raw = message(
      multipart('mixed', [
        BODY,
        attach('Plan.pdf', 'a'),
        attach('Plan.pdf', 'b'),
        attach('Plan.pdf', 'a'),
        attach('Plan (2).pdf', 'c'),
        attach('Plan.pdf', 'd'),
        attach('Pläne.pdf'.normalize('NFD'), 'e'),
        attach('Pläne.pdf', 'f'),
      ])
    )
    expect((await selected(raw)).files).toEqual([
      'Plan.pdf',
      'Plan (2).pdf',
      'Plan (2) (2).pdf',
      'Plan (3).pdf',
      'Pläne.pdf',
      'Pläne (2).pdf',
    ])
  })

  it('stops keeping at maxFiles and counts the rest as limit', async () => {
    const parts = Array.from({ length: 5 }, (_, i) =>
      file('application/pdf', PDF(`p${i}`), [
        `Content-Disposition: attachment; filename="Plan ${i}.pdf"`,
      ])
    )
    expect(await selected(message(multipart('mixed', [BODY, ...parts])), 2)).toEqual({
      files: ['Plan 0.pdf', 'Plan 1.pdf'],
      skipped: ['Plan 2.pdf:limit', 'Plan 3.pdf:limit', 'Plan 4.pdf:limit'],
    })
  })

  it('selects twenty thousand same-named parts in linear time', async () => {
    const parts = Array.from({ length: 20_000 }, (_, i) =>
      text('application/pdf', `x${i}`, ['Content-Disposition: attachment; filename="Plan.pdf"'])
    )
    const started = Date.now()
    const mail = await parse(message(multipart('mixed', parts)))
    expect(mail.attachments).toHaveLength(100)
    expect(mail.skipped).toHaveLength(19_900)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\anna\\..\\Plan.pdf', 'Plan.pdf'],
    ['Rechnung\u202Efdp.exe', 'Rechnungfdp.exe'],
    ['a\u200B.pdf', 'a.pdf'],
    ['x.pdf. ', 'x.pdf'],
    ['....', ''],
    ['..hidden.pdf', 'hidden.pdf'],
    ['Gr\uFFFDnd\uFFFDng.pdf', 'Gr_nd_ng.pdf'],
  ])('makes %j safe as %j', (raw, safe) => {
    expect(safeFilename(raw)).toBe(safe)
  })

  it('cuts a long name between graphemes and keeps the extension', () => {
    const name = safeFilename(`${'x'.repeat(198)}🏗️🏗️ Plan.pdf`)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(200)
    expect(Buffer.from(name).toString()).toBe(name)
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })
})

describe('cleanSubject (B13)', () => {
  it.each([
    ['AW: WG: Re: Fwd: Einreichplan', 'Einreichplan'],
    ['RE[2]: Plan', 'Plan'],
    ['Re:', null],
    ['Rechnung: Mai', 'Rechnung: Mai'],
    ['', null],
  ])('%j becomes %j', (raw, clean) => {
    expect(cleanSubject(raw)).toBe(clean)
  })

  it('cuts at 120 between graphemes', () => {
    const subject = cleanSubject(`${'x'.repeat(117)}🏗️ Baustelle`)
    expect(subject?.length).toBeLessThanOrEqual(120)
    expect(subject?.endsWith('…')).toBe(true)
    expect(subject).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })
})

describe('deliveryKey (B9)', () => {
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)

  it('normalizes the Message-ID and ignores digest order', () => {
    expect(deliveryKey('<ABC@Scanner>', [a, b])).toBe(deliveryKey(' abc@scanner ', [b, a]))
    expect(deliveryKey('<abc@scanner>', [a])).toMatch(/^[0-9a-f]{64}$/)
  })

  it('tells apart two scans that reuse one Message-ID', () => {
    expect(deliveryKey('<same@scanner>', [a])).not.toBe(deliveryKey('<same@scanner>', [b]))
  })

  it('falls back to the digests alone without a Message-ID', () => {
    expect(deliveryKey(null, [a, b])).toBe(deliveryKey('  ', [b, a]))
    expect(deliveryKey(null, [a])).not.toBe(deliveryKey('<x@y>', [a]))
  })
})
