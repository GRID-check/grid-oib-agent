/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { includeShelvesForTurn } from './retrieval-scope'

describe('includeShelvesForTurn', () => {
  test('a session upload is only that file\'s shelf — not the project or Archiv', () => {
    expect(includeShelvesForTurn({ subjectShelf: 'session', preset: 'project' })).toEqual([
      'session',
    ])
  })

  test('asking about a project file drops the Archiv', () => {
    expect(includeShelvesForTurn({ subjectShelf: 'project' })).toEqual(['project', 'session'])
  })

  test('asking about an Archiv file drops the project corpus', () => {
    expect(includeShelvesForTurn({ subjectShelf: 'archiv' })).toEqual(['archiv', 'session'])
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
