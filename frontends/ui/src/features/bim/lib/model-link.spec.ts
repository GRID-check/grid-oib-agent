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
    expect(buildModelHref('p1')).toBe('/app/projects/p1/files')
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

  it('says how many the cap left out, so the legend can stop under-reporting', () => {
    // The card resolved 200 elements; the link carries 60. Without the count
    // the receiving viewer's legend reads "(60)" beside an answer that said
    // 200, and nothing on the screen explains the difference.
    const globalIds = Array.from({ length: 200 }, (_, index) => `id${index}`)
    const parsed = parseModelView(buildModelQuery({ highlights: [{ status: 'info', globalIds }] }))
    expect(parsed.highlights?.[0].total).toBe(200)
  })

  it('carries a count larger than the ids the group was given', () => {
    // The caller already trimmed the group before handing it over and passes
    // the pre-trim count separately.
    const query = buildModelQuery({
      highlights: [{ status: 'fail', globalIds: ['a', 'b'], total: 420 }],
    })
    expect(parseModelView(query).highlights?.[0].total).toBe(420)
  })

  it('leaves a short, unlabelled group in the older two-part form', () => {
    // Nothing to say beyond the ids, so nothing is added: a hand-written link
    // and the one this produces are the same string.
    expect([
      ...new URLSearchParams(buildModelQuery({ highlights: [{ status: 'pass', globalIds: ['a'] }] })).getAll('hl'),
    ]).toEqual(['pass:a'])
  })
})

describe('the label a highlight travels with', () => {
  it('survives the round trip', () => {
    // The answer's own wording is the only thing that distinguishes two
    // failing groups from each other in the legend.
    const query = buildModelQuery({
      highlights: [
        { status: 'fail', label: 'Fluchtweg > 40 m', globalIds: ['a'] },
        { status: 'fail', label: 'Türbreite < 80 cm', globalIds: ['b'] },
      ],
    })
    expect(parseModelView(query).highlights).toEqual([
      { status: 'fail', label: 'Fluchtweg > 40 m', globalIds: ['a'] },
      { status: 'fail', label: 'Türbreite < 80 cm', globalIds: ['b'] },
    ])
  })

  it('survives a label containing the separators', () => {
    // `:` and `,` are the encoding's own punctuation and both occur in real
    // wording ("Geschoß 1: Wände, Decken"). Percent-encoding is what stops a
    // label from eating the id list.
    const label = 'Geschoß 1: Wände, Decken +2,60 m'
    const query = buildModelQuery({ highlights: [{ status: 'warning', label, globalIds: ['a', 'b'] }] })
    expect(parseModelView(query).highlights).toEqual([
      { status: 'warning', label, globalIds: ['a', 'b'] },
    ])
  })

  it('keeps a label and a count apart', () => {
    const label = 'Aussenwände +Dach'
    const globalIds = Array.from({ length: 90 }, (_, index) => `id${index}`)
    const [group] = parseModelView(buildModelQuery({ highlights: [{ status: 'fail', label, globalIds }] }))
      .highlights ?? []
    expect(group).toMatchObject({ label, total: 90 })
    expect(group.globalIds).toHaveLength(60)
  })

  it('still reads a link written before labels existed', () => {
    expect(parseModelView('?hl=fail:abc,def').highlights).toEqual([
      { status: 'fail', globalIds: ['abc', 'def'] },
    ])
  })

  it('keeps the highlight when a truncated paste breaks the label', () => {
    // `%` with nothing after it throws in `decodeURIComponent`. Losing the
    // wording is a much smaller failure than losing the elements.
    const view = parseModelView('?hl=fail:Fluchtweg%:abc')
    expect(view.highlights).toEqual([{ status: 'fail', globalIds: ['abc'] }])
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
