/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { labelVisit, previousVisit, recordVisit, type ReturnTrail } from './return-trail'

/** A trail of plain, unnamed visits — the shape the recorder writes. */
const visits = (...paths: string[]): ReturnTrail => paths.map((path) => ({ path }))

describe('recordVisit', () => {
  test('appends each new location in visit order', () => {
    let trail = recordVisit([], '/app/projects')
    trail = recordVisit(trail, '/app/projects/p1/files')
    trail = recordVisit(trail, '/app/archiv')
    expect(trail).toEqual(visits('/app/projects', '/app/projects/p1/files', '/app/archiv'))
  })

  test('collapses a repeat of the current location (a replace is not a step)', () => {
    const trail = recordVisit(visits('/app/archiv'), '/app/archiv')
    expect(trail).toEqual(visits('/app/archiv'))
  })

  test('unwinds to an earlier location instead of stacking a second copy', () => {
    // The browser Back case: A → B → back to A leaves the same stack a fresh
    // walk to A would, so the entry below the top is still the true previous.
    const trail = recordVisit(
      visits('/app/projects', '/app/projects/p1/files', '/app/archiv'),
      '/app/projects/p1/files'
    )
    expect(trail).toEqual(visits('/app/projects', '/app/projects/p1/files'))
  })

  test('keeps the trail bounded, dropping the oldest entries', () => {
    let trail: ReturnTrail = []
    for (let i = 0; i < 20; i++) trail = recordVisit(trail, `/app/projects/p${i}`)
    expect(trail).toHaveLength(12)
    expect(trail[0].path).toBe('/app/projects/p8')
    expect(trail.at(-1)?.path).toBe('/app/projects/p19')
  })

  test('ignores an empty path', () => {
    expect(recordVisit(visits('/app/archiv'), '')).toEqual(visits('/app/archiv'))
  })

  test('returns the same trail object when nothing changed, so callers can skip the write', () => {
    const trail = visits('/app/archiv')
    expect(recordVisit(trail, '/app/archiv')).toBe(trail)
  })
})

describe('previousVisit', () => {
  test('returns the location one step back', () => {
    expect(previousVisit(visits('/app/projects/p1/files', '/app/archiv'), '/app/archiv')).toEqual({
      path: '/app/projects/p1/files',
    })
  })

  test('returns null for the first location of the session', () => {
    expect(previousVisit(visits('/app/archiv'), '/app/archiv')).toBeNull()
  })

  test('returns null with no trail at all (new tab, direct link)', () => {
    expect(previousVisit([], '/app/archiv')).toBeNull()
  })

  test('refuses to answer for a page that is not the top of the stack', () => {
    // The trail has moved on: guessing a "back" for a stale page would send the
    // reader somewhere `history.back()` does not go.
    expect(
      previousVisit(visits('/app/projects', '/app/archiv', '/app/inbox'), '/app/archiv')
    ).toBeNull()
  })
})

describe('labelVisit', () => {
  test('names a location on the trail, and the name survives a later unwind to it', () => {
    let trail = labelVisit(
      visits('/app/projects/p1/files', '/app/archiv'),
      '/app/projects/p1/files',
      'Stadthaus Wien'
    )
    expect(previousVisit(trail, '/app/archiv')).toEqual({
      path: '/app/projects/p1/files',
      label: 'Stadthaus Wien',
    })

    trail = recordVisit(trail, '/app/projects/p1/files')
    expect(trail.at(-1)).toEqual({ path: '/app/projects/p1/files', label: 'Stadthaus Wien' })
  })

  test('ignores a name for a location that was never recorded', () => {
    const trail = visits('/app/archiv')
    expect(labelVisit(trail, '/app/projects/p9', 'Ghost')).toBe(trail)
  })

  test('ignores an empty name and a name that changes nothing', () => {
    const trail = [{ path: '/app/projects/p1', label: 'Stadthaus Wien' }]
    expect(labelVisit(trail, '/app/projects/p1', '')).toBe(trail)
    expect(labelVisit(trail, '/app/projects/p1', 'Stadthaus Wien')).toBe(trail)
  })
})
