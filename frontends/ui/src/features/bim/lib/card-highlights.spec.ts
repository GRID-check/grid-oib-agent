/**
 * The boundary between a card payload and the viewer.
 *
 * Two things are being defended here. The generated zod renders a nested
 * `$ref` as `z.any()`, so nothing upstream checks a highlight's fields — this
 * module is the check. And a filter that reaches the query endpoint malformed
 * is rejected WHOLE, so one invented key would blank a group rather than
 * narrowing it.
 */

import { describe, expect, it } from 'vitest'
import { cardHighlightSpecs, matchToFilter } from './card-highlights'

describe('matchToFilter', () => {
  it('respells the card grammar as the query grammar', () => {
    // Same grammar, two conventions: the card is authored in Python and
    // carries snake_case; `bimFilterSchema` speaks camelCase.
    expect(
      matchToFilter({
        ifc_types: ['IfcWall'],
        storeys: ['Erdgeschoss'],
        name_contains: 'AW',
        material: 'Beton',
      })
    ).toEqual({
      ifcTypes: ['IfcWall'],
      storeys: ['Erdgeschoss'],
      nameContains: 'AW',
      material: 'Beton',
    })
  })

  it('carries a property predicate, which is the half a client filter could not do', () => {
    // The element index the browser holds has no properties on it, so
    // "external walls" is only answerable by replaying the filter server-side.
    expect(
      matchToFilter({
        ifc_types: ['IfcWall'],
        properties: [{ set: 'Pset_WallCommon', name: 'IsExternal', operator: 'eq', value: true }],
      })
    ).toEqual({
      ifcTypes: ['IfcWall'],
      properties: [{ name: 'IsExternal', set: 'Pset_WallCommon', operator: 'eq', value: true }],
    })
  })

  it('reads either spelling of a key', () => {
    // `ifc_query` writes camelCase and the card is authored in snake_case. The
    // Python model normalises on the way in, but a card stored before those
    // aliases existed carries whichever the agent wrote, and a message is
    // replayed from storage long after the schema moved on.
    expect(matchToFilter({ ifcTypes: ['IfcWall'], nameContains: 'AW' })).toEqual({
      ifcTypes: ['IfcWall'],
      nameContains: 'AW',
    })
  })

  it('carries a classification filter, which the query grammar supports', () => {
    expect(matchToFilter({ classification: 'B.1.2' })).toEqual({ classification: 'B.1.2' })
  })

  it('trims what it forwards, not only what it tests', () => {
    // `nameContains: ' AW '` is a substring match on the spaces too, so it
    // matches fewer elements than the author meant.
    expect(matchToFilter({ name_contains: '  AW  ' })).toEqual({ nameContains: 'AW' })
    expect(matchToFilter({ ifc_types: [' IfcWall ', '  '] })).toEqual({ ifcTypes: ['IfcWall'] })
  })

  it('drops an invented enum VALUE, not just an invented key', () => {
    // The endpoint rejects `operator: 'like'` exactly as hard as an unknown
    // key, and it takes the whole filter — and the whole group — with it.
    // Dropping it narrows the predicate instead, which the group survives.
    expect(matchToFilter({ properties: [{ name: 'FireRating', operator: 'like', source: 'blob' }] })).toEqual({
      properties: [{ name: 'FireRating' }],
    })
  })

  it('drops a key the endpoint does not know rather than losing the query', () => {
    // Strict validation server-side: forwarding an invented key would reject
    // the whole filter and blank a group over the one field that was wrong.
    expect(matchToFilter({ ifc_types: ['IfcWall'], colour: 'red' })).toEqual({ ifcTypes: ['IfcWall'] })
  })

  it('refuses a filter with no criterion at all', () => {
    // An empty filter means "every element in the building", which would
    // highlight the whole model under a label like "fails the clearance".
    expect(matchToFilter({})).toBeNull()
    expect(matchToFilter({ ifc_types: [] })).toBeNull()
    expect(matchToFilter({ name_contains: '   ' })).toBeNull()
    expect(matchToFilter(null)).toBeNull()
    expect(matchToFilter('IfcWall')).toBeNull()
  })

  it('refuses a property predicate with no property name', () => {
    expect(matchToFilter({ properties: [{ operator: 'exists' }] })).toBeNull()
  })

  it('keeps a predicate that legitimately has no value', () => {
    // `missing` is the operator behind "which walls publish no FireRating",
    // which is the single most useful highlight this card can draw.
    expect(matchToFilter({ properties: [{ name: 'FireRating', operator: 'missing' }] })).toEqual({
      properties: [{ name: 'FireRating', operator: 'missing' }],
    })
  })
})

describe('cardHighlightSpecs', () => {
  it('passes an id list straight through', () => {
    expect(cardHighlightSpecs([{ global_ids: ['0Grid1'], label: 'T-14', status: 'fail' }])).toEqual([
      { globalIds: ['0Grid1'], label: 'T-14', status: 'fail' },
    ])
  })

  it('turns a match into a filter spec', () => {
    expect(
      cardHighlightSpecs([{ match: { ifc_types: ['IfcWall'] }, label: 'Wände', status: 'info' }])
    ).toEqual([{ match: { ifcTypes: ['IfcWall'] }, label: 'Wände', status: 'info' }])
  })

  it('defaults an unrecognised status to neutral rather than to a verdict', () => {
    // Guessing `fail` would state a breach the card never claimed.
    const [spec] = cardHighlightSpecs([{ global_ids: ['0Grid1'], label: 'x', status: 'kaputt' }])
    expect(spec.status).toBe('info')
  })

  it('drops a group that can never colour anything', () => {
    // A legend entry with no selector reads as "nothing matched" rather than
    // "this was malformed", which is a wrong answer rendered confidently.
    expect(cardHighlightSpecs([{ label: 'Wände', status: 'info' }])).toEqual([])
    expect(cardHighlightSpecs([{ global_ids: [], match: {}, label: 'Wände', status: 'info' }])).toEqual([])
  })

  it('drops a group with no label, and keeps the rest', () => {
    expect(
      cardHighlightSpecs([
        { global_ids: ['0Grid1'], status: 'fail' },
        { global_ids: ['0Grid2'], label: 'keep', status: 'pass' },
      ])
    ).toEqual([{ globalIds: ['0Grid2'], label: 'keep', status: 'pass' }])
  })

  it('prefers the id list when a malformed card carries both', () => {
    // The Python model refuses this combination, but a card can also arrive
    // from a stored message written before that validator existed — this side
    // must not depend on the other side's validation having run.
    expect(
      cardHighlightSpecs([
        { global_ids: ['0Grid1'], match: { ifc_types: ['IfcWall'] }, label: 'x', status: 'info' },
      ])
    ).toEqual([{ globalIds: ['0Grid1'], label: 'x', status: 'info' }])
  })
})
