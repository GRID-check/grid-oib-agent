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

beforeEach(() => {
  state.fail = false
  state.destroyed = 0
  state.pages = []
  restoreObservers.current = installLayoutObservers({ frameWidth: FAKE_FRAME_WIDTH })
})

afterEach(() => {
  restoreObservers.current()
  vi.restoreAllMocks()
})

describe('PdfDocumentView', () => {
  it('renders one frame per page of the document', async () => {
    state.pages = [{ items: [] }, { items: [] }, { items: [] }]
    render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(3))
    expect(screen.getByText('3 pages')).toBeTruthy()
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

  it('releases the document when the viewer goes away', async () => {
    state.pages = [{ items: [] }]
    const { unmount } = render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(1))
    unmount()
    await waitFor(() => expect(state.destroyed).toBe(1))
  })
})
