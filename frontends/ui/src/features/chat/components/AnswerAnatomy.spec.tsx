import { render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, test } from 'vitest'
import { I18nProvider } from '@/i18n'
import type { GridCard } from '@/shared/cards/schemas'
import { answerMetaToAnatomy } from '../lib/answer-meta-cards'
import { AnatomyMasthead } from './AnswerAnatomy'

/**
 * The answer's masthead: verdict (when earned), else topic, then the summary
 * standfirst — one hairline over the prose, whatever it holds.
 *
 * The reader is Austrian, so the copy is pinned in German (`fixedLocale`,
 * like the card specs); what is asserted here is structure and order, not
 * wording.
 */
const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

const verdictCard: GridCard = {
  type: 'verdict_header',
  verdict: 'REI 60',
  subject: 'Feuerwiderstand tragender Bauteile',
  reference: {
    document: 'OIB-Richtlinie 2',
    section: 'Tabelle 1b',
    edition: 'Ausgabe Mai 2023',
    excerpt: null,
  },
  confidence: null,
  confidence_reason: null,
}

const header = (container: HTMLElement): HTMLElement => {
  const found = container.querySelector('header')
  expect(found, 'the masthead always closes over one hairline').not.toBeNull()
  expect(found?.className).toContain('border-b')
  return found as HTMLElement
}

describe('AnatomyMasthead verdict path', () => {
  test('a verdict masthead renders exactly verdict, then summary — nothing else', () => {
    const { container } = render(
      <AnatomyMasthead verdict={verdictCard} summary="In GK 4 gilt REI 60." />
    )
    const head = header(container)
    // The verdict path is pixel-identical to before the topic existed: the
    // flat verdict header, then the standfirst, and no third element.
    expect(head.children).toHaveLength(2)
    expect(head.textContent).toContain('Feuerwiderstand tragender Bauteile')
    expect(head.textContent).toContain('REI 60')
    expect(head.textContent).toContain('In GK 4 gilt REI 60.')
    expect(head.textContent?.indexOf('REI 60')).toBeLessThan(
      head.textContent?.indexOf('In GK 4 gilt REI 60.') ?? 0
    )
    expect(screen.getByText('REI 60')).toHaveClass('card-figure-30')
  })

  test('a topic beside an earned verdict headlines nothing twice', () => {
    const { container } = render(
      <AnatomyMasthead verdict={verdictCard} topic="Geländerhöhe bei Balkonen" summary="S." />
    )
    // The verdict masthead already headlines the answer; the topic stays out.
    expect(container.textContent).not.toContain('Geländerhöhe bei Balkonen')
    expect(header(container).children).toHaveLength(2)
  })

  test('a walkthrough does not wear the verdict gavel even if a verdict is present', () => {
    const { container } = render(
      <AnatomyMasthead
        verdict={verdictCard}
        kind="walkthrough"
        topic="Geländerhöhe bei Balkonen"
        summary="S."
      />
    )
    expect(container.textContent).not.toContain('Feuerwiderstand tragender Bauteile')
    expect(container.textContent).toContain('Geländerhöhe bei Balkonen')
  })
})

describe('AnatomyMasthead topic path', () => {
  test('renders title and context over the summary, in that order', () => {
    const { container } = render(
      <AnatomyMasthead
        topic="Geländerhöhe bei Balkonen"
        context="Neubau in GK 4, Steiermark."
        summary="1,10 m ab 60 cm Absturzhöhe."
      />
    )
    const head = header(container)
    expect(head.children).toHaveLength(3)
    const text = head.textContent ?? ''
    // No eyebrow on the topic path: the contract carries one value and it
    // must not print twice stacked.
    expect(head.querySelector('.card-eyebrow')).toBeNull()
    const title = head.querySelector('.card-headline')
    expect(title?.textContent).toBe('Geländerhöhe bei Balkonen')
    expect(text.indexOf('Geländerhöhe bei Balkonen')).toBeLessThan(
      text.indexOf('Neubau in GK 4')
    )
    expect(text.indexOf('Neubau in GK 4')).toBeLessThan(text.indexOf('1,10 m ab 60 cm'))
  })

  test('a topic alone headlines the answer', () => {
    const { container } = render(<AnatomyMasthead topic="Geländerhöhe bei Balkonen" />)
    expect(header(container).children).toHaveLength(1)
    expect(container.textContent).toContain('Geländerhöhe bei Balkonen')
  })

  test('no verdict and no topic means no kicker', () => {
    const { container } = render(<AnatomyMasthead summary="In GK 4 gilt REI 60." />)
    expect(header(container).children).toHaveLength(1)
    expect(header(container).querySelector('.card-eyebrow')).toBeNull()
  })

  test('a context with no title to sit under renders no line', () => {
    const { container } = render(
      <AnatomyMasthead summary="In GK 4 gilt REI 60." context="Neubau in GK 4." />
    )
    expect(container.textContent).not.toContain('Neubau in GK 4.')
    expect(header(container).children).toHaveLength(1)
  })

  test('a context under an earned verdict renders under the verdict', () => {
    const { container } = render(
      <AnatomyMasthead verdict={verdictCard} context="Kellergeschosse: REI 90." />
    )
    const text = header(container).textContent ?? ''
    expect(text).toContain('Kellergeschosse: REI 90.')
    expect(text.indexOf('REI 60')).toBeLessThan(text.indexOf('Kellergeschosse'))
  })

  test('nothing usable renders nothing', () => {
    const { container } = render(<AnatomyMasthead />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('answerMetaToAnatomy topic carry-through', () => {
  test('topic and context ride along as plain strings, never as card shapes', () => {
    const anatomy = answerMetaToAnatomy({
      v: 1,
      kind: 'walkthrough',
      topic: 'Geländerhöhe bei Balkonen',
      context: 'Neubau in GK 4.',
    })
    expect(anatomy?.topic).toBe('Geländerhöhe bei Balkonen')
    expect(anatomy?.context).toBe('Neubau in GK 4.')
    // Cross-card coordination still sees cards only.
    expect(anatomy?.all).toEqual([])
    expect(anatomy?.below).toEqual([])
  })

  test('a verdict and a topic share the anatomy; the masthead decides', () => {
    const anatomy = answerMetaToAnatomy({
      v: 1,
      kind: 'ruling',
      topic: 'Geländerhöhe bei Balkonen',
      verdict: { value: 'REI 60', subject: 'Feuerwiderstand tragender Bauteile' },
    })
    expect(anatomy?.topic).toBe('Geländerhöhe bei Balkonen')
    expect(anatomy?.verdict?.type).toBe('verdict_header')
    expect(anatomy?.all).toHaveLength(1)
  })

  test('no anatomy without anything renderable', () => {
    expect(answerMetaToAnatomy(undefined)).toBeNull()
    expect(answerMetaToAnatomy({ v: 1 })).toBeNull()
  })
})
