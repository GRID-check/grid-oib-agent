/**
 * @vitest-environment node
 */
/**
 * Reading messages shaped like the clients that send them: Apple Mail's inline
 * PDFs and photos, Outlook's pasted images and Thread-Index, forwards as
 * attachments, S/MIME and PGP/MIME, scanners without names.
 */
import { describe, expect, it } from 'vitest'
import {
  attachment,
  BODY,
  bytes,
  cfb,
  exe,
  filePart,
  forwarded,
  jpeg,
  message,
  multipart,
  pdf,
  png,
  textPart,
  zipBomb,
  zipHeader,
} from './__fixtures__/hostile'
import {
  deliveryKey,
  MAX_FORWARD_DEPTH,
  MAX_STAGED_PARTS,
  parseDateHeader,
  rawHeaderFields,
  readMime,
  safeFilename,
  type MimeRead,
} from './mime'

const DEFAULT_ACCEPTED = ['.pdf', '.docx', '.txt', '.md', '.csv', '.xlsx', '.pptx']

async function read(raw: string | Uint8Array, acceptedTypes: readonly string[] = DEFAULT_ACCEPTED) {
  const result = await readMime(bytes(raw), { acceptedTypes })
  if (result.kind !== 'read') throw new Error(`unreadable: ${result.reason}`)
  return result
}

type Read = Extract<MimeRead, { kind: 'read' }>
const names = (mail: Read) => mail.attachments.map((part) => part.filename)
const skipped = (mail: Read) => mail.notStaged.map((part) => `${part.filename ?? '(nameless)'}:${part.reason}`)

describe('readMime: the headers', () => {
  it('reads thread headers, participants and a cleaned subject, never the body', async () => {
    const raw = message(BODY, {
      Subject: 'AW: WG: Einreichplan \u202Egnalp\r\n Teil 2',
      To: 'Projekt <wohnbau.abcdefgh2345@piloti.at>, Bauherr <Bauherr@Example.COM>',
      Cc: 'Statik: s1@statik-weber.at, s2@statik-weber.at;',
      'In-Reply-To': '<p1@x.at>',
      References: '<root@x.at> <p0@x.at>\r\n <p1@x.at>',
      'Reply-To': 'buero@buero-muster.at',
    })
    const mail = await read(raw)
    expect(mail.headers).toMatchObject({
      messageId: 'm1@buero-muster.at',
      inReplyTo: ['p1@x.at'],
      references: ['root@x.at', 'p0@x.at', 'p1@x.at'],
      subject: 'AW: WG: Einreichplan gnalp Teil 2',
      from: { name: 'Anna Muster', address: 'anna@buero-muster.at', domain: 'buero-muster.at' },
      recipientCount: 4,
    })
    expect(mail.headers.participants.map((p) => `${p.role}:${p.address}`)).toEqual([
      'from:anna@buero-muster.at',
      'reply_to:buero@buero-muster.at',
      'to:wohnbau.abcdefgh2345@piloti.at',
      'to:bauherr@example.com',
      'cc:s1@statik-weber.at',
      'cc:s2@statik-weber.at',
    ])
    expect(mail.headers.participantDomains).toEqual(['buero-muster.at', 'piloti.at', 'example.com', 'statik-weber.at'])
    expect(mail.headers.sentAtHeader?.toISOString()).toBe('2026-09-28T08:15:00.000Z')
  })

  it('keeps the root and the most recent references when a thread is long (the thread core\'s parser)', async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `<r${i}@x>`).join(' ')
    const mail = await read(message(BODY, { References: ids }))
    expect(mail.headers.references).toHaveLength(50)
    expect(mail.headers.references[0]).toBe('r0@x')
    expect(mail.headers.references.at(-1)).toBe('r79@x')
    expect(mail.headers.references[1]).toBe('r31@x')
  })

  it('takes the conversation GUID out of an Outlook Thread-Index', async () => {
    const index = Buffer.concat([Buffer.from([1, 2, 3, 4, 5, 6]), Buffer.from('00112233445566778899aabbccddeeff', 'hex'), Buffer.alloc(5, 9)])
    const mail = await read(message(BODY, { 'Thread-Index': index.toString('base64') }))
    expect(mail.headers.threadIndexGuid).toBe('00112233-4455-6677-8899-aabbccddeeff')
  })

  it('decodes an encoded display name and keeps it one line, never as evidence', async () => {
    const mail = await read(message(BODY, { From: '=?utf-8?Q?M=C3=BCller_=E2=80=AEBau?= <m@x.at>' }))
    expect(mail.headers.from).toEqual({ name: 'Müller Bau', address: 'm@x.at', domain: 'x.at' })
  })

  it('gives no From for a group or a list of two, and no Date for one that is not a date', async () => {
    const mail = await read(message(BODY, { From: 'a@x.at, b@y.at', Date: 'gestern' }))
    expect(mail.headers.from).toBeNull()
    expect(mail.headers.sentAtHeader).toBeNull()
  })
})

