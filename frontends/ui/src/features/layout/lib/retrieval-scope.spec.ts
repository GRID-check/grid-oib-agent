/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { includeShelvesForTurn } from './retrieval-scope'

describe('includeShelvesForTurn', () => {
  test('a session upload drops the project and the Archiv — but never the law', () => {
    expect(includeShelvesForTurn({ subjectShelf: 'session', preset: 'project' })).toEqual([
      'session',
      'base',
    ])
  })

  test('asking about a project file drops the Archiv', () => {
    expect(includeShelvesForTurn({ subjectShelf: 'project' })).toEqual([
      'project',
      'session',
      'base',
    ])
  })

  test('asking about an Archiv file drops the project corpus', () => {
    expect(includeShelvesForTurn({ subjectShelf: 'archiv' })).toEqual([
      'archiv',
      'session',
      'base',
    ])
  })

  /**
   * A subject says which DOCUMENTS the turn is about. It is not a statement
   * that the reader no longer wants the building code applied — and applying it
   * is what this product is for. The asymmetry that exposed the bug is pinned
   * two tests down: the `project` PRESET always kept `base`, and the `project`
   * SHELF did not, although a reader reaches for either to say the same thing.
   */
  test('no subject shelf costs the turn its building code', () => {
    for (const subjectShelf of ['session', 'project', 'archiv'] as const) {
      expect(includeShelvesForTurn({ subjectShelf })).toContain('base')
    }
  })

  test('the Projektunterlagen chip keeps law + session, not the Büroarchiv', () => {
    expect(includeShelvesForTurn({ preset: 'project' })).toEqual(['project', 'session', 'base'])
  })

  test('the Büroarchiv chip keeps law + session, not project files', () => {
    expect(includeShelvesForTurn({ preset: 'office' })).toEqual(['archiv', 'session', 'base'])
  })

  test('the Baurecht chip stays on the base corpus', () => {
    expect(includeShelvesForTurn({ preset: 'law' })).toEqual(['base'])
  })

  test('no commitment leaves the signed scope alone', () => {
    expect(includeShelvesForTurn({})).toBeUndefined()
  })
})
