import { describe, expect, it } from 'vitest'
import {
  FASSUNG_MAX_REFS,
  FASSUNG_MAX_SUMMARY_LENGTH,
  parseFassungNames,
  referencedNames,
  resolveFassungFacts,
  type FassungNames,
  type FassungRef,
} from './fassung'

const OWN = 'Grundriss EG_B.pdf'
const VISIBLE: Record<string, FassungRef> = {
  'Grundriss EG_A.pdf': { id: 'doc-a', filename: 'Grundriss EG_A.pdf' },
  'Grundriss EG_C.pdf': { id: 'doc-c', filename: 'Grundriss EG_C.pdf' },
}
const lookup = (filename: string): FassungRef | null => VISIBLE[filename] ?? null

const names = (overrides: Partial<FassungNames> = {}): FassungNames => ({
  supersededBy: null,
  supersedes: [],
  suggestion: null,
  change: null,
  ...overrides,
})

describe('parseFassungNames', () => {
  it('maps the snake_case backend fields', () => {
    expect(
      parseFassungNames({
        superseded_by: 'Grundriss EG_C.pdf',
        supersedes: ['Grundriss EG_A.pdf'],
        revision_suggestion: { of: 'Grundriss EG_A.pdf', confidence: 0.82, reason: 'Gleicher Name, Index B', basis: 'name' },
        change_summary: 'Wand im Süden entfällt.',
        change_basis: 'Grundriss EG_A.pdf',
      }),
    ).toEqual({
      supersededBy: 'Grundriss EG_C.pdf',
      supersedes: ['Grundriss EG_A.pdf'],
      suggestion: { of: 'Grundriss EG_A.pdf', confidence: 0.82, reason: 'Gleicher Name, Index B', basis: 'name' },
      change: { text: 'Wand im Süden entfällt.', basis: 'Grundriss EG_A.pdf' },
    })
  })

  it('answers null when the backend said nothing usable', () => {
    expect(parseFassungNames({})).toBeNull()
    expect(
      parseFassungNames({ superseded_by: 42, supersedes: 'x', revision_suggestion: [], change_summary: '  ', change_basis: 'a' }),
    ).toBeNull()
  })

  it('drops junk field by field', () => {
    expect(
      parseFassungNames({
        superseded_by: 'Grundriss EG_C.pdf',
        supersedes: ['ok.pdf', 7, '', null, 'ok.pdf'],
        revision_suggestion: { of: 'a.pdf', confidence: 'high', basis: 'name' },
      }),
    ).toEqual({ supersededBy: 'Grundriss EG_C.pdf', supersedes: ['ok.pdf'], suggestion: null, change: null })
  })

  it('clamps the confidence to 0..1', () => {
    const suggestion = (confidence: number) =>
      parseFassungNames({ revision_suggestion: { of: 'a.pdf', confidence, reason: 'x', basis: 'content' } })?.suggestion
    expect(suggestion(7)?.confidence).toBe(1)
    expect(suggestion(-3)?.confidence).toBe(0)
    expect(suggestion(Number.NaN)).toBeUndefined()
  })

  it('refuses a basis the UI does not know', () => {
    expect(
      parseFassungNames({ revision_suggestion: { of: 'a.pdf', confidence: 0.5, reason: 'x', basis: 'magic' } }),
    ).toBeNull()
  })

  it('bounds names, counts and text', () => {
    const parsed = parseFassungNames({
      superseded_by: 'x'.repeat(300),
      supersedes: Array.from({ length: 60 }, (_, i) => `f${i}.pdf`),
      change_summary: 'z'.repeat(FASSUNG_MAX_SUMMARY_LENGTH + 500),
    })
    expect(parsed?.supersededBy).toBeNull()
    expect(parsed?.supersedes).toHaveLength(FASSUNG_MAX_REFS)
    expect(parsed?.change?.text).toHaveLength(FASSUNG_MAX_SUMMARY_LENGTH)
  })
})

