import { describe, expect, it } from 'vitest'
import { createTranslator } from '@/i18n/translate'
import { de } from '@/i18n/dictionaries/de'
import {
  describeNameMatch,
  describeQuarantineReason,
  explainQuarantineReason,
  findingsOf,
  firstFinding,
  heldSentenceKey,
  quarantineNoticePayload,
  quarantineReasonHead,
  quarantineVerdictOf,
  reportsQuarantine,
  storedQuarantineVerdictOf,
  auditedQuarantineReasons,
  AUDITED_REASONS_CUT_MARK,
  AUDITED_REASONS_MAX_CHARS,
} from './quarantine'
import { classifyIngestFailure } from '@/features/documents/lib/ingest-failure'

const t = createTranslator(de, 'files')

/** A row from before migration 0148 that its backfill could not convert: only the message says why. */
const parseQuarantine = (errorMessage: string | null) => quarantineVerdictOf({ errorMessage })

const stored =
  'quarantined:{"reasons":[{"kind":"term","term":"Lohnzettel","count":2,"pages":[1,3]},' +
  '{"kind":"iban","count":1,"pages":[2],"sample":"AT61 •••• •••• •••• 1234"}],"checked":"partial"}'

describe('the typed verdict (ADR-0113)', () => {
  const typed = {
    reasons: [{ kind: 'term', term: 'Honorarvereinbarung', count: 1, pages: [5] }],
    checked: 'full',
  }

  it('is what a row or a job file says, whatever its message says', () => {
    expect(quarantineVerdictOf({ quarantine: typed, errorMessage: stored })?.reasons[0].term).toBe('Honorarvereinbarung')
    expect(quarantineVerdictOf({ quarantine: typed, error_message: null })?.checked).toBe('full')
  })

  it('reads the legacy message only when the typed verdict is absent', () => {
    expect(quarantineVerdictOf({ quarantine: null, errorMessage: stored })?.reasons[0].term).toBe('Lohnzettel')
    expect(quarantineVerdictOf({ error_message: stored })?.reasons).toHaveLength(2)
  })

  it('is not replaced by the message when it is broken: the field is the answer', () => {
    expect(quarantineVerdictOf({ quarantine: { reasons: 'none' }, errorMessage: stored })).toBeNull()
  })

  it('says a file was held by its verdict, or by a legacy message, and by nothing else', () => {
    expect(reportsQuarantine({ quarantine: typed })).toBe(true)
    expect(reportsQuarantine({ quarantine: { reasons: 'none' } })).toBe(true) // held, reasons unreadable
    expect(reportsQuarantine({ error_message: 'quarantined:{broken' })).toBe(true)
    expect(reportsQuarantine({ errorMessage: 'interrupted: worker restarted' })).toBe(false)
    expect(reportsQuarantine({ quarantine: null, errorMessage: null })).toBe(false)
  })

  it('is stored with every kind as the job wrote it, and read with the kinds this build knows', () => {
    const job = { reasons: [{ kind: 'passport', count: 1, pages: [4], extra: 'dropped' }], checked: 'full' }
    expect(storedQuarantineVerdictOf({ quarantine: job })).toEqual({
      reasons: [{ kind: 'passport', count: 1, pages: [4] }],
      checked: 'full',
    })
    expect(quarantineVerdictOf({ quarantine: storedQuarantineVerdictOf({ quarantine: job }) })?.reasons[0].kind).toBe(
      'other'
    )
    expect(storedQuarantineVerdictOf({ errorMessage: 'quarantined:{not json' })).toBeNull()
  })

  it('records a kind this build does not know by its name in the audit trail', () => {
    expect(auditedQuarantineReasons(storedQuarantineVerdictOf({ quarantine: { reasons: [{ kind: 'passport' }] } }))).toBe(
      'passport'
    )
  })

  it('says when the audited reasons were cut', () => {
    const many = { reasons: Array.from({ length: 10 }, (_, n) => ({ kind: 'term' as const, term: `${n}`.padEnd(40, 'x') })) }
    const audited = auditedQuarantineReasons(many)
    expect(audited).toHaveLength(AUDITED_REASONS_MAX_CHARS)
    expect(audited.endsWith(AUDITED_REASONS_CUT_MARK)).toBe(true)
    expect(auditedQuarantineReasons({ reasons: [{ kind: 'iban' }] })).toBe('iban')
  })
})

