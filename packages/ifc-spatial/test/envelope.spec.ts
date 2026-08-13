/**
 * `triangulate()` — two independent routes to the same number.
 *
 * The interesting behaviour is not the arithmetic but the stance: when the two
 * routes disagree, the COMPUTED value wins and the disagreement is published as
 * a caveat about the export. A caller that drops the caveat is reporting a
 * number the file itself contradicts.
 */

import { describe, it, expect } from 'vitest'
import { declared, computed, inferred, undecidable, triangulate } from '../src/envelope.js'
import type { Answer } from '../src/envelope.js'

const schedule = (value: number): Answer<number> =>
  declared(value, { unit: 'm²', from: ['SPACE-1'], method: 'Qto_SpaceBaseQuantities.NetFloorArea' })

const geometry = (value: number): Answer<number> =>
  computed(value, { unit: 'm²', tolerance: 0.01, from: ['SPACE-1', 'SLAB-1'], method: 'polygon area of the floor boundary' })

const nothing = (what: string): Answer<number> =>
  undecidable<number>({
    from: ['SPACE-1'],
    method: 'Qto_SpaceBaseQuantities.NetFloorArea',
    missing: { what, remedy: `${what} im Export mitschreiben` },
  })

describe('triangulate — the two routes agree', () => {
  it('reports agreement inside the default 2 % band', () => {
    const result = triangulate(schedule(24.5), geometry(24.7), { method: 'Raumflaeche' })
    expect(result.agreement).toBe('agree')
    expect(result.decidable).toBe(true)
    // Inside the band the declared value is kept — the file is not under suspicion.
    expect(result.value).toBe(24.5)
    expect(result.provenance).toBe('declared')
    expect(result.caveat).toBeUndefined()
  })

  it('renames the method and unions the sources', () => {
    const result = triangulate(schedule(24.5), geometry(24.7), { method: 'Raumflaeche' })
    expect(result.method).toBe('Raumflaeche')
    expect(result.from).toEqual(['SPACE-1', 'SLAB-1'])
    expect(result.unit).toBe('m²')
  })

  it('honours a tighter tolerance', () => {
    // 24.5 vs 24.7 is 0.81 % — agreement at 2 %, disagreement at 0.5 %.
    expect(triangulate(schedule(24.5), geometry(24.7), { relativeTolerance: 0.02, method: 'm' }).agreement).toBe('agree')
    expect(triangulate(schedule(24.5), geometry(24.7), { relativeTolerance: 0.005, method: 'm' }).agreement).toBe(
      'disagree'
    )
  })

  it('treats two identical values as agreement even at zero', () => {
    const result = triangulate(schedule(0), geometry(0), { method: 'Nullwert' })
    expect(result.agreement).toBe('agree')
    expect(result.value).toBe(0)
  })
})

describe('triangulate — the two routes disagree', () => {
  const result = triangulate(schedule(20), geometry(25), { method: 'Raumflaeche' })

  it('reports the disagreement', () => {
    expect(result.agreement).toBe('disagree')
    expect(result.decidable).toBe(true)
  })

  it('lets the COMPUTED value win over the declared one', () => {
    expect(result.value).toBe(25)
    expect(result.provenance).toBe('computed')
    expect(result.tolerance).toBe(0.01)
  })

  it('wins for the computed route whichever argument it is', () => {
    const swapped = triangulate(geometry(25), schedule(20), { method: 'Raumflaeche' })
    expect(swapped.agreement).toBe('disagree')
    expect(swapped.value).toBe(25)
    expect(swapped.provenance).toBe('computed')
  })

  it('sets a German caveat naming both numbers, both routes and the deviation', () => {
    expect(result.caveat).toBeDefined()
    expect(result.caveat).toContain('Zwei Wege zu dieser Zahl widersprechen sich')
    expect(result.caveat).toContain('20 (declared)')
    expect(result.caveat).toContain('25 (computed)')
    expect(result.caveat).toContain('Abweichung 20.0 %')
    expect(result.caveat).toContain('Befund über den Export, nicht über das Gebäude')
  })

  it('keeps both sources so the disagreement can be audited', () => {
    expect(result.from).toEqual(['SPACE-1', 'SLAB-1'])
  })

  it('falls back to the second route when neither side is computed', () => {
    const heuristic = inferred(30, {
      unit: 'm²',
      from: ['SPACE-1'],
      method: 'Flaeche aus Raumtyp geschaetzt',
      confidence: 0.4,
      because: ['kein Qto', 'keine Geometrie'],
    })
    const result = triangulate(schedule(20), heuristic, { method: 'Raumflaeche' })
    expect(result.agreement).toBe('disagree')
    // Neither is computed, so `b` is taken as written in the source.
    expect(result.value).toBe(30)
    expect(result.provenance).toBe('inferred')
    expect(result.caveat).toContain('20 (declared)')
    expect(result.caveat).toContain('30 (inferred)')
  })
})

describe('triangulate — only one route exists', () => {
  it('returns the decidable route unchanged, marked single', () => {
    const result = triangulate(schedule(24.5), nothing('Geometrie'), { method: 'Raumflaeche' })
    expect(result.agreement).toBe('single')
    expect(result.decidable).toBe(true)
    expect(result.value).toBe(24.5)
    expect(result.provenance).toBe('declared')
    expect(result.method).toBe('Raumflaeche')
    expect(result.from).toEqual(['SPACE-1'])
    expect(result.caveat).toBeUndefined()
  })

  it('works when it is the FIRST route that is missing', () => {
    const result = triangulate(nothing('Qto_SpaceBaseQuantities'), geometry(24.7), { method: 'Raumflaeche' })
    expect(result.agreement).toBe('single')
    expect(result.value).toBe(24.7)
    expect(result.provenance).toBe('computed')
    expect(result.from).toEqual(['SPACE-1', 'SLAB-1'])
  })

  it('does not treat a decidable-but-null answer as a route', () => {
    const empty: Answer<number> = { ...schedule(0), value: null }
    const result = triangulate(empty, geometry(24.7), { method: 'Raumflaeche' })
    expect(result.agreement).toBe('single')
    // `both` requires a numeric value on each side, so this falls to the single
    // branch — and `a.decidable` is still true, so `a` is what comes back.
    expect(result.value).toBeNull()
  })
})

describe('triangulate — both routes undecidable', () => {
  const result = triangulate(nothing('Qto_SpaceBaseQuantities'), nothing('Geometrie'), { method: 'Raumflaeche' })

  it('stays undecidable rather than throwing', () => {
    expect(result.decidable).toBe(false)
    expect(result.value).toBeNull()
    expect(result.unit).toBeNull()
    expect(result.agreement).toBe('single')
  })

  it('carries the first route`s missing fact, which is actionable', () => {
    expect(result.missing).toBeDefined()
    expect(result.missing!.what).toBe('Qto_SpaceBaseQuantities')
    expect(result.missing!.remedy).toContain('mitschreiben')
  })

  it('keeps both sets of sources so the reader knows what was looked at', () => {
    expect(result.from).toEqual(['SPACE-1', 'SPACE-1'])
    expect(result.method).toBe('Raumflaeche')
  })

  it('invents a missing fact when neither route named one', () => {
    const bare = (): Answer<number> => ({
      value: null,
      unit: null,
      tolerance: null,
      provenance: 'declared',
      from: [],
      method: 'nichts',
      decidable: false,
    })
    const result = triangulate(bare(), bare(), { method: 'Raumflaeche' })
    expect(result.decidable).toBe(false)
    expect(result.missing).toEqual({ what: 'both routes', remedy: 'no route to this value in this file' })
  })
})
