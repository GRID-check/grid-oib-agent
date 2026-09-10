/**
 * The marker's job is a promise about WORDS, so that is what these hold: it
 * states what was read, it never claims influence, and it is not a citation.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { MemoryContext } from '@/adapters/api/schemas'
import { MemoryContextMarker } from './MemoryContextMarker'

const context = (over: Partial<MemoryContext> = {}): MemoryContext => ({
  carried: [
    { id: 'm1', kind: 'decision', content: 'Zwei Stiegenhäuser, Ost und West.' },
    { id: 'm2', kind: 'constraint', content: 'Bauklasse III, maximal 16 m.' },
  ],
  omitted: 44,
  total: 47,
  searched: 0,
  ...over,
})

describe('the collapsed line', () => {
  it('names how many notes were in view', () => {
    render(<MemoryContextMarker memoryContext={context()} projectId="p1" />)
    expect(screen.getByTestId('memory-context-trigger')).toHaveTextContent('2')
  })

  it('renders nothing when nothing was carried', () => {
    const { container } = render(
      <MemoryContextMarker memoryContext={context({ carried: [] })} projectId="p1" />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing at all on a turn that read no memory', () => {
    const { container } = render(<MemoryContextMarker projectId="p1" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('what it may say', () => {
  it('expands to the notes, each linking into the memory panel', async () => {
    const user = userEvent.setup()
    render(<MemoryContextMarker memoryContext={context()} projectId="p1" />)
    await user.click(screen.getByTestId('memory-context-trigger'))

    const notes = screen.getAllByTestId('memory-context-note')
    expect(notes).toHaveLength(2)
    expect(notes[0]).toHaveAttribute('href', '/app/projects/p1/settings#project-memory')
  })

  it('says the notes were in context and NOT that they were used', async () => {
    const user = userEvent.setup()
    render(<MemoryContextMarker memoryContext={context()} projectId="p1" />)
    await user.click(screen.getByTestId('memory-context-trigger'))

    // The one claim this surface may never make. `used`, `applied` and
    // `because` are all statements about influence, which nothing on either
    // side of the wire can verify (ADR-0055).
    const marker = screen.getByTestId('memory-context-marker')
    expect(marker.textContent ?? '').not.toMatch(/\bused\b|\bverwendet\b|\bangewendet\b/i)
    expect(marker).toHaveTextContent(/not evidence|kein Beleg/i)
  })

  it('tells the reader the omission the digest told the model', async () => {
    const user = userEvent.setup()
    render(<MemoryContextMarker memoryContext={context()} projectId="p1" />)
    await user.click(screen.getByTestId('memory-context-trigger'))
    expect(screen.getByTestId('memory-context-omitted')).toHaveTextContent('44')
  })

  it('states the same fact without a project, and links nowhere', async () => {
    const user = userEvent.setup()
    render(<MemoryContextMarker memoryContext={context()} />)
    await user.click(screen.getByTestId('memory-context-trigger'))
    const notes = screen.getAllByTestId('memory-context-note')
    expect(notes).toHaveLength(2)
    expect(notes[0]).not.toHaveAttribute('href')
  })
})
