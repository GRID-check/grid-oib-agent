/**
 * A mermaid fence in an answer, and the three things it can be.
 *
 * The failure modes are the interesting cases and they are the ones a reader
 * meets most often: the model writes broken mermaid regularly, and an answer is
 * a stream, so the fence spends its first seconds looking complete without being
 * complete. Both must cost the reader nothing they did not already have — which
 * is the source text, exactly as it rendered before this component existed.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renderer = vi.fn()
vi.mock('../render-diagram', () => ({
  diagramRendererFor: () => renderer,
}))

import { MermaidDiagram } from './mermaid-diagram'
import { DiagramFilingProvider, diagramRunId } from '../diagram-filing-context'

const SOURCE = 'graph TD\n  A --> B'
const DRAWN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

beforeEach(() => {
  vi.clearAllMocks()
  renderer.mockResolvedValue(DRAWN)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('while the answer is still arriving', () => {
  it('shows the source and does not try to draw it', async () => {
    // The stabiliser in `MarkdownRenderer` appends a synthetic closing fence to
    // half-arrived markdown, so an in-flight mermaid block LOOKS complete on
    // every token. Handing that to mermaid renders a parse error per token.
    render(<MermaidDiagram source={SOURCE} isStreaming />)
    expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-state', 'streaming')
    expect(renderer).not.toHaveBeenCalled()
    expect(screen.getByText(/graph TD/)).toBeInTheDocument()
  })

  it('draws it once the answer is finished', async () => {
    const { rerender } = render(<MermaidDiagram source={SOURCE} isStreaming />)
    expect(renderer).not.toHaveBeenCalled()
    rerender(<MermaidDiagram source={SOURCE} isStreaming={false} />)
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-state', 'drawn')
    )
  })
})

describe('when the model writes broken mermaid', () => {
  it('falls back to the source rather than to an error', async () => {
    // Never a red box, never a thrown error inside somebody's answer: the
    // reader sees the code they would have seen anyway, plus one quiet line.
    renderer.mockRejectedValue(new Error('Parse error on line 2'))
    render(<MermaidDiagram source={'graph TD\n  A -->'} />)
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-state', 'failed')
    )
    expect(screen.getByText(/graph TD/)).toBeInTheDocument()
    expect(screen.getByText(/could not be drawn/i)).toBeInTheDocument()
  })

  it('does not throw out of the component', async () => {
    // A throw here would take the whole answer down with it, and the answer is
    // the thing the reader asked for.
    renderer.mockRejectedValue(new Error('boom'))
    expect(() => render(<MermaidDiagram source={SOURCE} />)).not.toThrow()
    await waitFor(() =>
      expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-state', 'failed')
    )
  })
})

describe('when it draws', () => {
  it('shows the drawing and says it claims no dimensions', async () => {
    // The doctrine, where the reader is. Fifteen schematic cards in this product
    // compute their geometry so they cannot disagree with their own numbers; a
    // model-authored diagram has no such guarantee, so it says so.
    render(<MermaidDiagram source={SOURCE} />)
    await waitFor(() => expect(screen.getByText(/no dimensions are claimed/i)).toBeInTheDocument())
    expect(screen.getByTestId('mermaid-diagram').querySelector('svg')).not.toBeNull()
  })

  it('offers no filing action outside a project', async () => {
    // Absence is a normal answer. A chat outside a project has nowhere to file
    // to, and a dead action is worse than silence.
    render(<MermaidDiagram source={SOURCE} />)
    await waitFor(() => expect(screen.getByText(/no dimensions are claimed/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /file in project/i })).toBeNull()
  })

  it('files the bytes on screen, under the diagram’s own run id', async () => {
    // Not a re-render: a second render is a second chance for the file to
    // disagree with the picture, and nobody can spot that before signing.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ svg: { documentId: 'doc-1' }, pdf: { documentId: 'doc-2' } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <DiagramFilingProvider target={{ projectId: 'proj-1', answerId: 'msg_42' }}>
        <MermaidDiagram source={SOURCE} />
      </DiagramFilingProvider>
    )
    const button = await screen.findByRole('button', { name: /file in project/i })
    await userEvent.click(button)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/projects/proj-1/diagrams')
    const body = JSON.parse((init as { body: string }).body)
    expect(body).toMatchObject({
      runId: diagramRunId('msg_42', SOURCE),
      sourceKind: 'mermaid',
      source: SOURCE,
      svg: DRAWN,
    })
    expect(await screen.findByRole('link', { name: /open in project/i })).toHaveAttribute(
      'href',
      expect.stringContaining('doc-1')
    )
  })

  it('shows the server’s own refusal rather than a generic failure', async () => {
    // The route names the rule in the reader's language, and that message is
    // the only debugging surface a browser has.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'The diagram contains a script.' }) })
    )
    render(
      <DiagramFilingProvider target={{ projectId: 'proj-1', answerId: 'msg_42' }}>
        <MermaidDiagram source={SOURCE} />
      </DiagramFilingProvider>
    )
    await userEvent.click(await screen.findByRole('button', { name: /file in project/i }))
    expect(await screen.findByText('The diagram contains a script.')).toBeInTheDocument()
  })
})

describe('the diagram’s identity', () => {
  it('is stable for the same source in the same answer, so filing twice files once', () => {
    // A render-time counter would hand the same diagram a different identity on
    // a re-render, and file it again — exactly the duplicate migration 0065's
    // index exists to prevent.
    expect(diagramRunId('msg_1', SOURCE)).toBe(diagramRunId('msg_1', SOURCE))
  })

  it('differs between two diagrams in one answer, and between two answers', () => {
    expect(diagramRunId('msg_1', SOURCE)).not.toBe(diagramRunId('msg_1', 'graph LR\n  A --> B'))
    expect(diagramRunId('msg_1', SOURCE)).not.toBe(diagramRunId('msg_2', SOURCE))
  })
})
