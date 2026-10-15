import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import {
  FAKE_FRAME_WIDTH,
  fakePdfjsRuntime,
  fakeTextRun as run,
  selectRenderedText,
  type FakePdfState,
} from '@/test-utils/pdfjs-fake'
import { PdfDocumentView, pointOnPage } from './pdf-document-view'
import { capturePosthog } from '@/lib/analytics/posthog'

vi.mock('@/lib/analytics/posthog', () => ({ capturePosthog: vi.fn() }))

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

beforeEach(() => {
  vi.mocked(capturePosthog).mockClear()
  state.fail = false
  state.destroyed = 0
  state.pages = []
  state.password = undefined
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
  it('holds a page-shaped sheet while loading, replaced by the first page', async () => {
    state.pages = [{ items: [] }]
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    // Synchronously, before the fake runtime resolves: the reader sees a page
    // already, not a spinner in an empty frame.
    const sheet = screen.getByTestId('pdf-page-placeholder')
    expect(sheet.style.aspectRatio).toBe(`1 / ${Math.SQRT2}`)
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(1))
    expect(screen.queryByTestId('pdf-page-placeholder')).toBeNull()
  })

  it('blocks the document from the session recorder, pages and text layer alike', async () => {
    state.pages = [{ items: [] }]
    const { container } = render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(1))
    expect(container.firstElementChild).toHaveClass('ph-no-capture')
  })

  it('reports document_opened once pdf.js has the document, with the kind and renderer only', async () => {
    state.pages = [{ items: [] }]
    render(<PdfDocumentView src="/api/doc.pdf" title="Plan_EG.pdf" />)
    expect(capturePosthog).not.toHaveBeenCalled()
    await waitFor(() => expect(capturePosthog).toHaveBeenCalledTimes(1))
    expect(capturePosthog).toHaveBeenCalledWith('document_opened', { kind: 'pdf', library: 'pdfjs' })
  })

  it('reports a hand-over to the browser\'s viewer as its own renderer', async () => {
    state.fail = true
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    fireEvent.click(await screen.findByRole('link', { name: 'Open in browser' }))
    expect(capturePosthog).toHaveBeenCalledWith('document_opened', { kind: 'pdf', library: 'browser' })
  })

  it('renders one frame per page of the document', async () => {
    state.pages = [{ items: [] }, { items: [] }, { items: [] }]
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(3))
    // Each page is a named stop for assistive technology, not an anonymous box.
    expect(screen.getByRole('group', { name: 'Page 3' })).toBeTruthy()
    expect(await screen.findByText('Page 1 of 3')).toBeTruthy()
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
    expect(screen.getByRole('button', { name: 'Go to passage' })).toBeTruthy()
  })

  /**
   * A frame of the browser's own viewer used to stand in for a failed load,
   * which on Android Chrome (no inline PDF renderer) is a blank box. The
   * failure is said on the stage instead, with a retry and the browser's viewer
   * as an explicit way out — still at the cited page.
   */
  it('says it could not open the document, offers the browser at the right page, and retries', async () => {
    state.fail = true
    state.pages = [{ items: [] }]
    const { container } = render(
      <PdfDocumentView src="/api/doc.pdf" title="doc.pdf" page={7} highlight="egal" />,
    )
    expect(await screen.findByText('This document could not be opened here')).toBeTruthy()
    expect(container.querySelector('iframe')).toBeNull()
    expect(screen.getByRole('link', { name: 'Open in browser' }).getAttribute('href')).toBe(
      '/api/doc.pdf#page=7',
    )

    state.fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(1))
  })

  it('leaves the failure to a host that owns one', async () => {
    state.fail = true
    const onLoadError = vi.fn()
    const { container } = render(
      <PdfDocumentView src="/api/doc.pdf" title="doc.pdf" onLoadError={onLoadError} />,
    )
    await waitFor(() => expect(onLoadError).toHaveBeenCalledTimes(1))
    expect(container.firstChild).toBeNull()
  })

  it('asks for the password of an encrypted document, and says when it is wrong', async () => {
    state.password = 'geheim'
    state.pages = [{ items: [] }]
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)

    const field = await screen.findByLabelText('Password')
    fireEvent.change(field, { target: { value: 'falsch' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open document' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That password is not correct.')

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'geheim' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open document' }))
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(1))
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
    // Spied before render. The opening settles on an animation frame once page
    // 1's shape lands (`scrollToRects(hit, false)`), and under load that frame
    // can fire after the mark is on screen: a spy put on the frame only then
    // caught the settle and read it as a zoom re-reveal.
    const scrollTo = vi.fn()
    const original = HTMLElement.prototype.scrollTo
    HTMLElement.prototype.scrollTo = scrollTo
    try {
      render(
        <PdfDocumentView
          src="/api/doc.pdf"
          title="doc.pdf"
          page={1}
          highlight="Die Frist betraegt vier Wochen"
        />,
      )
      await screen.findByTestId('passage-mark')
      await waitFor(() =>
        expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' })),
      )
      scrollTo.mockClear()

      fireEvent.click(screen.getByLabelText('Zoom in'))
      await waitFor(() => expect(screen.getByText('125%')).toBeTruthy())

      // The mark survives the zoom — it is still the answer to the click.
      expect(screen.getByTestId('passage-mark')).toBeTruthy()
      // But the frame is not yanked back to it.
      expect(scrollTo).not.toHaveBeenCalled()

      // The spy is wired correctly: asking to go back DOES scroll. Without this,
      // "not called" would pass just as well against a broken assertion.
      fireEvent.click(screen.getByRole('button', { name: 'Go to passage' }))
      expect(scrollTo).toHaveBeenCalled()
    } finally {
      HTMLElement.prototype.scrollTo = original
    }
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

    await selectRenderedText('Die Frist betraegt vier Wochen')
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

  it('looks a second page out once both neighbours have come up empty', async () => {
    // A title sheet and a table of contents: the document's own numbering is
    // two behind the sheet count retrieval reported.
    state.pages = [
      { items: [run('Titelblatt', 740, 160)] },
      { items: [run('Inhaltsverzeichnis', 740, 100)] },
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

    const mark = await screen.findByTestId('passage-mark')
    expect(mark.closest('[data-page]')?.getAttribute('data-page')).toBe('3')
  })

  it('does not wander further than that', async () => {
    state.pages = [
      { items: [run('Vorbemerkungen zum Verfahren', 740, 160)] },
      { items: [run('Inhaltsverzeichnis', 740, 100)] },
      { items: [run('Zwischenblatt', 740, 90)] },
      { items: [run('Abkuerzungen', 740, 90)] },
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
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(5))

    // Four pages out is not a numbering offset, it is a different passage that
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
    await selectRenderedText('Die Frist betraegt vier Wochen')

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
    await selectRenderedText('Die Frist betraegt vier Wochen')

    fireEvent.pointerUp(screen.getByTestId('pdf-scroll'))
    expect(screen.queryByTestId('pdf-quote-bar')).toBeNull()
  })

  /**
   * „Im Büro behandelt" on a selection: the words and the page go to whoever
   * opened the viewer, which decides who may be searched. The Files pane cites
   * nothing, so it gets this offer alone, without the copy beside it.
   */
  it('offers similar passages for a selection, with its words and page, and no citation where none is built', async () => {
    const onFindSimilar = vi.fn()
    state.pages = [{ items: [] }, { items: [run('Die Frist betraegt vier Wochen', 700, 180)] }]

    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" onFindSimilar={onFindSimilar} />)
    await selectRenderedText('Die Frist betraegt vier Wochen')
    fireEvent.pointerUp(screen.getByTestId('pdf-scroll'))
    fireEvent.click(await screen.findByTestId('pdf-find-similar'))

    expect(onFindSimilar).toHaveBeenCalledWith({ text: 'Die Frist betraegt vier Wochen', page: 2 })
    expect(screen.getByRole('button', { name: /Check your projects/ })).toBeTruthy()
    expect(screen.queryByText('Copy as citation')).toBeNull()
  })

  it('does not offer similar passages for a few words, which say too little to find another like them', async () => {
    state.pages = [{ items: [run('Frist', 700, 40)] }]
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" onFindSimilar={vi.fn()} quoteFormat={(q) => q.text} />)
    await selectRenderedText('Frist')
    fireEvent.pointerUp(screen.getByTestId('pdf-scroll'))

    expect(await screen.findByText('Copy as citation')).toBeTruthy()
    expect(screen.queryByTestId('pdf-find-similar')).toBeNull()
  })

  it('marks a cited region on its page, as shares of the page box (#433)', async () => {
    state.pages = [{ items: [] }, { items: [] }]
    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="plan.pdf"
        page={2}
        highlightColor="var(--source-project)"
        regions={[{ box: [0.1, 0.2, 0.5, 0.6], label: 'Grundriss EG' }]}
      />,
    )
    const mark = await screen.findByTestId('region-mark')
    expect(mark.closest('[data-page]')?.getAttribute('data-page')).toBe('2')
    expect(mark.style.left).toBe('10%')
    expect(mark.style.top).toBe('20%')
    expect(mark.style.width).toBe('40%')
    expect(mark.style.height).toBe('40%')
    expect(mark.style.getPropertyValue('--passage-tint')).toBe('var(--source-project)')
    expect(screen.getByText('Grundriss EG')).toBeTruthy()
    // The same way back a located passage gets.
    expect(screen.getByRole('button', { name: 'Go to passage' })).toBeTruthy()
  })

  it('draws no region without a page to draw it on', async () => {
    state.pages = [{ items: [] }]
    render(
      <PdfDocumentView src="/api/doc.pdf" title="plan.pdf" regions={[{ box: [0.1, 0.2, 0.5, 0.6] }]} />,
    )
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(1))
    expect(screen.queryByTestId('region-mark')).toBeNull()
  })

  it("lays the caller's overlay over each page, told which page it is on", async () => {
    state.pages = [{ items: [] }, { items: [] }]
    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="plan.pdf"
        pageOverlay={(page) => (page === 2 ? <span data-testid="overlay-mark">pin on {page}</span> : null)}
      />,
    )
    const mark = await screen.findByTestId('overlay-mark')
    expect(mark.closest('[data-page]')?.getAttribute('data-page')).toBe('2')
    expect(screen.getAllByTestId('overlay-mark')).toHaveLength(1)
  })

  it("puts the caller's controls first in its own pill", async () => {
    state.pages = [{ items: [] }]
    render(
      <PdfDocumentView
        src="/api/doc.pdf"
        title="plan.pdf"
        toolbarLead={<button type="button">Kommentar</button>}
      />,
    )
    const pill = await screen.findByTestId('pdf-floating-toolbar')
    expect(within(pill).getAllByRole('button')[0]).toHaveTextContent('Kommentar')
  })

  it('releases the document when the viewer goes away', async () => {
    state.pages = [{ items: [] }]
    const { unmount } = render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(1))
    unmount()
    await waitFor(() => expect(state.destroyed).toBe(1))
  })

  describe('moving through the document', () => {
    const threePages = (): void => {
      state.pages = [{ items: [] }, { items: [] }, { items: [] }]
    }
    const pageField = (): HTMLInputElement => screen.getByTestId('pdf-page-input')

    it('goes to a page typed into the page field', async () => {
      threePages()
      render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
      await waitFor(() => expect(pageField().value).toBe('1'))

      fireEvent.change(pageField(), { target: { value: '3' } })
      fireEvent.keyDown(pageField(), { key: 'Enter' })

      await waitFor(() => expect(pageField().value).toBe('3'))
      expect(await screen.findByText('Page 3 of 3')).toBeTruthy()
    })

    it('holds a page past the end to the last page', async () => {
      threePages()
      render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
      await waitFor(() => expect(pageField().value).toBe('1'))
      fireEvent.change(pageField(), { target: { value: '99' } })
      fireEvent.keyDown(pageField(), { key: 'Enter' })
      await waitFor(() => expect(pageField().value).toBe('3'))
    })

    it('turns pages with the arrows either side of the field', async () => {
      threePages()
      render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
      await waitFor(() => expect(pageField().value).toBe('1'))
      expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
      await waitFor(() => expect(pageField().value).toBe('2'))
    })

    it('answers PageDown, End and Home while the reader is in the document', async () => {
      threePages()
      render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
      await waitFor(() => expect(pageField().value).toBe('1'))
      const frame = screen.getByTestId('pdf-scroll')

      fireEvent.keyDown(frame, { key: 'PageDown' })
      await waitFor(() => expect(pageField().value).toBe('2'))
      fireEvent.keyDown(frame, { key: 'End' })
      await waitFor(() => expect(pageField().value).toBe('3'))
      fireEvent.keyDown(frame, { key: 'Home' })
      await waitFor(() => expect(pageField().value).toBe('1'))
    })

    it('leaves the keys alone outside the viewer', async () => {
      threePages()
      render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
      await waitFor(() => expect(pageField().value).toBe('1'))
      fireEvent.keyDown(document.body, { key: 'End' })
      expect(pageField().value).toBe('1')
    })

    it('zooms with + and -, and fits again with Cmd+0', async () => {
      threePages()
      render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
      await waitFor(() => expect(pageField().value).toBe('1'))
      const frame = screen.getByTestId('pdf-scroll')

      fireEvent.keyDown(frame, { key: '+' })
      expect(await screen.findByText('125%')).toBeTruthy()
      fireEvent.keyDown(frame, { key: '+' })
      expect(await screen.findByText('150%')).toBeTruthy()
      fireEvent.keyDown(frame, { key: '0', metaKey: true })
      expect(await screen.findByText('100%')).toBeTruthy()
      fireEvent.keyDown(frame, { key: '-' })
      expect(await screen.findByText('75%')).toBeTruthy()
    })

    it('fits the whole page on request, and says it is doing so', async () => {
      threePages()
      render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
      const toggle = await screen.findByRole('button', { name: 'Fit whole page' })
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-pressed', 'true')
    })
  })

  describe('finding words in the document', () => {
    beforeEach(() => {
      state.pages = [
        { items: [run('Zwei Fluchtwege je Nutzungseinheit', 700, 220)] },
        { items: [run('Brandabschnitte und Trennwände', 700, 200)] },
        { items: [run('Der zweite FLUCHTWEG führt über das Fenster', 700, 260)] },
      ]
    })

    it('opens on Cmd+F inside the viewer, counts every hit and walks them', async () => {
      render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
      await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(3))

      fireEvent.keyDown(screen.getByTestId('pdf-scroll'), { key: 'f', metaKey: true })
      const field = await screen.findByRole('searchbox', { name: 'Search term' })
      fireEvent.change(field, { target: { value: 'fluchtweg' } })

      // Case does not matter: the PDF's spelling is not the reader's.
      await waitFor(() => expect(screen.getByTestId('pdf-search-count')).toHaveTextContent('1 of 2'))
      expect(screen.getAllByTestId('search-mark')).toHaveLength(2)
      expect(document.querySelectorAll('[data-testid="search-mark"][data-active]')).toHaveLength(1)

      fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
      expect(screen.getByTestId('pdf-search-count')).toHaveTextContent('2 of 2')
      fireEvent.keyDown(field, { key: 'Enter' })
      expect(screen.getByTestId('pdf-search-count')).toHaveTextContent('1 of 2')

      fireEvent.keyDown(field, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByTestId('pdf-search-bar')).toBeNull())
      expect(screen.queryAllByTestId('search-mark')).toHaveLength(0)
    })

    it('says so when nothing matches', async () => {
      render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
      fireEvent.click(await screen.findByRole('button', { name: 'Find in document' }))
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search term' }), {
        target: { value: 'Stellplatz' },
      })
      await waitFor(() => expect(screen.getByTestId('pdf-search-count')).toHaveTextContent('No matches'))
    })
  })

  it('names every control it draws', async () => {
    state.pages = [{ items: [] }, { items: [] }]
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(2))
    const toolbar = screen.getByRole('group', { name: 'Document controls' })
    for (const name of [
      'Hide page overview',
      'Previous page',
      'Next page',
      'Zoom out',
      'Zoom in',
      'Fit whole page',
      'Find in document',
    ]) {
      expect(within(toolbar).getByRole('button', { name })).toBeTruthy()
    }
    expect(within(toolbar).getByRole('textbox', { name: 'Go to page, of 2' })).toBeTruthy()
    // No separator role in the pill: a split's resize handle is the separator
    // on the screens this viewer is mounted in.
    expect(within(toolbar).queryByRole('separator')).toBeNull()
  })

  it('lists the pages in a rail that marks the one being read', async () => {
    state.pages = [{ items: [] }, { items: [] }, { items: [] }]
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    const rail = await screen.findByRole('navigation', { name: 'Pages' })
    const thumbs = within(rail).getAllByRole('button')
    expect(thumbs).toHaveLength(3)
    expect(thumbs[0]).toHaveAttribute('aria-current', 'page')

    fireEvent.click(within(rail).getByRole('button', { name: 'Page 3' }))
    await waitFor(() => expect(within(rail).getByRole('button', { name: 'Page 3' })).toHaveAttribute('aria-current', 'page'))

    fireEvent.click(screen.getByRole('button', { name: 'Hide page overview' }))
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull()
  })
})

describe('pointOnPage', () => {
  const rect = { left: 10, top: 20, width: 200, height: 100 }

  it('is the share of the page the click hit, top-left origin', () => {
    expect(pointOnPage(3, rect, 60, 45)).toEqual({ page: 3, x: 0.25, y: 0.25 })
  })

  it('clamps a click on the page edge onto the page', () => {
    expect(pointOnPage(1, rect, 0, 500)).toEqual({ page: 1, x: 0, y: 1 })
  })

  it('has no point on a page with no size yet', () => {
    expect(pointOnPage(1, { ...rect, width: 0 }, 60, 45)).toBeNull()
  })
})
