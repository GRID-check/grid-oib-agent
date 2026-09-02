import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import {
  FAKE_FRAME_WIDTH,
  fakePdfjsRuntime,
  fakeTextRun as run,
  type FakePdfState,
} from '@/test-utils/pdfjs-fake'
import { PdfDocumentView } from './pdf-document-view'

// `vi.hoisted` runs before the imports, but a type annotation is erased, so
// naming the shared shape here costs nothing at runtime.
const state = vi.hoisted((): FakePdfState => ({ fail: false, pages: [], destroyed: 0 }))

vi.mock('../lib/pdfjs-runtime', () => fakePdfjsRuntime(state))

/**
 * The viewer's own wiring: does the page it was pointed at actually get its
 * text read, the cited passage located, and a mark placed over it at the right
 * coordinates — and does it fall back to the browser's viewer when pdf.js
 * cannot start. The matching itself is covered by `passage-highlight.spec.ts`
 * and the geometry by `pdf-text-chunks.spec.ts`; this is the seam between them
 * and the DOM.
 */

const restoreObservers = { current: () => {} }

/**
 * Select everything inside a node, the way a drag across it would.
 *
 * happy-dom has a Selection but no layout, so `getBoundingClientRect` on the
 * range is all zeros — which is exactly what the component treats as "at the
 * top-left of the page stack", and is not what any assertion here is about.
 */