describe('header helpers', () => {
  it('parseDateHeader reads RFC 5322 dates with comments and refuses nonsense', () => {
    expect(parseDateHeader('Mon, 28 Sep 2026 10:15:00 +0200 (CEST)')?.toISOString()).toBe('2026-09-28T08:15:00.000Z')
    expect(parseDateHeader('Mon, 28 Sep 1900 10:15:00 +0200')).toBeNull()
    expect(parseDateHeader('')).toBeNull()
  })

  it('rawHeaderFields unfolds, keeps duplicates and order, and refuses a non-field line', () => {
    const fields = rawHeaderFields(bytes('Subject: a\r\n b\r\nTO: x\r\nto: y\r\n\r\nbody: no'))
    expect(fields).toEqual([
      { name: 'subject', value: ' a b' },
      { name: 'to', value: ' x' },
      { name: 'to', value: ' y' },
    ])
    expect(rawHeaderFields(bytes('Subject: a\r\nnot a field\r\n\r\n'))).toBeNull()
    expect(rawHeaderFields(bytes(' leading continuation\r\n\r\n'))).toBeNull()
  })
})

describe('deliveryKey', () => {
  it('is the same for a redelivery a relay prepended its own headers to', () => {
    const raw = message()
    const relayed = `Received: from mx2 by mx1; ${new Date().toUTCString()}\r\nARC-Seal: i=1; cv=none\r\n${raw}`
    expect(deliveryKey(bytes(relayed))).toBe(deliveryKey(bytes(raw)))
  })

  it('differs when what an author wrote differs: the body, the recipients, the Message-ID', () => {
    const key = deliveryKey(bytes(message()))
    expect(deliveryKey(bytes(message(textPart('text/plain', 'anders'))))).not.toBe(key)
    expect(deliveryKey(bytes(message(BODY, { Cc: 'x@y.at' })))).not.toBe(key)
    expect(deliveryKey(bytes(message(BODY, { 'Message-ID': '<m2@buero-muster.at>' })))).not.toBe(key)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('readMime: every part that names itself is a part', () => {
  it('stages Apple Mail inline PDFs and inline photos, in NFC, and decodes RFC 2231 and RFC 2047 names', async () => {
    const nfd = 'Pläne Geschoß.pdf'.normalize('NFD')
    const raw = message(
      multipart('mixed', [
        textPart('text/html', '<html><body>Anbei<img src="cid:9A1F@apple"></body></html>'),
        filePart('application/pdf', pdf('apple'), [`Content-Disposition: inline; filename*=utf-8''${encodeURIComponent(nfd)}`]),
        filePart('image/jpeg', jpeg(38 * 1024), ['Content-Disposition: inline; filename=IMG_4711.jpeg', 'Content-Id: <9A1F@apple>']),
        filePart('application/pdf', pdf('1'), [
          'Content-Disposition: attachment;',
          " filename*0*=UTF-8''Einreichplan%20Stra%C3%9Fenseite%20;",
          ' filename*1*=Rev%20C.pdf',
        ]),
        filePart('application/pdf', pdf('2'), ['Content-Disposition: attachment; filename="=?iso-8859-1?Q?Gr=FCnfl=E4chen_Nachweis.pdf?="']),
      ])
    )
    const mail = await read(raw, [...DEFAULT_ACCEPTED, '.jpeg'])
    expect(names(mail)).toEqual([
      'Pläne Geschoß.pdf'.normalize('NFC'),
      'IMG_4711.jpeg',
      'Einreichplan Straßenseite Rev C.pdf',
      'Grünflächen Nachweis.pdf',
    ])
    expect(mail.notStaged).toEqual([])
    expect(mail.attachments[0]).toMatchObject({ position: 1, extension: '.pdf', sniffedType: 'pdf', riskFlags: [], forwardDepth: 0 })
    expect(mail.attachments[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('stages text parts that carry a filename, which postal-mime would fold into the body', async () => {
    const raw = message(
      multipart('mixed', [
        BODY,
        textPart('text/plain', 'Pos 1  Beton  12 m3', ['Content-Disposition: inline; filename="Massenliste.txt"']),
        textPart('text/csv', 'x;y;z', ['Content-Disposition: inline; filename="Koordinaten.csv"']),
        textPart('text/html; name="Protokoll.html"', '<h1>Protokoll</h1>'),
      ])
    )
    const mail = await read(raw)
    expect(names(mail)).toEqual(['Massenliste.txt', 'Koordinaten.csv', 'Protokoll.html'])
    expect(Buffer.from(mail.attachments[0].content).toString()).toContain('Beton')
  })

  it('keeps a nameless part nameless, with the extension its bytes give, and stages unknown bytes as not accepted', async () => {
    const raw = message(
      multipart('mixed', [
        BODY,
        filePart('application/octet-stream', pdf('nameless'), ['Content-Disposition: attachment']),
        filePart('application/octet-stream', bytes('just some bytes, no magic'), ['Content-Disposition: attachment']),
      ])
    )
    const mail = await read(raw)
    expect(mail.attachments.map((part) => [part.filename, part.extension, part.riskFlags])).toEqual([
      [null, '.pdf', []],
      [null, null, ['type_not_accepted']],
    ])
  })
})

describe('readMime: what is not staged', () => {
  it('skips what mail clients paste into the HTML', async () => {
    const raw = message(
      multipart('related', [
        textPart('text/html', '<img src="cid:image001.png@01DB"><img src="cid:logo@x">'),
        filePart('image/png', png(45 * 1024), ['Content-Disposition: inline; filename="image001.png"', 'Content-ID: <image001.png@01DB>']),
        filePart('image/png', png(8 * 1024), ['Content-Disposition: inline', 'Content-ID: <logo@x>']),
        filePart('image/png', png(8 * 1024), ['Content-Disposition: inline; filename="Outlook-a1b2c3.png"']),
        filePart('image/png', png(8 * 1024), ['Content-Disposition: attachment; filename="~WRL0001.png"']),
        filePart('image/gif', bytes('GIF89a' + 'x'.repeat(40)), ['Content-Disposition: attachment; filename="pixel.gif"']),
      ])
    )
    expect(skipped(await read(raw))).toEqual([
      'image001.png:embedded',
      '(nameless):embedded',
      'Outlook-a1b2c3.png:embedded',
      '~WRL0001.png:embedded',
      'pixel.gif:embedded',
    ])
  })

  it('reports signatures, encryption, calendars, TNEF and empty parts by their codes', async () => {
    const signed = message(
      multipart(
        'signed',
        [
          multipart('mixed', [BODY, attachment('Plan.pdf', 'application/pdf', pdf('s'))]),
          filePart('application/pkcs7-signature; name="smime.p7s"', new Uint8Array(200).fill(1), ['Content-Disposition: attachment; filename="smime.p7s"']),
        ],
        '; protocol="application/pkcs7-signature"; micalg=sha-256'
      )
    )
    const signedMail = await read(signed)
    expect([names(signedMail), skipped(signedMail)]).toEqual([['Plan.pdf'], ['smime.p7s:signature']])

    const opaque = message(
      filePart('application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"', new Uint8Array(400).fill(2), [
        'Content-Disposition: attachment; filename="smime.p7m"',
      ])
    )
    expect(skipped(await read(opaque))).toEqual(['smime.p7m:encrypted'])

    const pgp = message(
      multipart(
        'encrypted',
        [
          { headers: ['Content-Type: application/pgp-encrypted'], body: 'Version: 1' },
          textPart('application/octet-stream; name="encrypted.asc"', '-----BEGIN PGP MESSAGE-----', ['Content-Disposition: inline; filename="encrypted.asc"']),
        ],
        '; protocol="application/pgp-encrypted"'
      )
    )
    const pgpMail = await read(pgp)
    expect([names(pgpMail), skipped(pgpMail)]).toEqual([[], ['(nameless):encrypted', 'encrypted.asc:encrypted']])

    const misc = message(
      multipart('mixed', [
        BODY,
        textPart('text/calendar; method=REQUEST', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR'),
        attachment('winmail.dat', 'application/ms-tnef', new Uint8Array(300).fill(3)),
        filePart('application/pdf', new Uint8Array(0), ['Content-Disposition: attachment; filename="Leer.pdf"']),
      ])
    )
    expect(skipped(await read(misc))).toEqual(['(nameless):calendar', 'winmail.dat:tnef', 'Leer.pdf:empty'])
  })

  it('never expands an archive the office does not accept, and stages it where the office does', async () => {
    const raw = message(multipart('mixed', [BODY, attachment('Plaene.zip', 'application/zip', zipBomb())]))
    const refused = await read(raw)
    expect(skipped(refused)).toEqual(['Plaene.zip:archive'])
    const accepted = await read(raw, [...DEFAULT_ACCEPTED, '.zip'])
    expect(names(accepted)).toEqual(['Plaene.zip'])
    expect(accepted.work.bytesSniffed).toBeLessThanOrEqual(256 * 1024)
  })
})

describe('readMime: risk flags', () => {
  it('flags an executable called .pdf as a type mismatch', async () => {
    const mail = await read(message(multipart('mixed', [BODY, attachment('Rechnung.pdf', 'application/pdf', exe())])))
    expect(mail.attachments[0]).toMatchObject({ sniffedType: 'exe', riskFlags: ['type_mismatch'] })
  })

  it('flags a password-protected .docx (a CFB container) as encrypted, not as a mismatch', async () => {
    const mail = await read(message(multipart('mixed', [BODY, attachment('Vertrag.docx', 'application/octet-stream', cfb())])))
    expect(mail.attachments[0].riskFlags).toEqual(['encrypted'])
  })

  it('flags an encrypted PDF and an encrypted zip', async () => {
    const raw = message(
      multipart('mixed', [
        BODY,
        attachment('Gesperrt.pdf', 'application/pdf', pdf('x', 'trailer << /Encrypt 5 0 R >>')),
        attachment('Gesperrt.zip', 'application/zip', zipHeader('a.txt', true)),
      ])
    )
    const mail = await read(raw, [...DEFAULT_ACCEPTED, '.zip'])
    expect(mail.attachments.map((part) => part.riskFlags)).toEqual([['encrypted'], ['encrypted']])
  })

  it('flags macros only where the office accepts the macro type; elsewhere the type is not accepted', async () => {
    const raw = message(multipart('mixed', [BODY, attachment('Kalkulation.xlsm', 'application/octet-stream', zipHeader('[Content_Types].xml'))]))
    expect((await read(raw)).attachments[0].riskFlags).toEqual(['type_not_accepted'])
    expect((await read(raw, [...DEFAULT_ACCEPTED, '.xlsm'])).attachments[0].riskFlags).toEqual(['macro'])
  })

  it('flags a binary called .txt, and leaves real text alone', async () => {
    const raw = message(multipart('mixed', [BODY, attachment('notes.txt', 'text/plain', pdf('x')), attachment('real.txt', 'text/plain', bytes('hello'))]))
    expect((await read(raw)).attachments.map((part) => part.riskFlags)).toEqual([['type_mismatch'], []])
  })
})

describe('readMime: forwarded mail', () => {
  const inner = message(multipart('mixed', [BODY, attachment('Bescheid_MA37.pdf', 'application/pdf', pdf('bescheid'))]), {
    From: 'Bauamt <ma37@wien.gv.at>',
    Subject: 'Bescheid',
    'Message-ID': '<inner@wien.gv.at>',
  })

  it.each([
    ['as an attachment', ['Content-Disposition: attachment; filename="Bescheid.eml"']],
    ['without a disposition', []],
  ])('opens a forward %s and stages its parts as forwarded_inner', async (_label, extra) => {
    const mail = await read(message(multipart('mixed', [BODY, forwarded(inner, extra)]), { Subject: 'WG: Bescheid' }))
    expect(names(mail)).toEqual(['Bescheid_MA37.pdf'])
    expect(mail.attachments[0]).toMatchObject({ forwardDepth: 1, riskFlags: ['forwarded_inner'] })
    expect(mail.headers.messageId).toBe('m1@buero-muster.at')
  })

  it(`opens forwards ${MAX_FORWARD_DEPTH} levels deep and no deeper`, async () => {
    let nested = inner
    for (let level = 0; level <= MAX_FORWARD_DEPTH; level += 1) {
      nested = message(multipart('mixed', [BODY, forwarded(nested)]), { 'Message-ID': `<level${level}@x>` })
    }
    const mail = await read(nested)
    expect(names(mail)).toEqual([])
    expect(skipped(mail)).toEqual(['(nameless):limit'])
    expect(mail.work.messagesParsed).toBe(MAX_FORWARD_DEPTH + 1)
  })
})

describe('readMime: names and the cap', () => {
  it('makes names distinct in one pass and stages the same bytes once', async () => {
    const attach = (name: string, tag: string) => attachment(name, 'application/pdf', pdf(tag))
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
    expect(names(await read(raw))).toEqual(['Plan.pdf', 'Plan (2).pdf', 'Plan (2) (2).pdf', 'Plan (3).pdf', 'Pläne.pdf', 'Pläne (2).pdf'])
  })

  it(`stops staging at ${MAX_STAGED_PARTS} parts and lists the rest as limit`, async () => {
    const parts = Array.from({ length: MAX_STAGED_PARTS + 3 }, (_, i) => attachment(`Plan ${i}.pdf`, 'application/pdf', pdf(`p${i}`)))
    const mail = await read(message(multipart('mixed', [BODY, ...parts])))
    expect(mail.attachments).toHaveLength(MAX_STAGED_PARTS)
    expect(skipped(mail)).toEqual([`Plan ${MAX_STAGED_PARTS}.pdf:limit`, `Plan ${MAX_STAGED_PARTS + 1}.pdf:limit`, `Plan ${MAX_STAGED_PARTS + 2}.pdf:limit`])
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
    ['Plan\r\nBcc: x@y.pdf', 'Plan Bcc_ x@y.pdf'],
    ['Plan\u0000.pdf', 'Plan .pdf'],
    ['CON.pdf', 'CON_.pdf'],
    ['nul.tar.gz', 'nul_.tar.gz'],
    ['a<b>c|d?.pdf', 'a_b_c_d_.pdf'],
  ])('makes %j safe as %j', (raw, safe) => {
    expect(safeFilename(raw)).toBe(safe)
  })

  it('cuts a long name between graphemes and keeps the extension', () => {
    const name = safeFilename(`${'x'.repeat(198)}🏗️🏗️ Plan.pdf`)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(200)
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })
})
