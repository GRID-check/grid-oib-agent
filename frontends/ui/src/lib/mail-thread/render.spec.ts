/**
 * @vitest-environment node
 */
/**
 * The E-Mail-Verlauf rendition (DECISION D11, D12, D13, D34; RT-S2, RT-S13).
 *
 * Golden files pin the bytes (`__golden__/`; a deliberate change to the
 * format updates them with `-u` and bumps `MAIL_THREAD_RENDER_VERSION`). The
 * rest holds the properties the bytes must keep: the superset invariant with
 * detach as its one exception, honest headings, the clamp, quotes labelled by
 * the message that kept them, masked spans, and that nothing a stranger wrote
 * becomes a section, for CommonMark or for the knowledge layer's chunker
 * (`@/test-utils/markdown-chunker`).
 */

import { chunkerReads } from '@/test-utils/markdown-chunker'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import {
  entryHeadingBase,
  mailThreadEntryHeading,
  MailThreadRenderError,
  renderMailThread,
  sectionAttachment,
  type MailThreadAttachmentFiling,
  type MailThreadHeadingFields,
  type MailThreadRenderEntry,
  type MailThreadRenderInput,
} from './render'
import { MAIL_THREAD_RENDER_COPY } from './render-copy'

const at = (iso: string) => new Date(iso)

type EntryInput = Omit<MailThreadRenderEntry, 'heading'> & { heading?: string }

/** An entry with its heading made the way the filing job makes it. */
function entry(input: Partial<EntryInput> & Pick<EntryInput, 'id' | 'sentAt'>, taken: string[] = []): MailThreadRenderEntry {
  const fields: Omit<MailThreadRenderEntry, 'heading'> = {
    source: 'inbound',
    receivedAt: new Date(input.sentAt.getTime() + 120_000),
    filedAt: new Date(input.sentAt.getTime() + 3_600_000),
    senderName: 'DI Eva Berger',
    senderAddress: 'berger@berger-architektur.at',
    senderDomain: 'berger-architektur.at',
    signerDomain: 'berger-architektur.at',
    senderTrust: 'member_verified',
    inReplyToEntryId: null,
    participants: [],
    ownText: 'Text.',
    maskedSpans: null,
    quoted: [],
    calendar: [],
    attachments: [],
    ...input,
  }
  return { ...fields, heading: input.heading ?? mailThreadEntryHeading(fields, taken, 'de') }
}

const BERGER_TEXT =
  'Sehr geehrte Frau Mag. Huber,\r\n\r\nanbei der Stellplatznachweis für Bauplatz 12.\r\nBitte überweisen Sie die Gebühr nicht auf AT61 1904 3002 3457 3201.\r\n\r\nMit freundlichen Grüßen\r\nEva Berger'
const IBAN_AT = BERGER_TEXT.indexOf('AT61')

const BERGER = entry({
  id: '00000000-0000-4000-8000-000000000001',
  sentAt: at('2026-10-02T08:15:00Z'),
  participants: [
    { role: 'from', name: 'DI Eva Berger', address: 'berger@berger-architektur.at' },
    { role: 'to', name: 'Mag. Anna Huber', address: 'huber@ma37.wien.gv.at' },
    { role: 'cc', name: 'DI Max Weber', address: 'weber@statik-weber.at' },
    { role: 'cc', name: null, address: 'office@statik-weber.at' },
  ],
  ownText: BERGER_TEXT,
  maskedSpans: [{ kind: 'iban', start: IBAN_AT, end: IBAN_AT + 'AT61 1904 3002 3457 3201'.length }],
  attachments: [{ name: 'Stellplatznachweis_B.pdf', folderPath: '/Behörde' }],
})

const WEBER_TEXT = 'Die Tiefgarage trägt die geforderten zwölf Stellplätze ohne Verstärkung der Decke.'