const selectWithin = (node: Element): void => {
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

beforeEach(() => {
  state.fail = false
  state.destroyed = 0
  state.pages = []
  restoreObservers.current = installLayoutObservers({ frameWidth: FAKE_FRAME_WIDTH })
})

afterEach(() => {
  restoreObservers.current()
  vi.restoreAllMocks()
  // The clipboard test replaces `navigator`; leaving it replaced would hand the
  // next test in this file a navigator that is mostly a mock.
  vi.unstubAllGlobals()
})

describe('PdfDocumentView', () => {
  it('renders one frame per page of the document', async () => {
    state.pages = [{ items: [] }, { items: [] }, { items: [] }]
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(3))
    expect(screen.getByText('Page 1 of 3')).toBeTruthy()
  })

  it('marks the cited passage on the cited page, in page coordinates', async () => {
    state.pages = [
      { items: [run('Vorbemerkungen zum Verfahren', 740, 160)] },
      { items: [run('Die Frist betraegt vier Wochen', 700, 180)] },
    ]
    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="doc.pdf"
        page={2}
        highlight="Die Frist betraegt vier Wochen"
      />,
    )

    const mark = await screen.findByTestId('passage-mark')
    // The run's baseline sits 100 from the page top; the box starts one glyph
    // height above it and spans the run's own width, at fit-to-width scale 1.
    expect(mark.style.left).toBe('72px')
    expect(mark.style.top).toBe('88px')
    expect(mark.style.width).toBe('180px')
    expect(mark.style.height).toBe('12px')
    // Placed on page 2, not on the page that merely came first.
    expect(mark.closest('[data-page]')?.getAttribute('data-page')).toBe('2')
  })

  it('wears the provenance tint it was handed', async () => {
    state.pages = [{ items: [run('Die Frist betraegt vier Wochen', 700, 180)] }]
    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="doc.pdf"
        page={1}
        highlight="Die Frist betraegt vier Wochen"
        highlightColor="var(--source-law)"
      />,
    )
    const mark = await screen.findByTestId('passage-mark')
    expect(mark.style.getPropertyValue('--passage-tint')).toBe('var(--source-law)')
  })

  it('wears the fuzzy dress when the match is a guess, and not when it is the passage', async () => {
    // Every anchor word inflects differently from the page, so only the
    // word-overlap window finds this — and a window is a guess the reader
    // should be able to see as one.
    state.pages = [
      {
        items: [
          run(
            'Der Sachverstaendige erstattet Befund und Gutachten ueber die Standsicherheit des bestehenden Dachstuhls',
            700,
            400,
          ),
        ],
      },
    ]
    const { unmount } = render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="doc.pdf"
        page={1}
        highlight="Sachverstaendiger erstattete Befund und Gutachten ueber die Standsicherheit des bestehende Dachstuhles"
      />,
    )
    const guess = await screen.findByTestId('passage-mark')
    expect(guess.className).toContain('passage-highlight--fuzzy')
    expect(guess.getAttribute('data-fuzzy')).toBe('true')
    unmount()

    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="doc.pdf"
        page={1}
        highlight="Der Sachverstaendige erstattet Befund und Gutachten"
      />,
    )
    const hit = await screen.findByTestId('passage-mark')
    expect(hit.className).not.toContain('passage-highlight--fuzzy')
    expect(hit.getAttribute('data-fuzzy')).toBeNull()
  })

  it('marks nothing when the snippet is not on the page', async () => {
    state.pages = [{ items: [run('Vorbemerkungen zum Verfahren', 740, 160)] }]
    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="doc.pdf"
        page={1}
        highlight="Die Brandschutzabnahme wurde durchgefuehrt"
      />,
    )
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(1))
    expect(screen.queryByTestId('passage-mark')).toBeNull()
    // A page it could not mark is still a page it opened — no error surface.
    expect(screen.queryByRole('button', { name: 'Go to passage' })).toBeNull()
  })

  it('offers a way back to the passage once one is marked', async () => {
    state.pages = [{ items: [run('Die Frist betraegt vier Wochen', 700, 180)] }]
    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="doc.pdf"
        page={1}
        highlight="Die Frist betraegt vier Wochen"
      />,
    )
    await screen.findByTestId('passage-mark')
    expect(screen.getByText('Go to passage')).toBeTruthy()
  })

  it('falls back to the browser viewer, at the right page, when pdf.js cannot start', async () => {
    state.fail = true
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" page={7} highlight="egal" />)
    const frame = await screen.findByTitle('doc.pdf')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('src')).toBe('/api/doc.pdf#page=7')
    // Something WAS lost here, so say so.
    expect(screen.getByText(/cannot be marked/i)).toBeTruthy()
  })

  it('says nothing about a lost highlight to a reader who asked for none', async () => {
    state.fail = true
    // The Files pane opens documents this way: no citation, no passage.
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    await screen.findByTitle('doc.pdf')
    expect(screen.queryByText(/cannot be marked/i)).toBeNull()
  })

  /**
   * Regression: matching used to sit in the same effect as rasterisation, whose
   * deps include the zoom-driven width. Every zoom click therefore re-ran the
   * match, re-announced the hit, and dragged a reader who had deliberately
   * scrolled elsewhere back to the citation — replaying the arrival pulse at
   * them. Zoom changes how big the passage is drawn, nothing else.
   */
  it('does not re-reveal the passage when the reader zooms', async () => {
    state.pages = [{ items: [run('Die Frist betraegt vier Wochen', 700, 180)] }]
    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="doc.pdf"
        page={1}
        highlight="Die Frist betraegt vier Wochen"
      />,
    )
    await screen.findByTestId('passage-mark')

    const frame = screen.getByTestId('pdf-scroll')
    const scrollTo = vi.fn()
    frame.scrollTo = scrollTo

    fireEvent.click(screen.getByLabelText('Zoom in'))
    await waitFor(() => expect(screen.getByText('125%')).toBeTruthy())

    // The mark survives the zoom — it is still the answer to the click.
    expect(screen.getByTestId('passage-mark')).toBeTruthy()
    // But the frame is not yanked back to it.
    expect(scrollTo).not.toHaveBeenCalled()

    // The spy is wired correctly: asking to go back DOES scroll. Without this,
    // "not called" would pass just as well against a broken assertion.
    fireEvent.click(screen.getByText('Go to passage'))
    expect(scrollTo).toHaveBeenCalled()
  })

  /**
   * The reason the viewer draws its own pages is not only the highlight: a
   * canvas is a picture of a document, and a reader who tries to select a
   * sentence out of a picture gets nothing, silently. The text layer is what
   * makes the rendered page behave like the document it is showing.
   */
  it('puts the page\'s own text over the bitmap, where it can be selected', async () => {
    state.pages = [{ items: [run('Die Frist betraegt vier Wochen', 700, 180)] }]
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)

    const layer = await screen.findByTestId('pdf-text-layer')
    expect(layer.textContent).toContain('Die Frist betraegt vier Wochen')
  })

  it('re-scales the text layer with the zoom instead of rebuilding it', async () => {
    state.pages = [{ items: [run('Die Frist betraegt vier Wochen', 700, 180)] }]
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    const layer = await screen.findByTestId('pdf-text-layer')
    await waitFor(() => expect(layer.style.getPropertyValue('--total-scale-factor')).toBe('1'))

    fireEvent.click(screen.getByLabelText('Zoom in'))

    // The runs are positioned in page units and sized off this variable, so the
    // zoom is one number — and the same nodes, so a live selection survives it.
    await waitFor(() => expect(layer.style.getPropertyValue('--total-scale-factor')).toBe('1.25'))
    expect(screen.getByTestId('pdf-text-layer')).toBe(layer)
  })

  /**
   * The page number comes from retrieval, which counts sheets. A Bescheid with a
   * cover sheet numbers its own pages one lower, and before the search widened,
   * that one-off cost the reader the whole feature in silence: the viewer opened
   * at the wrong page with nothing marked, indistinguishable from a passage that
   * could not be found at all.
   */
  it('looks one page either side when the cited page does not hold the passage', async () => {
    state.pages = [
      { items: [run('Vorbemerkungen zum Verfahren', 740, 160)] },
      { items: [run('Inhaltsverzeichnis', 740, 100)] },
      { items: [run('Die Frist betraegt vier Wochen', 700, 180)] },
    ]
    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="doc.pdf"
        page={2}
        highlight="Die Frist betraegt vier Wochen"
      />,
    )

    const mark = await screen.findByTestId('passage-mark')
    expect(mark.closest('[data-page]')?.getAttribute('data-page')).toBe('3')
  })

  it('does not wander further than that', async () => {
    state.pages = [
      { items: [run('Vorbemerkungen zum Verfahren', 740, 160)] },
      { items: [run('Inhaltsverzeichnis', 740, 100)] },
      { items: [run('Zwischenblatt', 740, 90)] },
      { items: [run('Die Frist betraegt vier Wochen', 700, 180)] },
    ]
    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="doc.pdf"
        page={1}
        highlight="Die Frist betraegt vier Wochen"
      />,
    )
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(4))

    // Three pages out is not a numbering offset, it is a different passage that
    // happens to read alike — and pointing at it would be a confident lie.
    await waitFor(() => expect(screen.queryByTestId('passage-mark')).toBeNull())
  })

  it('says which page the reader is on, not how long the document is', async () => {
    // The band across the middle of the frame decides. Only page 2 is in it, so
    // page 2 is what the reader is reading — "3 pages" was a fact about the
    // file, and never the one a reader in the middle of a Bescheid wants.
    restoreObservers.current()
    restoreObservers.current = installLayoutObservers({
      frameWidth: FAKE_FRAME_WIDTH,
      intersecting: (target) => target.getAttribute('data-page') === '2',
    })
    state.pages = [{ items: [] }, { items: [] }, { items: [] }]
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)

    expect(await screen.findByText('Page 2 of 3')).toBeTruthy()
  })

  /**
   * The reader clicked a Fundstelle and nothing lit up. Silence let them
   * conclude what they liked from that — that the passage is not in the
   * document, that the viewer is broken, that they had missed it. It is none of
   * those, and the viewer is the only party that knows.
   */
  it('says so when every page it could look at has come up empty', async () => {
    state.pages = [
      { items: [run('Vorbemerkungen zum Verfahren', 740, 160)] },
      { items: [run('Inhaltsverzeichnis', 740, 100)] },
      { items: [run('Anhang', 740, 90)] },
    ]
    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="doc.pdf"
        page={2}
        highlight="Die Frist betraegt vier Wochen"
      />,
    )

    expect(await screen.findByText('Passage not found in the document')).toBeTruthy()
    expect(screen.queryByTestId('passage-mark')).toBeNull()
  })

  it('stays quiet about a passage it has not finished looking for', async () => {
    // Page 3 is out of the band, so its text has not been read yet. Saying
    // "not found" here would be a claim the viewer cannot support.
    restoreObservers.current()
    restoreObservers.current = installLayoutObservers({
      frameWidth: FAKE_FRAME_WIDTH,
      intersecting: (target) => target.getAttribute('data-page') !== '3',
    })
    state.pages = [
      { items: [run('Vorbemerkungen zum Verfahren', 740, 160)] },
      { items: [run('Inhaltsverzeichnis', 740, 100)] },
      { items: [run('Die Frist betraegt vier Wochen', 700, 180)] },
    ]
    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="doc.pdf"
        page={2}
        highlight="Die Frist betraegt vier Wochen"
      />,
    )
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(3))

    expect(screen.queryByText('Passage not found in the document')).toBeNull()
  })

  /**
   * What the reader does with the text they can now select. The browser already
   * copies words; what it cannot do is attach the document and the page they
   * came from, which is the difference between a paragraph in a Stellungnahme
   * and a quotation somebody can check.
   */
  it('offers to copy a selection as a citation, with the page it came from', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    state.pages = [{ items: [] }, { items: [run('Die Frist betraegt vier Wochen', 700, 180)] }]

    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="doc.pdf"
        quoteFormat={({ text, page }) => `„${text}“ — doc.pdf, S. ${page}`}
      />,
    )
    const layer = (await screen.findAllByTestId('pdf-text-layer'))[1]!
    selectWithin(layer)

    fireEvent.pointerUp(screen.getByTestId('pdf-scroll'))
    fireEvent.click(await screen.findByText('Copy as citation'))

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        '„Die Frist betraegt vier Wochen“ — doc.pdf, S. 2',
      ),
    )
    expect(await screen.findByText('Citation copied')).toBeTruthy()
  })

  it('offers nothing to a viewer that was given no way to cite', async () => {
    // The Files pane opens documents this way. Selecting still works — it is the
    // browser's own — but there is no citation to build, so no offer is made.
    state.pages = [{ items: [run('Die Frist betraegt vier Wochen', 700, 180)] }]
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    const layer = await screen.findByTestId('pdf-text-layer')
    selectWithin(layer)

    fireEvent.pointerUp(screen.getByTestId('pdf-scroll'))
    expect(screen.queryByTestId('pdf-quote-bar')).toBeNull()
  })

  it('releases the document when the viewer goes away', async () => {
    state.pages = [{ items: [] }]
    const { unmount } = render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(1))
    unmount()
    await waitFor(() => expect(state.destroyed).toBe(1))
  })
})
