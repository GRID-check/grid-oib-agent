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

const openFiledDocument = vi.fn()
vi.mock('@/features/documents/lib/open-filed-document', () => ({
  openFiledDocument: (...args: unknown[]) => openFiledDocument(...args),
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
      // The bytes that go into the project, which in light mode are the very
      // bytes on screen.
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

/**
 * Half a diagram, said out loud.
 *
 * The route answers 201 with `pdf: null` when the SVG landed and the PDF did
 * not. Before that existed, the same case arrived as a 500 and read „Internal
 * server error" in a German figcaption, while the `partial` state below was set
 * only for a 2xx body missing `svg.documentId` — an answer the route never
 * produces. So the copy for it was unreachable and the real half-filed diagram
 * was reported as a failure, which is the one message that makes a reader stop
 * looking for a file that exists.
 */
describe('when only half of it is filed', () => {
  const partialFetch = () =>
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ svg: { documentId: 'doc-1' }, pdf: null }),
    })

  const fileIt = async () => {
    render(
      <DiagramFilingProvider target={{ projectId: 'proj-1', answerId: 'msg_42' }}>
        <MermaidDiagram source={SOURCE} />
      </DiagramFilingProvider>
    )
    await userEvent.click(await screen.findByRole('button', { name: /file in project/i }))
  }

  it('says which half landed rather than „done" or „failed"', async () => {
    vi.stubGlobal('fetch', partialFetch())
    await fileIt()

    expect(await screen.findByText('The image was filed; the PDF was not.')).toBeInTheDocument()
    expect(screen.queryByText('Filed in the project')).toBeNull()
  })

  it('links to the half that is in the project', async () => {
    // A reader told half of it is filed and not told where has to hunt through
    // Berichte for a file they are not sure exists.
    vi.stubGlobal('fetch', partialFetch())
    await fileIt()

    expect(await screen.findByRole('link', { name: /open in project/i })).toHaveAttribute(
      'href',
      expect.stringContaining('doc-1')
    )
  })

  it('offers the retry that files only the missing half', async () => {
    // Filing is idempotent per (run, producer): pressing this finds the SVG
    // already filed and files only the PDF, which is why it is labelled for the
    // PDF and not for the diagram.
    const fetchMock = partialFetch()
    vi.stubGlobal('fetch', fetchMock)
    await fileIt()

    const retry = await screen.findByRole('button', { name: /add the pdf/i })
    await userEvent.click(retry)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).runId).toBe(diagramRunId('msg_42', SOURCE))
  })

  it('does not call an answer it cannot read a partial filing', async () => {
    // The route never answers 2xx without `svg.documentId`. If it ever does,
    // the honest reading is "something went wrong", not a sentence claiming a
    // file was written.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
    await fileIt()

    expect(await screen.findByText('Could not be filed')).toBeInTheDocument()
    expect(screen.queryByText('The image was filed; the PDF was not.')).toBeNull()
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

/**
 * The two grounds a diagram lands on, and the one that is filed.
 *
 * A file that only reads correctly inside the dark app is broken — the SVG is
 * previewed on a paper surface and the PDF is a white page. So the filing
 * button sends the paper render whatever theme the reader is in, and this is
 * the assertion that keeps a dark-theme drawing out of an Einreichung.
 */
describe('filed on paper, whatever the reader is looking at', () => {
  beforeEach(() => {
    renderer.mockImplementation(({ theme }: { theme: string }) =>
      Promise.resolve(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" data-theme="${theme}"/>`)
    )
  })

  afterEach(() => {
    document.documentElement.className = ''
  })

  it('sends the paper copy while the page is dark', async () => {
    document.documentElement.classList.add('dark')
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
    await waitFor(() => expect(button).not.toBeDisabled())
    await userEvent.click(button)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
    expect(body.svg).toContain('data-theme="light"')
    // …and the reader is looking at the charcoal one.
    expect(screen.getByTestId('mermaid-diagram').innerHTML).toContain('data-theme="dark"')
  })
})

/**
 * A filed artifact opens beside the conversation, not instead of it.
 *
 * Still a real link underneath: a modified click, "copy link address" and a
 * phone all reach the Files route, because `FilePreviewHost` refuses to peek
 * below the `md` breakpoint and a control that did nothing there would be worse
 * than one that navigates.
 */
describe('once it is in the project', () => {
  const fileIt = async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ svg: { documentId: 'doc-1' }, pdf: { documentId: 'doc-2' } }),
      })
    )
    render(
      <DiagramFilingProvider target={{ projectId: 'proj-1', answerId: 'msg_42' }}>
        <MermaidDiagram source={SOURCE} />
      </DiagramFilingProvider>
    )
    await userEvent.click(await screen.findByRole('button', { name: /file in project/i }))
    return screen.findByTestId('diagram-open-filed')
  }

  it('opens the peek pane instead of leaving the thread', async () => {
    openFiledDocument.mockResolvedValue(true)
    const link = await fileIt()
    await userEvent.click(link)
    expect(openFiledDocument).toHaveBeenCalledWith({ documentId: 'doc-1', projectId: 'proj-1' })
  })

  it('still names the Files route, so a modified click and a phone both work', async () => {
    openFiledDocument.mockResolvedValue(true)
    const link = await fileIt()
    expect(link).toHaveAttribute('href', expect.stringContaining('doc-1'))
  })
})
