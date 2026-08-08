/**
 * The model ↔ chat round trip.
 *
 * Out: a selected element becomes a question that still identifies the element
 * in a session that never saw the click. Back: a link an answer wrote is
 * recognised — and, more importantly, a link that only LOOKS internal is not.
 */

import { describe, expect, it } from 'vitest'
import {
  buildElementQuestion,
  describeElement,
  elementLinkHref,
  elementQuestionHref,
  parseElementLink,
} from './element-question'

const WALL = {
  globalId: '1kTvXnbbzCWw8lcMd1dR4o',
  ifcType: 'IfcWallStandardCase',
  name: 'AW 38',
  storeyName: 'Erdgeschoss',
}

describe('describeElement', () => {
  it('names an element the way a person would', () => {
    expect(describeElement(WALL)).toBe('Wall „AW 38“ (Erdgeschoss)')
  })

  it('falls back to the type when the model named nothing', () => {
    expect(describeElement({ globalId: 'g1', ifcType: 'IfcDoor', name: null })).toBe('Door')
  })

  it('ignores a name that is only whitespace', () => {
    expect(describeElement({ globalId: 'g1', ifcType: 'IfcSlab', name: '   ' })).toBe('Slab')
  })
})

describe('buildElementQuestion', () => {
  it('carries the GlobalId, because the next session did not see the click', () => {
    const question = buildElementQuestion(WALL, { modelFilename: 'haus-a.ifc' })
    expect(question).toContain('1kTvXnbbzCWw8lcMd1dR4o')
    expect(question).toContain('haus-a.ifc')
    expect(question).toContain('Wall „AW 38“')
  })

  it('works without a model name', () => {
    expect(buildElementQuestion(WALL)).toContain('(GlobalId 1kTvXnbbzCWw8lcMd1dR4o)')
  })

  it('encodes into the chat page’s existing prefill parameter', () => {
    const href = elementQuestionHref('p1', WALL)
    expect(href.startsWith('/app/projects/p1/chat?ask=')).toBe(true)
    const ask = new URL(href, 'https://example.test').searchParams.get('ask')
    expect(ask).toBe(buildElementQuestion(WALL))
  })
})

describe('parseElementLink', () => {
  it('recognises a model deep link and reads the view out of it', () => {
    const link = parseElementLink('/app/projects/p1/model?element=abc&xray=1')
    expect(link).toEqual({ projectId: 'p1', view: { element: 'abc', xray: true } })
  })

  it('recognises a bare model link', () => {
    expect(parseElementLink('/app/projects/p1/model')).toEqual({ projectId: 'p1', view: {} })
  })

  it('accepts an absolute URL, which is what a composed link looks like', () => {
    expect(parseElementLink('https://app.example/app/projects/p1/model?storey=EG')).toEqual({
      projectId: 'p1',
      view: { storey: 'EG' },
    })
  })

  it('refuses anything that is not a model page', () => {
    for (const href of [
      undefined,
      '',
      '/app/projects/p1/files',
      '/app/projects/p1/model/extra',
      '#cite-3',
      'https://example.com/phish',
    ]) {
      expect(parseElementLink(href)).toBeNull()
    }
  })

  it('keeps only the path of a foreign URL, so a chip can never leave the app', () => {
    // The host is not this module's business — its caller has already
    // established the href is same-origin — but the result is a PATH, so even
    // if that ever changed the worst case is a link to our own model page.
    const link = parseElementLink('https://evil.example/app/projects/p1/model?element=abc')
    expect(link).toEqual({ projectId: 'p1', view: { element: 'abc' } })
    expect(elementLinkHref(link!).startsWith('/app/')).toBe(true)
  })
})

describe('elementLinkHref', () => {
  it('rebuilds the href from the parsed view, dropping junk parameters', () => {
    const link = parseElementLink('/app/projects/p1/model?element=abc&utm_source=mail&hl=bogus')
    expect(link).not.toBeNull()
    expect(elementLinkHref(link!)).toBe('/app/projects/p1/model?element=abc')
  })
})
