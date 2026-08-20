/**
 * The `diagram` card, and the three things it can be.
 *
 * The interesting state is the one the reader meets most: the model writes
 * invalid mermaid regularly, and a card that answered that with an error box
 * would put the product's failure inside the answer somebody asked for. So the
 * failure is asserted as hard as the success, and so is what SURVIVES it — the
 * title, the caption and the Fundstelle are the card's own words about what the
 * drawing shows and what it rests on, and a procedure whose Fundstelle vanished
 * because mermaid choked on a bracket is a procedure from nowhere.
 *
 * The renderer is mocked, exactly as `mermaid-diagram.spec.tsx` mocks it: what
 * mermaid does with a source is mermaid's contract, and this file is about what
 * the CARD does with mermaid's answer.
 */
import { render, screen, waitFor } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renderer = vi.fn()
vi.mock('@/features/diagrams/render-diagram', () => ({
  diagramRendererFor: () => renderer,
}))

import { DiagramCard } from './DiagramCard'
import { DiagramFilingProvider } from '@/features/diagrams/diagram-filing-context'

const SOURCE = 'sequenceDiagram\n  BW->>BB: Einreichunterlagen'
const DRAWN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

const CARD = {
  title: 'Baubewilligungsverfahren – wer wem was übergibt',
  source: SOURCE,
  caption: 'Die Fristen zeigt die Grafik nicht.',
  reference: { document: 'Wiener Bauordnung', section: '§§ 60 ff.' },
}

beforeEach(() => {
  vi.clearAllMocks()
  renderer.mockResolvedValue(DRAWN)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('when it draws', () => {
  it('shows the drawing and says it claims no dimensions', async () => {
    // The doctrine, where the reader is. Fifteen schematic cards in this product
    // compute their geometry so they cannot disagree with their own numbers; a
    // model-authored diagram has no such guarantee, so it says so — in the SAME
    // sentence the mermaid fence prints, from the same key.
    render(<DiagramCard {...CARD} />)

    await waitFor(() =>
      expect(screen.getByTestId('diagram-card')).toHaveAttribute('data-state', 'drawn')
    )
    expect(screen.getByTestId('diagram-card').querySelector('svg')).not.toBeNull()
    expect(screen.getByText(/no dimensions are claimed/i)).toBeInTheDocument()
  })

  it('carries the title, the caption and the Fundstelle', async () => {
    render(<DiagramCard {...CARD} />)

    await waitFor(() => expect(screen.getByText(CARD.title)).toBeInTheDocument())
    expect(screen.getByText(CARD.caption)).toBeInTheDocument()
    // A Verfahren differs by Bundesland, so a drawing of one without its
    // Fundstelle is a procedure from nowhere.
    expect(screen.getByText('Wiener Bauordnung')).toBeInTheDocument()
    expect(screen.getByText('§§ 60 ff.')).toBeInTheDocument()
  })

  it('offers no filing action, even where a surface supplies a target', async () => {
    // The card is `presentational` in CARD_INTERACTIVITY and must stay that
    // way while a decision on a card is `{decision, decidedAt}` and nothing
    // else: a filing button here would write a document whose id that record
    // cannot carry. Filing lives on the mermaid FENCE. The provider is the one
    // an answer inside a project really does wrap this card in, so this asserts
    // the absence where it would otherwise appear.
    render(
      <DiagramFilingProvider target={{ projectId: 'proj-1', answerId: 'msg_42' }}>
        <DiagramCard {...CARD} />
      </DiagramFilingProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('diagram-card')).toHaveAttribute('data-state', 'drawn')
    )
    expect(screen.queryByRole('button', { name: /file in project/i })).toBeNull()
  })
})

describe('when the model writes broken mermaid', () => {
  it('degrades to the source rather than to an error', async () => {
    // Never a red box, never a thrown error inside somebody's answer: the
    // reader gets the source they would have had anyway, plus one quiet line.
    renderer.mockRejectedValue(new Error('Parse error on line 2'))
    render(<DiagramCard {...CARD} />)

    await waitFor(() =>
      expect(screen.getByTestId('diagram-card')).toHaveAttribute('data-state', 'failed')
    )
    expect(screen.getByText(/sequenceDiagram/)).toBeInTheDocument()
    expect(screen.getByText(/could not be drawn/i)).toBeInTheDocument()
    // „Schematisch — ohne Maßangabe." is a statement about a drawing, and there
    // is none. Printing both would claim a picture the reader cannot see.
    expect(screen.queryByText(/no dimensions are claimed/i)).toBeNull()
  })

  it('keeps the title, the caption and the Fundstelle', async () => {
    // The words are just as true when the picture could not be laid out, and
    // they are the half a reader can still act on.
    renderer.mockRejectedValue(new Error('boom'))
    render(<DiagramCard {...CARD} />)

    await waitFor(() =>
      expect(screen.getByTestId('diagram-card')).toHaveAttribute('data-state', 'failed')
    )
    expect(screen.getByText(CARD.title)).toBeInTheDocument()
    expect(screen.getByText(CARD.caption)).toBeInTheDocument()
    expect(screen.getByText('Wiener Bauordnung')).toBeInTheDocument()
  })

  it('does not throw out of the card', async () => {
    // A throw here would take the whole answer down with it, and the answer is
    // the thing the reader asked for.
    renderer.mockRejectedValue(new Error('boom'))
    expect(() => render(<DiagramCard {...CARD} />)).not.toThrow()
    await waitFor(() =>
      expect(screen.getByTestId('diagram-card')).toHaveAttribute('data-state', 'failed')
    )
  })
})

describe('before mermaid has laid the graph out', () => {
  it('holds the drawing’s space instead of showing the source', async () => {
    // The first diagram in a session also pulls ~214 KB of mermaid, so this is
    // a real moment. Flashing the source and then replacing it with a picture
    // would tell the reader the drawing had failed and then unsay it.
    renderer.mockReturnValue(new Promise(() => {}))
    render(<DiagramCard {...CARD} />)

    expect(screen.getByTestId('diagram-card')).toHaveAttribute('data-state', 'drawing')
    expect(screen.queryByText(/sequenceDiagram/)).toBeNull()
    expect(screen.getByTestId('diagram-card').querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3)
  })
})
