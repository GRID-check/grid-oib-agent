/**
 * The narrow forms of the diagram views: what a reader on a phone gets when a
 * graph would not fit. jsdom has no container queries, so both forms mount;
 * these read the list form only.
 */
import { render, screen, within } from '@/test-utils'
import { describe, expect, it } from 'vitest'

import type { FlowModel, HandoffModel, SharesModel } from '../model'
import { FlowDiagram, HandoffDiagram, SharesDiagram } from './diagram-views'

const FLOW: FlowModel = {
  kind: 'flow',
  direction: 'down',
  nodes: [
    { id: 'a', label: 'Abweichung begründen', shape: 'step' },
    { id: 'b', label: 'Gleichwertiges Schutzniveau?', shape: 'decision' },
    { id: 'c', label: 'Bewilligt', shape: 'end' },
    { id: 'd', label: 'REI 90 ausführen', shape: 'end' },
  ],
  edges: [
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'b', to: 'c', label: 'ja' },
    { id: 'e3', from: 'b', to: 'd', label: 'nein' },
  ],
}

describe('the flow outline', () => {
  it('lists steps in reading order and writes out where each branch goes', () => {
    const { container } = render(<FlowDiagram model={FLOW} label="Abweichung" />)
    const outline = container.querySelector('ol') as HTMLElement
    const steps = [...outline.querySelectorAll(':scope > li > div')].map((el) => el.textContent)
    expect(steps[0]).toBe('Abweichung begründen')
    expect(steps[1]).toBe('Gleichwertiges Schutzniveau?')
    expect(steps.slice(2).sort()).toEqual(['Bewilligt', 'REI 90 ausführen'])
    const branches = [...outline.querySelectorAll('ul > li')].map((el) => el.textContent)
    expect(branches).toEqual(expect.arrayContaining(['ja: Bewilligt', 'nein: REI 90 ausführen']))
  })
})

describe('the handoff list', () => {
  it('numbers each step with who hands what to whom', () => {
    const model: HandoffModel = {
      kind: 'handoff',
      parties: [
        { id: 'Planer', label: 'Planer' },
        { id: 'Behörde', label: 'Behörde' },
      ],
      steps: [
        { from: 'Planer', to: 'Behörde', label: 'Bauansuchen', reply: false },
        { from: 'Behörde', to: 'Planer', label: 'Verbesserungsauftrag', reply: true },
      ],
    }
    const { container } = render(<HandoffDiagram model={model} />)
    const list = container.querySelector('ol') as HTMLElement
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(list.textContent).toContain('Verbesserungsauftrag')
  })
})

describe('the shares view', () => {
  it('draws each share with its percentage', () => {
    const model: SharesModel = { kind: 'shares', items: [{ label: 'Wohnen', value: 3 }, { label: 'Büro', value: 1 }] }
    render(<SharesDiagram model={model} />)
    expect(screen.getByText('Wohnen')).toBeInTheDocument()
    expect(screen.getByText(/75/)).toBeInTheDocument()
  })
})
