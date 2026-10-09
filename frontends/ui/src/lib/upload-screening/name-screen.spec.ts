import { describe, expect, it } from 'vitest'
import { foldForScreening, screenUploadName } from './name-screen'
import {
  SUGGESTED_SCREENING_POLICY,
  normalizeTermList,
  resolveUploadScreeningPolicy,
  toIngestScreening,
  type UploadScreeningPolicy,
} from './policy'

const policy = (overrides: Partial<UploadScreeningPolicy> = {}): UploadScreeningPolicy => ({
  ...SUGGESTED_SCREENING_POLICY,
  ...overrides,
})

describe('screenUploadName', () => {
  it('blocks a German compound whose head is the term (Schlussrechnung)', () => {
    const verdict = screenUploadName(policy(), { filename: 'Schlussrechnung_2026-03.pdf' })
    expect(verdict.blocked).toBe(true)
    expect(verdict.matches).toEqual([{ term: 'Rechnung', segment: 'Schlussrechnung_2026-03.pdf', kind: 'file' }])
  })

  it('does not block a word that only contains the term inside a declared exception (Statische Berechnung)', () => {
    expect(screenUploadName(policy(), { filename: 'Statische Berechnung Dach.pdf' }).blocked).toBe(false)
  })

  it('still blocks when the term occurs again outside the exception', () => {
    const verdict = screenUploadName(policy(), { filename: 'Berechnung zur Rechnung.pdf' })
    expect(verdict.blocked).toBe(true)
  })

  it('folds case and umlauts in both directions', () => {
    const p = policy({ nameTerms: ['Gehälter'], nameExceptions: [] })
    expect(screenUploadName(p, { filename: 'GEHAELTER 2026.xlsx' }).blocked).toBe(true)
    expect(screenUploadName(policy({ nameTerms: ['Gehaelter'] }), { filename: 'Gehälter.xlsx' }).blocked).toBe(true)
  })

  it('treats a decomposed (macOS) name like its composed form', () => {
    const decomposed = 'Gehälter.xlsx'.normalize('NFD')
    expect(screenUploadName(policy({ nameTerms: ['Gehälter'] }), { filename: decomposed }).blocked).toBe(true)
  })

  it('blocks a file because of a folder on its origin path, and names the folder', () => {
    const verdict = screenUploadName(policy(), {
      filename: 'scan_0042.pdf',
      originPath: 'Projekt Wien/Personalunterlagen/scan_0042.pdf',
    })
    expect(verdict.matches).toEqual([{ term: 'Personal', segment: 'Personalunterlagen', kind: 'folder' }])
  })

  it('blocks a file filed into a project folder whose name matches', () => {
    const verdict = screenUploadName(policy(), { filename: 'a.pdf', folderPath: 'Verwaltung/Honorare' })
    expect(verdict.matches).toEqual([{ term: 'Honorar', segment: 'Honorare', kind: 'folder' }])
  })

  it('splits Windows-style origin paths too', () => {
    const verdict = screenUploadName(policy(), { filename: 'x.pdf', originPath: 'Akt\\Lohnzettel\\x.pdf' })
    expect(verdict.blocked).toBe(true)
  })

  it('lets everything through when screening is off or there are no name terms', () => {
    expect(screenUploadName(policy({ enabled: false }), { filename: 'Rechnung.pdf' }).blocked).toBe(false)
    expect(screenUploadName(policy({ nameTerms: [] }), { filename: 'Rechnung.pdf' }).blocked).toBe(false)
  })

  it('leaves an ordinary plan alone', () => {
    expect(
      screenUploadName(policy(), { filename: 'Grundriss EG.pdf', originPath: 'Einreichung/Pläne/Grundriss EG.pdf' })
        .blocked
    ).toBe(false)
  })

  it('lets the suggested exception through (Bauvertrag) but not a fee contract (Architektenvertrag)', () => {
    expect(screenUploadName(policy(), { filename: 'Bauvertrag Rohbau.pdf' }).blocked).toBe(false)
    expect(screenUploadName(policy(), { filename: 'Architektenvertrag.pdf' }).blocked).toBe(true)
  })
})

describe('foldForScreening', () => {
  it('maps every umlaut and ß', () => {
    expect(foldForScreening('ÄÖÜäöüß')).toBe('aeoeueaeoeuess')
  })
})

describe('policy', () => {
  it('normalizes a term list: trims, collapses spaces, drops one-letter entries and case-duplicates', () => {
    expect(normalizeTermList(['  Rechnung ', 'rechnung', 'x', '', 'Honorar  note'])).toEqual([
      'Rechnung',
      'Honorar note',
    ])
  })

  it('falls back to the suggested policy for an absent or malformed stored value', () => {
    expect(resolveUploadScreeningPolicy(undefined)).toBe(SUGGESTED_SCREENING_POLICY)
    expect(resolveUploadScreeningPolicy({ enabled: 'yes' })).toBe(SUGGESTED_SCREENING_POLICY)
  })

  it('reads a stored policy, including one that switched screening off', () => {
    const stored = { enabled: false, nameTerms: [], nameExceptions: [], contentTerms: [], detectors: [] }
    expect(resolveUploadScreeningPolicy(stored)).toEqual(stored)
  })

  it('sends content rules to ingest unless off, empty or released', () => {
    expect(toIngestScreening(policy(), { released: false })).toEqual({
      content_terms: SUGGESTED_SCREENING_POLICY.contentTerms,
      detectors: ['iban', 'at_svnr', 'credit_card'],
    })
    expect(toIngestScreening(policy(), { released: true })).toBeNull()
    expect(toIngestScreening(policy({ enabled: false }), { released: false })).toBeNull()
    expect(toIngestScreening(policy({ contentTerms: [], detectors: [] }), { released: false })).toBeNull()
  })
})