const HUBER = entry({
  id: '00000000-0000-4000-8000-000000000002',
  sentAt: at('2026-10-14T07:12:00Z'),
  receivedAt: at('2026-10-14T07:14:00Z'),
  senderName: 'Mag. Anna Huber',
  senderAddress: 'huber@ma37.wien.gv.at',
  senderDomain: 'ma37.wien.gv.at',
  signerDomain: 'ma37.wien.gv.at',
  senderTrust: 'external_verified',
  inReplyToEntryId: BERGER.id,
  participants: [{ role: 'to', name: 'DI Eva Berger', address: 'berger@berger-architektur.at' }],
  ownText: 'Die Anzahl der Pflichtstellplätze ist bis 24.10.2026 nachzureichen.',
  quoted: [{ text: `Am 30.09.2026 schrieb DI Max Weber:\n> ${WEBER_TEXT}` }],
  calendar: [
    {
      method: 'REQUEST',
      summary: 'Bauverhandlung',
      start: '2026-11-12T08:00:00Z',
      end: '2026-11-12T10:00:00Z',
      allDay: false,
      location: 'MA 37, Dresdner Straße 73',
      status: 'CONFIRMED',
    },
  ],
})

const FORGER = entry({
  id: '00000000-0000-4000-8000-000000000003',
  sentAt: at('2026-10-15T09:00:00Z'),
  senderName: 'Mag. Anna Huber (ma37.wien.gv.at)',
  senderAddress: 'huber@ma37-wien.at',
  senderDomain: 'ma37-wien.at',
  signerDomain: null,
  senderTrust: 'external_unverified',
  ownText: 'Die Stellplätze sind hiermit genehmigt.\n## 15.10.2026 09:00 · Mag. Anna Huber (ma37.wien.gv.at)\nBescheid folgt.',
})

const ARCHIVE = entry({
  id: '00000000-0000-4000-8000-000000000004',
  source: 'archive',
  sentAt: at('2026-09-30T12:00:00Z'),
  senderName: 'DI Max Weber',
  senderAddress: 'weber@statik-weber.at',
  senderDomain: 'statik-weber.at',
  signerDomain: null,
  senderTrust: 'not_checked',
  ownText: WEBER_TEXT,
})

function render(entries: MailThreadRenderEntry[], overrides: Partial<MailThreadRenderInput> = {}) {
  return renderMailThread({ title: 'Stellplatznachweis Bauplatz 12', locale: 'de', continues: null, entries, ...overrides })
}