describe('the legacy message', () => {
  it('reads the verdict the ingest job stores', () => {
    expect(parseQuarantine(stored)).toEqual({
      reasons: [
        { kind: 'term', term: 'Lohnzettel', count: 2, pages: [1, 3] },
        { kind: 'iban', count: 1, pages: [2], sample: 'AT61 •••• •••• •••• 1234' },
      ],
      checked: 'partial',
    })
  })

  it('answers null for any other error, and for a malformed verdict', () => {
    expect(parseQuarantine('interrupted: worker restarted')).toBeNull()
    expect(parseQuarantine('quarantined:{not json')).toBeNull()
    expect(parseQuarantine('quarantined:{"reasons":"none"}')).toBeNull()
    expect(parseQuarantine('quarantined:{"reasons":[{"count":1}]}')).toBeNull() // a reason with no kind is damage, not a new rule
    expect(parseQuarantine(null)).toBeNull()
  })

  it('reads a reason whose page list the job cut', () => {
    const cut = parseQuarantine(
      'quarantined:{"reasons":[{"kind":"term","term":"Lohnzettel","count":80,"pages":[1,2,3],"pages_truncated":true}]}'
    )
    expect(cut?.reasons[0]).toEqual({ kind: 'term', term: 'Lohnzettel', count: 80, pages: [1, 2, 3], pages_truncated: true })
    // A verdict stored before the field existed lists every page, and still parses.
    expect(parseQuarantine(stored)?.reasons[0].pages_truncated).toBeUndefined()
    // A field of the wrong type is a malformed verdict, not a guess.
    expect(
      parseQuarantine('quarantined:{"reasons":[{"kind":"term","term":"L","pages":[1],"pages_truncated":"yes"}]}')
    ).toBeNull()
  })

  it('is classified as a quarantine, not as an unknown failure', () => {
    expect(classifyIngestFailure(stored)?.kind).toBe('quarantined')
  })
})

describe('a verdict this build only half knows', () => {
  it('keeps the reasons it can read when one has a kind it does not know', () => {
    const verdict = parseQuarantine(
      'quarantined:{"reasons":[{"kind":"passport","count":1,"pages":[4]},{"kind":"term","term":"Lohnzettel","count":1,"pages":[2]}]}'
    )
    expect(verdict?.reasons.map((reason) => reason.kind)).toEqual(['other', 'term'])
    const [unknown] = verdict?.reasons ?? []
    expect(describeQuarantineReason(unknown, t)).toBe('Eine Regel, die hier nicht näher beschrieben ist · Seite 4')
  })

  it('reads how many reasons the job left out', () => {
    expect(parseQuarantine('quarantined:{"reasons":[],"omitted":5}')?.omitted).toBe(5)
    expect(parseQuarantine('quarantined:{"reasons":[]}')?.omitted).toBeUndefined()
  })
})

describe('explaining a reason', () => {
  it('says whose rule a term is', () => {
    expect(explainQuarantineReason({ kind: 'term', term: 'Lohnzettel' }, t)).toBe(
      'Dieser Begriff steht auf der Liste, die Ihr Büro als sensibel eingestuft hat.'
    )
  })

  it('says what a number had to pass, so a look-alike is not mistaken for one', () => {
    for (const kind of ['iban', 'at_svnr', 'credit_card'] as const) {
      expect(explainQuarantineReason({ kind }, t)).toMatch(/rechnerisch gültig/)
    }
  })

  it('claims nothing for a rule it does not know', () => {
    expect(explainQuarantineReason({ kind: 'other' }, t)).toBe(
      'Die Inhaltsprüfung hat eine Regel angewandt, die hier nicht näher beschrieben ist.'
    )
  })
})

