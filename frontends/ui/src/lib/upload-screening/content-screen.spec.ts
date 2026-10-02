/**
 * @vitest-environment node
 */
/**
 * The content screen's contract with its Python twin
 * (`aiq_agent.common.content_screen`): every case in the shared fixture gives
 * the same matches, the same masked text and the same findings here as there,
 * and the placeholders are the ones Python defines. Python's half is
 * `tests/aiq_agent/common/test_content_screen.py`.
 *
 * ONE fixture, at the repo root, read from disk at run time: vitest runs in
 * `frontends/ui` with the whole repository checked out (CI's frontend jobs
 * check out the full tree). Not an `import`, so `tsc` never has to resolve a
 * path outside `frontends/ui` (`Dockerfile.typecheck` copies only that).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  SCREENING_PLACEHOLDERS,
  buildContentRules,
  chatScreeningRules,
  findSpans,
  foldContent,
  maskText,
} from './content-screen'
import { SUGGESTED_SCREENING_POLICY } from './policy'

interface FixtureCase {
  name: string
  terms: string[]
  detectors: string[]
  text: string
  matches: Array<{ kind: string; term?: string; text: string }>
  masked: string
  findings: Array<{ kind: string; term?: string; count: number; sample?: string }>
}

interface Fixture {
  placeholders: Record<string, string>
  cases: FixtureCase[]
}

const FIXTURE_PATH = join(
  process.cwd(),
  '..',
  '..',
  'tests',
  'fixtures',
  'content_screen_cases.json'
)
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture
const cases = fixture.cases

const IBAN = 'AT61 1904 3002 3457 3201'

describe('content screen: the shared fixture', () => {
  it('holds the placeholders Python defines, and this module mirrors them', () => {
    expect(SCREENING_PLACEHOLDERS).toEqual(fixture.placeholders)
  })

  it.each(cases.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    const rules = buildContentRules(testCase.terms, testCase.detectors)
    const spans = rules ? findSpans(testCase.text, rules) : []
    const matches = spans.map((span) => ({
      kind: span.kind,
      ...(span.term !== undefined ? { term: span.term } : {}),
      text: testCase.text.slice(span.start, span.end),
    }))
    const masked = maskText(testCase.text, rules)

    expect(matches).toEqual(testCase.matches)
    expect(masked.text).toBe(testCase.masked)
    expect(masked.findings).toEqual(testCase.findings)
    expect(maskText(masked.text, rules)).toEqual({ text: masked.text, findings: [] })
  })
})

describe('content screen: chat rules', () => {
  it('uses the content terms and detectors, never the name terms', () => {
    const rules = chatScreeningRules(SUGGESTED_SCREENING_POLICY)
    expect(rules?.terms).toEqual(SUGGESTED_SCREENING_POLICY.contentTerms)
    expect(rules?.detectors).toEqual(['iban', 'at_svnr', 'credit_card'])
    // „Rechnung" is a NAME term: a question about a Schlussrechnung is not masked.
    expect(maskText('Bitte prüfe die Schlussrechnung', rules).findings).toEqual([])
  })

  it('masks nothing when the office switched screening off', () => {
    expect(chatScreeningRules({ ...SUGGESTED_SCREENING_POLICY, enabled: false })).toBeNull()
    expect(maskText(`IBAN ${IBAN}`, null)).toEqual({ text: `IBAN ${IBAN}`, findings: [] })
  })

  it('masks nothing when both lists are empty', () => {
    const policy = { ...SUGGESTED_SCREENING_POLICY, contentTerms: [], detectors: [] }
    expect(chatScreeningRules(policy)).toBeNull()
  })

  it('reports no matched value, only the term or a masked sample', () => {
    const rules = chatScreeningRules(SUGGESTED_SCREENING_POLICY)
    const { findings } = maskText(`Lohnzettel und IBAN ${IBAN}, SVNR 1237 010180`, rules)
    const reported = JSON.stringify(findings)
    for (const value of [IBAN, 'AT611904300234573201', '1237 010180', '1237010180']) {
      expect(reported).not.toContain(value)
    }
    expect(findings).toEqual([
      { kind: 'term', term: 'Lohnzettel', count: 1 },
      { kind: 'iban', count: 1, sample: 'AT61 •••• •••• •••• 3201' },
      { kind: 'at_svnr', count: 1, sample: '•••• ••••80' },
    ])
  })

  it('folds per character, so a decomposed umlaut is the composed one', () => {
    expect(foldContent('Gehaltsübersicht')).toBe(foldContent('Gehaltsübersicht'))
    expect(foldContent('Straße')).toBe('strasse')
  })
})
