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
 *
 * The fixture also holds the character tables Python computed (whitespace,
 * decimal digits, letter/number/mark classes, the fold of every code point, the
 * IBAN registry). This spec checks its own against them for every code point,
 * so the twins agree beyond the cases listed.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  IBAN_LENGTHS,
  SCREENING_PLACEHOLDERS,
  SCREENING_WHITESPACE,
  buildContentRules,
  chatScreeningRules,
  decimalDigitValue,
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
  unicode: {
    version: string
    whitespace: number[]
    decimal_zeros: number[]
    classes_sha256: string
    fold_sha256: string
  }
  iban_lengths: Record<string, number>
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

function allCodePoints(): number[] {
  const out: number[] = []
  for (let cp = 0; cp <= 0x10ffff; cp += 1) if (cp < 0xd800 || cp > 0xdfff) out.push(cp)
  return out
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('content screen: the character tables Python is held to too', () => {
  const codePoints = allCodePoints()

  // The fixture is Python's Unicode version. Node may be newer (CI follows the
  // latest 22.x), and a newer version only ASSIGNS characters: Unicode's
  // stability policy keeps the class and case mapping of assigned ones. So the
  // tables compare over the fixture version's assigned code points, and a
  // newer runtime may add digits only among code points that version left
  // unassigned. An OLDER runtime would miss characters Python knows.
  const assigned: number[] = fixture.unicode.assigned_ranges.flatMap(
    ([start, end]: [number, number]) => Array.from({ length: end - start + 1 }, (_, i) => start + i)
  )
  const assignedSet = new Set(assigned)

  it("runs on the fixture's Unicode version or a newer one", () => {
    const [major, minor] = (process.versions.unicode ?? '0.0').split('.').map(Number)
    const [wantMajor, wantMinor] = fixture.unicode.version.split('.').map(Number)
    expect(major > wantMajor || (major === wantMajor && minor >= wantMinor)).toBe(true)
  })

  it('takes whitespace to be exactly the White_Space property, as Python does', () => {
    const whiteSpace = /\p{White_Space}/u
    const listed = [...SCREENING_WHITESPACE].map((char) => char.codePointAt(0))
    expect(listed).toEqual(fixture.unicode.whitespace)
    expect(codePoints.filter((cp) => whiteSpace.test(String.fromCodePoint(cp)))).toEqual(
      fixture.unicode.whitespace
    )
  })

  it('reads every decimal digit as the value Python reads', () => {
    const expected = new Map<number, number>()
    for (const zero of fixture.unicode.decimal_zeros) {
      for (let value = 0; value < 10; value += 1) expected.set(zero + value, value)
    }
    const actual = new Map<number, number>()
    for (const cp of codePoints) {
      const value = decimalDigitValue(cp)
      if (value !== null) actual.set(cp, value)
    }
    expect(expected.size).toBe(760)
    for (const [cp, value] of expected) expect([cp, actual.get(cp)]).toEqual([cp, value])
    const added = [...actual.keys()].filter((cp) => !expected.has(cp))
    expect(added.filter((cp) => assignedSet.has(cp))).toEqual([])
  })

  it('classes every assigned code point as a letter, number or mark as Python does', () => {
    const [letter, number, mark] = [/\p{L}/u, /\p{N}/u, /\p{M}/u]
    const classes = assigned.map((cp) => {
      const char = String.fromCodePoint(cp)
      if (letter.test(char)) return 'L'
      if (number.test(char)) return 'N'
      return mark.test(char) ? 'M' : '-'
    })
    expect(sha256(classes.join(''))).toBe(fixture.unicode.classes_sha256)
  })

  it('folds every assigned code point as Python does', { timeout: 60_000 }, () => {
    const folded = assigned.map((cp) => foldContent(String.fromCodePoint(cp)))
    expect(sha256(folded.join('\n'))).toBe(fixture.unicode.fold_sha256)
  })

  it('holds the IBAN registry Python defines', () => {
    expect(Object.fromEntries(IBAN_LENGTHS)).toEqual(fixture.iban_lengths)
  })
})

describe('content screen: every match in one pass, and masking is a fixpoint', () => {
  const IBANS = [
    'AT611904300234573201',
    'DE89370400440532013000',
    'GB29NWBK60161331926819',
    'CH9300762011623852957',
  ]
  const CARDS = ['4111111111111111', '5555555555554444', '378282246310005']
  const SEPARATORS = [' ', '  ', '\t', '\n', '-', '.', '\u00a0', '\u202f', '']
  const DETECTORS = ['iban', 'at_svnr', 'credit_card']
  const grouped = (compact: string, separator: string) =>
    (compact.match(/.{1,4}/g) ?? []).join(separator)

  it('finds fifty IBANs in a row in one pass', () => {
    const text = Array<string>(50).fill(IBAN).join(' ')
    const rules = buildContentRules([], ['iban'])
    expect(rules && findSpans(text, rules)).toHaveLength(50)
    expect(maskText(text, rules).text).toBe(Array<string>(50).fill('[IBAN entfernt]').join(' '))
  })

  it('leaves no number of fifty IBANs each followed by a card', () => {
    const text = Array.from(
      { length: 50 },
      (_, i) => `${grouped(IBANS[i % 4], ' ')} ${grouped(CARDS[i % 3], ' ')}`
    ).join(' ')
    const masked = maskText(text, buildContentRules([], DETECTORS))
    expect(masked.text).not.toMatch(/[0-9]/)
    expect(masked.findings.map((f) => [f.kind, f.count])).toEqual([
      ['iban', 50],
      ['credit_card', 50],
    ])
  })

  it('masks any generated text to a fixpoint', () => {
    // mulberry32: a seeded generator, so a failure names the seed that reproduces it.
    const seeded = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const rules = buildContentRules(
      ['Honorar', 'Lohn Steuer', 'οδος', 'IBAN', 'entfernt'],
      DETECTORS
    )
    for (let seed = 0; seed < 300; seed += 1) {
      const random = seeded(seed)
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
      const blocks = [
        () => grouped(pick(IBANS), pick(SEPARATORS)),
        () => pick(IBANS).toLowerCase(),
        () =>
          // one IBAN, printed again and again
          Array<string>(2 + Math.floor(random() * 11))
            .fill(grouped(pick(IBANS), ' '))
            .join(' '),
        () => grouped(pick(CARDS), pick(SEPARATORS)) + pick(['', ' 123', ' 4567']),
        () => '1237' + pick(SEPARATORS) + pick(['010180', '01 01 80', '01.01.80']),
        () => pick(Object.values(SCREENING_PLACEHOLDERS)),
        () => pick(['Honorarvereinbarung', 'Lohn\nSteuer', 'IBAN', 'entfernt', 'ΟΔΟΣ', 'ẗHonorar']),
        () =>
          Array.from({ length: 1 + Math.floor(random() * 12) }, () =>
            pick([...'0123456789 -.AT[]x\u0660\uff11'])
          ).join(''),
      ]
      const count = pick([1, 3, 8, 50])
      const text = Array.from(
        { length: count },
        () => pick(['', ' ', '\n', ', ', 'x']) + pick(blocks)()
      ).join('')
      const once = maskText(text, rules)
      expect({ seed, again: maskText(once.text, rules) }).toEqual({
        seed,
        again: { text: once.text, findings: [] },
      })
    }
  })
})