/** Each `##` section of a rendition, its `###` subsections included, keyed by its heading line. */
function sectionsOf(markdown: string): Map<string, string> {
  const sections = new Map<string, string>()
  for (const block of markdown.split(/\n(?=## )/).slice(1)) sections.set(block.split('\n')[0], block.trimEnd())
  return sections
}

describe('renderMailThread: golden files', () => {
  it('renders a thread of three messages', async () => {
    await expect(render([HUBER, BERGER, FORGER]).markdown).toMatchFileSnapshot('./__golden__/three-messages.de.md')
  })

  it('renders an archive section beside inbound ones, in English', async () => {
    const english = [BERGER, ARCHIVE].map((e) => ({ ...e, heading: mailThreadEntryHeading(e, [], 'en') }))
    await expect(render(english, { locale: 'en', continues: 'Stellplätze 2025' }).markdown).toMatchFileSnapshot(
      './__golden__/archive-and-inbound.en.md'
    )
  })
})

describe('renderMailThread: the superset invariant', () => {
  const all = [BERGER, HUBER, FORGER, ARCHIVE]

  /** Every filing order of the entries; each step must keep every section of the step before byte for byte. */
  function* filingOrders(entries: MailThreadRenderEntry[]): Generator<MailThreadRenderEntry[]> {
    if (entries.length <= 1) {
      yield entries
      return
    }
    for (const [index, first] of entries.entries())
      for (const rest of filingOrders(entries.filter((_, i) => i !== index))) yield [first, ...rest]
  }

  it('keeps every earlier section byte for byte, whatever order the messages are filed in', () => {
    let orders = 0
    for (const order of filingOrders(all)) {
      orders += 1
      // Filing time follows the order; send times stay, so late messages are inserted in the middle.
      const filed = order.map((e, i) => ({ ...e, filedAt: new Date(Date.UTC(2026, 10, 1, 0, i)) }))
      let previous = new Map<string, string>()
      for (let n = 1; n <= filed.length; n += 1) {
        const current = sectionsOf(render(filed.slice(0, n)).markdown)
        for (const [heading, text] of previous) expect(current.get(heading), heading).toBe(text)
        expect(current.size).toBe(n)
        previous = current
      }
    }
    expect(orders).toBe(24)
  })

  it('is deterministic: the same rows give the same bytes', () => {
    expect(render([...all].reverse()).markdown).toBe(render(all).markdown)
  })

  it('folds a quote only of a message filed before the one that quotes it', () => {
    const archiveFirst = { ...ARCHIVE, filedAt: at('2026-10-01T00:00:00Z') }
    const huberAfter = { ...HUBER, filedAt: at('2026-10-15T00:00:00Z') }
    const folded = sectionsOf(render([archiveFirst, huberAfter]).markdown).get(`## ${HUBER.heading}`)
    expect(folded).not.toContain('Zitat in der Nachricht')

    const archiveLater = { ...ARCHIVE, filedAt: at('2026-10-16T00:00:00Z') }
    const kept = sectionsOf(render([archiveLater, huberAfter]).markdown).get(`## ${HUBER.heading}`)
    expect(kept).toContain(`### Zitat in der Nachricht von ${HUBER.heading}`)
    expect(kept).toContain(WEBER_TEXT)
  })

  it('keeps a quote that says more than the message it reproduces', () => {
    const longer = { ...HUBER, quoted: [{ text: `${WEBER_TEXT}\n${'Außerdem ist die Rampe zu steil. '.repeat(8)}` }] }
    const archiveFirst = { ...ARCHIVE, filedAt: at('2026-10-01T00:00:00Z') }
    expect(render([archiveFirst, longer]).markdown).toContain('Zitat in der Nachricht von')
  })

  it('says „Antwort auf“ only for a message filed before the answer', () => {
    const answer = sectionsOf(render([BERGER, HUBER]).markdown).get(`## ${HUBER.heading}`)
    expect(answer).toContain(`- **Antwort auf:** ${BERGER.heading}`)
    const bergerLater = { ...BERGER, filedAt: new Date(HUBER.filedAt.getTime() + 1) }
    expect(sectionsOf(render([bergerLater, HUBER]).markdown).get(`## ${HUBER.heading}`)).not.toContain('Antwort auf')
  })
})

describe('renderMailThread: detach, the one exception', () => {
  it('leaves only the detached section out, and changes only the sections that leaned on it', () => {
    const archiveFirst = { ...ARCHIVE, filedAt: at('2026-09-30T13:00:00Z') }
    const before = sectionsOf(render([archiveFirst, BERGER, HUBER, FORGER]).markdown)

    const afterArchive = sectionsOf(render([BERGER, HUBER, FORGER]).markdown)
    expect([...afterArchive.keys()]).toEqual([...before.keys()].filter((h) => h !== `## ${ARCHIVE.heading}`))
    // Huber's quote of Weber was folded while Weber's message was in the thread; it is shown again.
    expect(afterArchive.get(`## ${HUBER.heading}`)).not.toBe(before.get(`## ${HUBER.heading}`))
    expect(afterArchive.get(`## ${HUBER.heading}`)).toContain(WEBER_TEXT)
    for (const heading of [BERGER.heading, FORGER.heading])
      expect(afterArchive.get(`## ${heading}`)).toBe(before.get(`## ${heading}`))

    const afterBerger = sectionsOf(render([archiveFirst, HUBER, FORGER]).markdown)
    expect(afterBerger.get(`## ${HUBER.heading}`)).not.toContain('Antwort auf')
    expect(afterBerger.get(`## ${FORGER.heading}`)).toBe(before.get(`## ${FORGER.heading}`))
  })
})

describe('headings by source and trust', () => {
  const base: MailThreadHeadingFields = {
    source: 'inbound',
    sentAt: at('2026-10-14T07:12:00Z'),
    receivedAt: at('2026-10-14T07:14:00Z'),
    senderName: 'Mag. Anna Huber',
    senderAddress: 'huber@ma37.wien.gv.at',
    senderDomain: 'ma37.wien.gv.at',
    signerDomain: 'wien.gv.at',
    senderTrust: 'external_verified',
  }

  it.each<[string, Partial<MailThreadHeadingFields>, string]>([
    ['a verified stranger by the signing domain', {}, '14.10.2026 09:12 · Mag. Anna Huber (wien.gv.at)'],
    ['a verified member by the signing domain', { senderTrust: 'member_verified' }, '14.10.2026 09:12 · Mag. Anna Huber (wien.gv.at)'],
    [
      'an unverified stranger with the suffix',
      { senderTrust: 'external_unverified' },
      '14.10.2026 09:12 · Mag. Anna Huber (ma37.wien.gv.at, Domain nicht bestätigt)',
    ],
    [
      'an unverified member with the suffix',
      { senderTrust: 'member_unverified' },
      '14.10.2026 09:12 · Mag. Anna Huber (ma37.wien.gv.at, Domain nicht bestätigt)',
    ],
    [
      'a verified trust without a signer as unverified',
      { signerDomain: null },
      '14.10.2026 09:12 · Mag. Anna Huber (ma37.wien.gv.at, Domain nicht bestätigt)',
    ],
    [
      'an archive entry as from the archive, whatever it claims',
      { source: 'archive', senderTrust: 'not_checked' },
      '14.10.2026 09:12 · Mag. Anna Huber (ma37.wien.gv.at, aus dem Outlook-Archiv)',
    ],
    [
      'a name that fakes a domain, without its brackets',
      { senderName: 'Huber (ma37.wien.gv.at)', senderTrust: 'external_unverified', senderDomain: 'evil.example' },
      '14.10.2026 09:12 · Huber ma37.wien.gv.at (evil.example, Domain nicht bestätigt)',
    ],
    [
      'a domain that tries to close the bracket',
      { senderTrust: 'external_unverified', senderDomain: 'evil.example) (ma37.wien.gv.at' },
      '14.10.2026 09:12 · Mag. Anna Huber (evil.examplema37.wien.gv.at, Domain nicht bestätigt)',
    ],
    ['an address for a name by its local part', { senderName: 'huber@ma37.wien.gv.at' }, '14.10.2026 09:12 · huber (wien.gv.at)'],
    ['no name and no address', { senderName: null, senderAddress: null }, '14.10.2026 09:12 · Unbekannt (wien.gv.at)'],
    [
      'a name over several lines on one line',
      { senderName: 'Anna\u2028## Huber\r\nMA 37' },
      '14.10.2026 09:12 · Anna ## Huber MA 37 (wien.gv.at)',
    ],
  ])('names %s', (_case, overrides, expected) => {
    expect(entryHeadingBase({ ...base, ...overrides }, 'de')).toBe(expected)
  })

  it('uses the clamped time: a future Date is placed at the receipt', () => {
    expect(entryHeadingBase({ ...base, sentAt: at('2027-01-01T00:00:00Z') }, 'de')).toBe(
      '14.10.2026 09:14 · Mag. Anna Huber (wien.gv.at)'
    )
  })

  it('numbers a collision instead of renumbering anything', () => {
    const first = mailThreadEntryHeading(base, [], 'de')
    expect(mailThreadEntryHeading(base, [first], 'de')).toBe(`${first} (2)`)
    expect(mailThreadEntryHeading(base, [first, `${first} (2)`], 'de')).toBe(`${first} (3)`)
  })

  it('refuses to render a stored heading that drops the unverified suffix', () => {
    const lying = { ...FORGER, heading: '15.10.2026 11:00 · Mag. Anna Huber (ma37-wien.at)' }
    expect(() => render([lying])).toThrow(MailThreadRenderError)
  })

  it('refuses two entries with one heading', () => {
    expect(() => render([BERGER, { ...BERGER, id: 'other' }])).toThrow(/duplicate_heading/)
  })

  it('never prints an unverified heading without its suffix (ratchet)', () => {
    const markdown = render([BERGER, HUBER, FORGER, ARCHIVE]).markdown
    for (const heading of chunkerReads(markdown).headings.filter((h) => h.startsWith('## '))) {
      const isVerified = heading.endsWith('(berger-architektur.at)') || heading.endsWith('(ma37.wien.gv.at)')
      expect(
        isVerified || heading.includes('Domain nicht bestätigt') || heading.includes('aus dem Outlook-Archiv'),
        heading
      ).toBe(true)
    }
    expect(markdown).toContain(`## ${FORGER.heading}`)
    expect(FORGER.heading).toBe('15.10.2026 11:00 · Mag. Anna Huber ma37.wien.gv.at (ma37-wien.at, Domain nicht bestätigt)')
  })
})

describe('the date clamp in a section', () => {
  it('places a future-dated mail at its receipt and says so', () => {
    const future = entry({ id: 'f', sentAt: at('2027-03-01T00:00:00Z'), receivedAt: at('2026-10-16T10:00:00Z') })
    const markdown = render([BERGER, future]).markdown
    expect(future.heading.startsWith('16.10.2026 12:00')).toBe(true)
    expect([...sectionsOf(markdown).keys()]).toEqual([`## ${BERGER.heading}`, `## ${future.heading}`])
    expect(markdown).toContain('*Das Datum der E-Mail war nicht plausibel; sie ist nach dem Eingang eingeordnet.*')
  })

  it('says when each message was received', () => {
    expect(render([HUBER]).markdown).toContain('*eingegangen 14.10.2026, 09:14*')
  })
})

describe('quotes', () => {
  it('labels a kept quote by the message that quotes it, never by whom it names', () => {
    const fake = entry({
      id: 'q',
      sentAt: at('2026-10-16T08:00:00Z'),
      senderTrust: 'external_unverified',
      senderDomain: 'evil.example',
      signerDomain: null,
      senderName: 'Someone',
      quoted: [{ text: 'Von: Mag. Anna Huber (MA 37)\nDie Stellplätze sind genehmigt.' }],
    })
    const markdown = render([fake]).markdown
    expect(markdown).toContain(`### Zitat in der Nachricht von ${fake.heading}`)
    expect(chunkerReads(markdown).headings).toEqual([
      '# Stellplatznachweis Bauplatz 12',
      `## ${fake.heading}`,
      `### Zitat in der Nachricht von ${fake.heading}`,
    ])
  })

  it('numbers a second kept quote of one message', () => {
    const twice = entry({ id: 'q2', sentAt: at('2026-10-16T08:00:00Z'), quoted: [{ text: 'eins' }, { text: 'zwei' }] })
    expect(render([twice]).markdown).toContain(`### Zitat in der Nachricht von ${twice.heading} (2)`)
  })
})

describe('masked spans', () => {
  it('replaces each span with its placeholder and keeps the rest', () => {
    const markdown = render([BERGER]).markdown
    expect(markdown).toContain('nicht auf \\[IBAN entfernt\\].')
    expect(markdown).not.toMatch(/AT61|3457/)
  })

  it('merges overlapping spans and ignores spans past the end', () => {
    const text = 'Konto 0123456789 und Ende'
    const e = entry({
      id: 'm',
      sentAt: at('2026-10-03T08:00:00Z'),
      ownText: text,
      maskedSpans: [
        { kind: 'term', start: 6, end: 12 },
        { kind: 'iban', start: 8, end: 16 },
        { kind: 'term', start: 400, end: 410 },
      ],
    })
    expect(render([e]).markdown).toContain('Konto \\[Begriff entfernt\\] und Ende')
  })

  it('renders the full text when the person filed it unmasked', () => {
    expect(render([{ ...BERGER, maskedSpans: null }]).markdown).toContain('AT61 1904 3002 3457 3201')
  })
})

describe('attachments (RT-S13)', () => {
  const filing = (overrides: Partial<MailThreadAttachmentFiling>): MailThreadAttachmentFiling => ({
    disposition: 'filed',
    name: 'Honorarnote_Mustermann.pdf',
    folderPath: '/Intern/Honorare',
    visibleWithThread: true,
    nameReleased: false,
    ...overrides,
  })

  it.each<[string, Partial<MailThreadAttachmentFiling>]>([
    ['from a folder less visible than the thread', { visibleWithThread: false }],
    ['the Namensprüfung stopped and a person released', { nameReleased: true }],
    ['that was not filed', { disposition: 'not_filed' }],
    ['that came without a name', { name: null }],
  ])('never names an attachment %s, only counts it', (_case, overrides) => {
    const e = entry({ id: 'a', sentAt: at('2026-10-03T08:00:00Z'), attachments: [sectionAttachment(filing(overrides))] })
    const markdown = render([e]).markdown
    expect(markdown).not.toContain('Honorar')
    expect(markdown).not.toContain('/Intern')
    expect(markdown).toContain('- **Anhänge:** 1 Anhang nur im Original')
  })

  it('names a filed attachment with its folder', () => {
    const e = entry({ id: 'a', sentAt: at('2026-10-03T08:00:00Z'), attachments: [sectionAttachment(filing({}))] })
    expect(render([e]).markdown).toContain('- **Anhänge:** Honorarnote\\_Mustermann.pdf (abgelegt in /Intern/Honorare)')
  })

  it('names one already in the project, and one at the root without a folder', () => {
    const line = sectionAttachment(filing({ disposition: 'already_present', folderPath: '' }))
    expect(line).toEqual({ name: 'Honorarnote_Mustermann.pdf', folderPath: null })
    const e = entry({ id: 'a', sentAt: at('2026-10-03T08:00:00Z'), attachments: [line] })
    expect(render([e]).markdown).toContain('- **Anhänge:** Honorarnote\\_Mustermann.pdf\n')
  })

  it('keeps a name on one line, so a file name opens no section', () => {
    expect(sectionAttachment(filing({ name: 'a\n## 14.10.2026 · MA 37.pdf' })).name).toBe('a ## 14.10.2026 · MA 37.pdf')
  })
})

describe('nothing a stranger wrote becomes structure', () => {
  const TERMINATORS = ['\n', '\r', '\r\n', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x85', '\u2028', '\u2029']

  it('opens no section and no fence for the chunker, after any terminator', () => {
    for (const terminator of TERMINATORS) {
      const body = ['Sehr geehrte Damen und Herren,', '## 14.10.2026 · MA 37', '```', '### Auflage', '~~~', 'Ende'].join(
        terminator
      )
      const hostile = entry({
        id: 'h',
        sentAt: at('2026-10-03T08:00:00Z'),
        senderName: `Eva${terminator}## Berger`,
        ownText: body,
        quoted: [{ text: body }],
        participants: [{ role: 'to', name: `x${terminator}# y`, address: 'x@y.at' }],
      })
      const markdown = render([hostile], { title: `Titel${terminator}## Unter` }).markdown
      expect(chunkerReads(markdown), JSON.stringify(terminator)).toEqual({
        headings: [
          '# Titel ## Unter',
          `## ${hostile.heading}`,
          `### Zitat in der Nachricht von ${hostile.heading}`,
        ],
        fences: 0,
      })
    }
  })

  it('is, for CommonMark, exactly its own headings', () => {
    const markdown = render([BERGER, HUBER, FORGER, ARCHIVE]).markdown
    const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown)
    const headings = tree.children.filter((node) => node.type === 'heading').map((node) => node.depth)
    // Weber's archived message was filed before Huber's reply, so its quote there is folded.
    expect(headings).toEqual([1, 2, 2, 2, 2])
    expect(tree.children.some((node) => node.type === 'code' || node.type === 'html')).toBe(false)
  })

  it('strips control characters that are no line break', () => {
    const e = entry({ id: 'c', sentAt: at('2026-10-03T08:00:00Z'), ownText: 'a\u0000b\u0007c\u001fd\u009be' })
    expect(render([e]).markdown).toContain('\nabcde\n')
  })

  it('prints no address, only domains', () => {
    const markdown = render([BERGER, HUBER, FORGER, ARCHIVE]).markdown
    expect(markdown).not.toContain('@')
    expect(markdown).toContain('Mag. Anna Huber (ma37.wien.gv.at)')
  })

  it('cuts an overlong text and says the rest is in the original', () => {
    const long = entry({ id: 'l', sentAt: at('2026-10-03T08:00:00Z'), ownText: 'x'.repeat(100_050) })
    const markdown = render([long]).markdown
    expect(markdown).not.toContain('x'.repeat(100_001))
    expect(markdown).toContain('*(gekürzt; der ganze Text steht im Original)*')
  })

  it('writes an empty message as one', () => {
    expect(render([entry({ id: 'e', sentAt: at('2026-10-03T08:00:00Z'), ownText: ' \n\r\n ' })]).markdown).toContain(
      '*(ohne Text)*'
    )
  })
})

describe('the rendition', () => {
  it('reports its UTF-8 size and its sections in reading order', () => {
    const result = render([HUBER, BERGER])
    expect(result.bytes).toBe(Buffer.byteLength(result.markdown, 'utf8'))
    expect(result.sections).toEqual([
      { entryId: BERGER.id, heading: BERGER.heading },
      { entryId: HUBER.id, heading: HUBER.heading },
    ])
  })

  it('has copy for every locale', () => {
    expect(Object.keys(MAIL_THREAD_RENDER_COPY).sort()).toEqual(['de', 'en'])
  })
})
