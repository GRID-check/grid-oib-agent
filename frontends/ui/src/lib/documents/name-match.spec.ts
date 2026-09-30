import { describe, expect, it } from 'vitest'
import {
  distinctDocumentNames,
  documentAliasKey,
  documentNameCandidates,
  documentNameKey,
  documentNameVariants,
  firstFreeDocumentName,
  numberedDocumentName,
  originBaseName,
} from './name-match'

/**
 * The two spellings of one German filename. Written as escapes rather than as
 * literals, because a source file can only hold one of them and an editor,
 * a formatter or a copy-paste would silently normalize the other away — which
 * is the very failure these tests exist to catch.
 */
const COMPOSED = 'Pr\u00fcfbericht.pdf'
const DECOMPOSED = 'Pru\u0308fbericht.pdf'

describe('documentNameKey', () => {
  it('is the same key for the two Unicode spellings of one name', () => {
    expect(COMPOSED).not.toBe(DECOMPOSED)
    expect(documentNameKey(DECOMPOSED)).toBe(documentNameKey(COMPOSED))
  })

  it('settles on the composed form, which is what everything but macOS produces', () => {
    expect(documentNameKey(DECOMPOSED)).toBe(COMPOSED)
  })

  it('drops the whitespace a file manager leaves and nobody can see', () => {
    expect(documentNameKey('  Plan.pdf ')).toBe('Plan.pdf')
  })

  /*
   * Deliberate. Postgres holds `Plan.pdf` and `plan.pdf` as two rows, so a
   * planner that folded case here would promise to replace one while the server
   * inserted the other. Case is a question for `documentAliasKey`, whose answer
   * is a warning rather than an identity.
   */
  it('does not fold case, because the identity it stands for does not', () => {
    expect(documentNameKey('Plan.pdf')).not.toBe(documentNameKey('plan.pdf'))
  })
})

describe('documentNameVariants', () => {
  it('offers both spellings, so a row written before the key existed is still found', () => {
    expect(documentNameVariants(DECOMPOSED)).toEqual([COMPOSED, DECOMPOSED])
  })

  it('offers one candidate when the name has no second spelling', () => {
    expect(documentNameVariants('Plan.pdf')).toEqual(['Plan.pdf'])
  })
})

describe('documentAliasKey', () => {
  it('recognizes a name that differs only in case', () => {
    expect(documentAliasKey('DECKBLATT.pdf')).toBe(documentAliasKey('Deckblatt.pdf'))
  })

  it('recognizes across Unicode spellings too', () => {
    expect(documentAliasKey(DECOMPOSED.toUpperCase())).toBe(documentAliasKey(COMPOSED))
  })
})

describe('originBaseName', () => {
  it('is the filename out of the path a folder upload recorded', () => {
    expect(originBaseName('Wohnbau Nord/03_Einreichung/EG.pdf')).toBe('EG.pdf')
  })

  it('handles a Windows path, which is what a Windows office server hands over', () => {
    expect(originBaseName('Wohnbau\\Statik\\EG.pdf')).toBe('EG.pdf')
  })

  // Null rather than '', so a caller can key a map on the result without
  // inventing an entry that every unnamed document would then match.
  it('is null when there is no path and when the path names nothing', () => {
    expect(originBaseName(null)).toBeNull()
    expect(originBaseName('')).toBeNull()
    expect(originBaseName('///')).toBeNull()
  })
})

describe('numberedDocumentName', () => {
  it('numbers before the last extension, and leaves n = 1 as the name', () => {
    expect(numberedDocumentName('Plan.pdf', 1)).toBe('Plan.pdf')
    expect(numberedDocumentName('Plan.pdf', 2)).toBe('Plan (2).pdf')
    expect(numberedDocumentName('Archiv.tar.gz', 3)).toBe('Archiv.tar (3).gz')
  })

  it('numbers at the end when there is no extension, or the dot starts the name', () => {
    expect(numberedDocumentName('README', 2)).toBe('README (2)')
    expect(numberedDocumentName('.env', 2)).toBe('.env (2)')
  })

  it('works in the identity key, so both Unicode spellings number alike', () => {
    expect(numberedDocumentName(DECOMPOSED, 2)).toBe('Pr\u00fcfbericht (2).pdf')
    expect(numberedDocumentName('  Plan.pdf ', 2)).toBe('Plan (2).pdf')
  })
})

describe('documentNameCandidates', () => {
  it('yields the name, then its numbered forms, up to the limit', () => {
    expect([...documentNameCandidates('a.pdf', 3)]).toEqual(['a.pdf', 'a (2).pdf', 'a (3).pdf'])
  })
})

describe('firstFreeDocumentName', () => {
  it('is the name itself when nothing holds it', () => {
    expect(firstFreeDocumentName('Plan.pdf', () => false)).toBe('Plan.pdf')
  })

  it('asks about IDENTITY keys: another case is another name, another Unicode form is not', () => {
    const taken = new Set(['plan.pdf', 'Pr\u00fcfbericht.pdf'])
    expect(firstFreeDocumentName('Plan.pdf', (key) => taken.has(key))).toBe('Plan.pdf')
    expect(firstFreeDocumentName(DECOMPOSED, (key) => taken.has(key))).toBe('Pr\u00fcfbericht (2).pdf')
  })

  it('throws past the limit rather than looping', () => {
    expect(() => firstFreeDocumentName('a.pdf', () => true, 5)).toThrow(/5 candidates/)
  })
})

describe('distinctDocumentNames', () => {
  it('numbers repeats in order, and keeps the first one as it was', () => {
    expect(distinctDocumentNames(['Plan.pdf', 'Plan.pdf', 'Plan.pdf', 'Schnitt.pdf'])).toEqual([
      'Plan.pdf',
      'Plan (2).pdf',
      'Plan (3).pdf',
      'Schnitt.pdf',
    ])
  })

  it('steps over a name the batch already holds in numbered form', () => {
    expect(distinctDocumentNames(['a (2).pdf', 'a.pdf', 'a.pdf'])).toEqual(['a (2).pdf', 'a.pdf', 'a (3).pdf'])
  })

  it('treats the two Unicode spellings as one name', () => {
    expect(distinctDocumentNames([COMPOSED, DECOMPOSED])).toEqual([COMPOSED, 'Pr\u00fcfbericht (2).pdf'])
  })

  it('stays linear: a thousand copies of one name do not rescan from 1 each time', () => {
    const names = Array.from({ length: 1000 }, () => 'Plan.pdf')
    const out = distinctDocumentNames(names)
    expect(new Set(out).size).toBe(1000)
    expect(out.at(-1)).toBe('Plan (1000).pdf')
  })
})
