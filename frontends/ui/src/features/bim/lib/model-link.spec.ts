/**
 * Addressable model views.
 *
 * The contract is that a link survives a round trip through a chat message: an
 * agent builds one, a person pastes it, and the page opens on the same element.
 * Both halves are pinned here, including the degradations — a truncated paste
 * has to lose highlights, not fail to open.
 */

import { describe, expect, it } from 'vitest'
import { buildModelHref, buildModelQuery, parseModelView, withModelView } from './model-link'

describe('buildModelQuery', () => {
  it('is empty for an empty view, so a bare link stays bare', () => {
    expect(buildModelQuery({})).toBe('')
    expect(buildModelHref('p1')).toBe('/app/projects/p1/model')
  })

  it('encodes the view a card or an answer points at', () => {
    const href = buildModelHref('p1', {
      model: 'haus-a.ifc',
      storey: 'Erdgeschoss',
      element: '1kTvXnbbzCWw8lcMd1dR4o',
      highlights: [{ status: 'fail', globalIds: ['1kTvXnbbzCWw8lcMd1dR4o', '0RSwXnbbzCWw8lcMd1dR9z'] }],
      xray: true,
    })
    expect(href).toContain('model=haus-a.ifc')
    expect(href).toContain('storey=Erdgeschoss')
    expect(href).toContain('element=1kTvXnbbzCWw8lcMd1dR4o')
    expect(href).toContain('hl=fail%3A1kTvXnbbzCWw8lcMd1dR4o%2C0RSwXnbbzCWw8lcMd1dR9z')
    expect(href).toContain('xray=1')
  })

  it('emits one parameter per status group', () => {
    const query = buildModelQuery({
      highlights: [
        { status: 'pass', globalIds: ['a'] },
        { status: 'fail', globalIds: ['b'] },
      ],
    })
    expect([...new URLSearchParams(query).getAll('hl')]).toEqual(['pass:a', 'fail:b'])
  })

  it('drops an empty highlight group rather than emitting a bare status', () => {
    expect(buildModelQuery({ highlights: [{ status: 'info', globalIds: [] }] })).toBe('')
  })

  it('caps the ids in one group so a link stays followable', () => {
    const globalIds = Array.from({ length: 200 }, (_, index) => `id${index}`)
    const parsed = parseModelView(buildModelQuery({ highlights: [{ status: 'info', globalIds }] }))
    expect(parsed.highlights?.[0].globalIds).toHaveLength(60)
  })
})

describe('parseModelView', () => {
  it('round-trips a full view', () => {
    const view = {
      model: 'haus-a.ifc',
      storey: 'Obergeschoss',
      element: 'abc',
      highlights: [{ status: 'warning' as const, globalIds: ['abc', 'def'] }],
      xray: true,
    }
    expect(parseModelView(buildModelQuery(view))).toEqual(view)
  })

  it('reads a partial link, because most links are partial', () => {
    expect(parseModelView('?storey=Erdgeschoss')).toEqual({ storey: 'Erdgeschoss' })
  })

  it('drops a malformed highlight instead of failing the whole parse', () => {
    // A link that lost half its highlights in a paste should still open the
    // model at the right storey.
    const view = parseModelView('?storey=EG&hl=nonsense&hl=&hl=fail:abc')
    expect(view.storey).toBe('EG')
    expect(view.highlights).toEqual([{ status: 'fail', globalIds: ['abc'] }])
  })

  it('ignores an unknown status', () => {
    expect(parseModelView('?hl=catastrophe:abc').highlights).toBeUndefined()
  })

  it('treats any xray value other than 1 as off', () => {
    expect(parseModelView('?xray=1').xray).toBe(true)
    expect(parseModelView('?xray=true').xray).toBeUndefined()
  })
})

describe('withModelView', () => {
  it('keeps the highlights a link arrived with when the storey changes', () => {
    const arrived = parseModelView('?model=a.ifc&hl=fail:abc')
    expect(withModelView(arrived, { storey: 'OG' })).toEqual({
      model: 'a.ifc',
      highlights: [{ status: 'fail', globalIds: ['abc'] }],
      storey: 'OG',
    })
  })

  it('removes a key rather than emitting an empty parameter', () => {
    const cleared = withModelView({ model: 'a.ifc', element: 'abc' }, { element: undefined })
    expect(cleared).toEqual({ model: 'a.ifc' })
    expect(buildModelQuery(cleared)).toBe('?model=a.ifc')
  })

  it('treats false as "remove", so turning x-ray off clears the parameter', () => {
    expect(withModelView({ xray: true }, { xray: false })).toEqual({})
  })
})