describe('referencedNames', () => {
  it('lists every other name once and never the document itself', () => {
    expect(
      referencedNames(
        names({
          supersededBy: 'Grundriss EG_C.pdf',
          supersedes: ['Grundriss EG_A.pdf', OWN],
          suggestion: { of: 'Grundriss EG_A.pdf', confidence: 0.5, reason: '', basis: 'name' },
          change: { text: 't', basis: OWN },
        }),
        OWN,
      ),
    ).toEqual(['Grundriss EG_C.pdf', 'Grundriss EG_A.pdf'])
  })
})

describe('resolveFassungFacts', () => {
  it('resolves every name the reader may open', () => {
    expect(
      resolveFassungFacts(
        names({
          supersededBy: 'Grundriss EG_C.pdf',
          supersedes: ['Grundriss EG_A.pdf'],
          suggestion: { of: 'Grundriss EG_A.pdf', confidence: 0.7, reason: 'Index', basis: 'name' },
          change: { text: 'Wand entfällt.', basis: 'Grundriss EG_A.pdf' },
        }),
        OWN,
        lookup,
      ),
    ).toEqual({
      supersededBy: { id: 'doc-c', filename: 'Grundriss EG_C.pdf' },
      supersedes: [{ id: 'doc-a', filename: 'Grundriss EG_A.pdf' }],
      suggestion: { of: { id: 'doc-a', filename: 'Grundriss EG_A.pdf' }, confidence: 0.7, reason: 'Index', basis: 'name' },
      changeSummary: { text: 'Wand entfällt.', basis: { id: 'doc-a', filename: 'Grundriss EG_A.pdf' } },
    })
  })

  it('reads a basis equal to the own name, or none, as the previous Fassung', () => {
    expect(resolveFassungFacts(names({ change: { text: 'Neu', basis: OWN } }), OWN, lookup)?.changeSummary).toEqual({
      text: 'Neu',
      basis: 'previous',
    })
    expect(resolveFassungFacts(names({ change: { text: 'Neu', basis: null } }), OWN, lookup)?.changeSummary?.basis).toBe(
      'previous',
    )
  })

  it('treats a reference to the document itself as no link', () => {
    expect(resolveFassungFacts(names({ supersededBy: OWN, supersedes: [OWN] }), OWN, lookup)).toBeNull()
  })

  it('answers null for no names and for names that resolve to nothing', () => {
    expect(resolveFassungFacts(null, OWN, lookup)).toBeNull()
    expect(resolveFassungFacts(names({ supersededBy: 'weg.pdf' }), OWN, lookup)).toBeNull()
  })

  describe('privacy: a document the reader may not see', () => {
    // The lookup knows the held document by NAME only to refuse it, the way the
    // visible-documents query does: it never returns a row for it.
    const HELD = 'Gehaltsliste intern.xlsx'

    it('never lets a held document name reach the facts', () => {
      const facts = resolveFassungFacts(
        names({
          supersededBy: HELD,
          supersedes: [HELD, 'Grundriss EG_A.pdf'],
          suggestion: { of: HELD, confidence: 0.9, reason: `Ersetzt ${HELD}`, basis: 'name' },
          change: { text: `Gegenüber ${HELD}: Spalte C entfällt.`, basis: HELD },
        }),
        OWN,
        lookup,
      )
      expect(JSON.stringify(facts)).not.toContain(HELD)
      expect(JSON.stringify(facts)).not.toContain('Gehalt')
      expect(facts).toEqual({
        supersededBy: null,
        supersedes: [{ id: 'doc-a', filename: 'Grundriss EG_A.pdf' }],
        suggestion: null,
        changeSummary: null,
      })
    })

    it('answers null when nothing else is left', () => {
      expect(
        resolveFassungFacts(
          names({ supersededBy: HELD, change: { text: `Gegenüber ${HELD}`, basis: HELD } }),
          OWN,
          lookup,
        ),
      ).toBeNull()
    })
  })
})
