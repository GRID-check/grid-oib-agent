import { describe, expect, it } from 'vitest'
import {
  documentAliasKey,
  documentNameKey,
  documentNameVariants,
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
