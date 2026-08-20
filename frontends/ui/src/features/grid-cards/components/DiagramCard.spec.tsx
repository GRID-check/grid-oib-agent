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
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renderer = vi.fn()
vi.mock('@/features/diagrams/render-diagram', () => ({
  diagramRendererFor: () => renderer,
}))

import { DiagramCard } from './DiagramCard'
import { DiagramFilingProvider, diagramRunId } from '@/features/diagrams/diagram-filing-context'

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
  vi.unstubAllGlobals()
  document.documentElement.className = ''
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

  it('offers the same filing action the fence does, where a surface supplies a target', async () => {
    // Which of the two surfaces a reader gets is not their choice and not a
    // property of the drawing — it is whichever shape the model emitted — so an
    // affordance on the fence and not here made the same Verfahrensablauf
    // saveable by accident. The provider is the one an answer inside a project
    // really does wrap this card in.
    render(
      <DiagramFilingProvider target={{ projectId: 'proj-1', answerId: 'msg_42' }}>
        <DiagramCard {...CARD} />
      </DiagramFilingProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId('diagram-card')).toHaveAttribute('data-state', 'drawn')
    )
    expect(screen.getByRole('button', { name: /file in project/i })).toBeInTheDocument()
    // The compliance furniture is untouched: the drawing's claim about itself
    // and its Fundstelle both outrank "save this" and both still stand.
    expect(screen.getByText(/no dimensions are claimed/i)).toBeInTheDocument()
    expect(screen.getByText('Wiener Bauordnung')).toBeInTheDocument()
  })

  it('files the paper bytes under the card’s own title', async () => {
    // The card HAS a title the model wrote for this drawing, which is better
    // provenance than the front matter a bare source might carry — and it is
    // what names the file in the Files pane. The SVG is `fileSvg`: paper,
    // whatever theme the reader is in.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ svg: { documentId: 'doc-1' }, pdf: { documentId: 'doc-2' } }),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(
      <DiagramFilingProvider target={{ projectId: 'proj-1', answerId: 'msg_42' }}>
        <DiagramCard {...CARD} />
      </DiagramFilingProvider>
    )
    await userEvent.click(await screen.findByRole('button', { name: /file in project/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/projects/proj-1/diagrams')
    const body = JSON.parse((init as { body: string }).body)
    expect(body).toMatchObject({
      // The same key the fence uses, so one drawing in one answer is one file
      // however the model chose to emit it.
      runId: diagramRunId('msg_42', CARD.source),
      title: CARD.title,
      sourceKind: 'mermaid',
      svg: DRAWN,
    })
  })

  it('files the paper copy while the reader is in dark mode', async () => {
    // The regression this catches is silent and only visible on paper: a
    // charcoal drawing filed as an SVG previews on a paper surface and prints
    // on a white PDF page, where its light ink is invisible.
    document.documentElement.classList.add('dark')
    renderer.mockImplementation(({ theme }: { theme: string }) =>
      Promise.resolve(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" data-theme="${theme}"/>`)
    )
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ svg: { documentId: 'doc-1' }, pdf: { documentId: 'doc-2' } }),
    })
    vi.stubGlobal('fetch', fetchMock)
    render(
      <DiagramFilingProvider target={{ projectId: 'proj-1', answerId: 'msg_42' }}>
        <DiagramCard {...CARD} />
      </DiagramFilingProvider>
    )
    const button = await screen.findByRole('button', { name: /file in project/i })
    await waitFor(() => expect(button).not.toBeDisabled())
    await userEvent.click(button)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body.svg).toContain('data-theme="light"')
    // …and the card is showing the charcoal one.
    expect(screen.getByTestId('diagram-card').innerHTML).toContain('data-theme="dark"')
  })

  it('offers nothing at all outside a project, rather than a dead control', async () => {
    render(<DiagramCard {...CARD} />)
    await waitFor(() =>
      expect(screen.getByTestId('diagram-card')).toHaveAttribute('data-state', 'drawn')
    )
    expect(screen.queryByRole('button', { name: /file in project/i })).toBeNull()
    expect(screen.queryByTestId('diagram-filing')).toBeNull()
  })

  it('offers no filing on a drawing that could not be laid out', async () => {
    // There are no bytes to file, and a control that cannot work is worse than
    // no control. The title, the caption and the Fundstelle still stand.
    renderer.mockRejectedValue(new Error('Parse error on line 2'))
    render(
      <DiagramFilingProvider target={{ projectId: 'proj-1', answerId: 'msg_42' }}>
        <DiagramCard {...CARD} />
      </DiagramFilingProvider>
    )
    await waitFor(() =>
      expect(screen.getByTestId('diagram-card')).toHaveAttribute('data-state', 'failed')
    )
    expect(screen.queryByTestId('diagram-filing')).toBeNull()
    expect(screen.getByText('Wiener Bauordnung')).toBeInTheDocument()
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