describe('describing a reason', () => {
  it('says plainly when a finding has no page to open', () => {
    expect(describeQuarantineReason({ kind: 'term', term: 'Lohnzettel', count: 1, pages: [] }, t)).toBe(
      '„Lohnzettel“ im Text · ohne Seitenangabe'
    )
  })

  it('says the term and the pages', () => {
    const verdict = parseQuarantine(stored)
    expect(verdict && describeQuarantineReason(verdict.reasons[0], t)).toBe('„Lohnzettel“ im Text · Seiten 1, 3')
  })

  it('shows a detector hit only by its masked sample', () => {
    const verdict = parseQuarantine(stored)
    expect(verdict && describeQuarantineReason(verdict.reasons[1], t)).toBe('IBAN AT61 •••• •••• •••• 1234 · Seite 2')
  })

  it('says there are more pages when the job listed only some', () => {
    const cut = parseQuarantine(
      'quarantined:{"reasons":[{"kind":"term","term":"Lohnzettel","count":80,"pages":[1,3],"pages_truncated":true}]}'
    )
    expect(cut && describeQuarantineReason(cut.reasons[0], t)).toBe('„Lohnzettel“ im Text · Seiten 1, 3, …')
  })

  it('says the reason without its pages where the pages are buttons', () => {
    const verdict = parseQuarantine(stored)
    expect(verdict && quarantineReasonHead(verdict.reasons[0], t)).toBe('„Lohnzettel“ im Text')
  })

  it('names the folder for a name match on a folder', () => {
    expect(describeNameMatch({ term: 'Personal', segment: 'Personalunterlagen', kind: 'folder' }, t)).toBe(
      'Ordner „Personalunterlagen“ enthält „Personal“'
    )
  })
})

describe('where a finding is', () => {
  it('opens a term on each of its pages, with the term marked', () => {
    const verdict = parseQuarantine(stored)
    expect(verdict && findingsOf(verdict.reasons[0])).toEqual([
      { page: 1, highlight: 'Lohnzettel' },
      { page: 3, highlight: 'Lohnzettel' },
    ])
  })

  it('opens a detector hit at its page and marks nothing, because its value is never stored', () => {
    const verdict = parseQuarantine(stored)
    expect(verdict && findingsOf(verdict.reasons[1])).toEqual([{ page: 2, highlight: null }])
  })

  it('opens a held document at its first finding, and nowhere when no reason has a page', () => {
    expect(firstFinding(parseQuarantine(stored))).toEqual({ page: 1, highlight: 'Lohnzettel' })
    expect(firstFinding(parseQuarantine('quarantined:{"reasons":[{"kind":"term","term":"Lohn"}]}'))).toBeNull()
    expect(firstFinding(null)).toBeNull()
  })
})

describe('heldSentenceKey', () => {
  const reason = { kind: 'term' as const, term: 'Lohnzettel', count: 1, pages: [1] }

  it('claims no model saw the file only when no model did', () => {
    expect(heldSentenceKey({ reasons: [reason] })).toBe('ingestFailure.quarantined')
    expect(heldSentenceKey({ reasons: [reason], checked: 'partial', after_transcription: true })).toBe(
      'ingestFailure.quarantinedAfterTranscription'
    )
  })

  it('claims nothing about the content when there is nothing to list', () => {
    expect(heldSentenceKey(null)).toBe('ingestFailure.quarantinedUnreadable')
    expect(heldSentenceKey({ reasons: [] })).toBe('ingestFailure.quarantinedUnreadable')
    expect(heldSentenceKey({ reasons: [], omitted: 2 })).toBe('ingestFailure.quarantined')
  })
})

describe('quarantineNoticePayload', () => {
  it('names the file and its kind of reason, never the value', () => {
    const payload = quarantineNoticePayload({
      filename: 'Lohnzettel.pdf',
      quarantine: { reasons: [{ kind: 'iban', count: 1, sample: 'AT61 •••• •••• •••• 3201' }] },
    })
    expect(payload).toEqual({ subject: 'Lohnzettel.pdf', variant: 'iban' })
  })

  it('writes the variant even when the verdict names none, so a collapsed row keeps no earlier file’s reason', () => {
    expect(quarantineNoticePayload({ filename: 'Altbestand.docx', quarantine: null })).toEqual({
      subject: 'Altbestand.docx',
      variant: null,
    })
    expect(
      quarantineNoticePayload({ filename: 'Neu.pdf', quarantine: { reasons: [{ kind: 'passport', count: 1 }] } })
    ).toEqual({ subject: 'Neu.pdf', variant: null })
  })
})
