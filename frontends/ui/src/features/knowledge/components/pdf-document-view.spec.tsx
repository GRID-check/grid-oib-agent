import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { PdfDocumentView } from './pdf-document-view'

/**
 * The viewer's own wiring: does the page it was pointed at actually get its
 * text read, the cited passage located, and a mark placed over it at the right
 * coordinates — and does it fall back to the browser's viewer when pdf.js
 * cannot start. The matching itself is covered by `passage-highlight.spec.ts`
 * and the geometry by `pdf-text-chunks.spec.ts`; this is the seam between them
 * and the DOM.
 */

const PAGE_WIDTH = 600
const PAGE_HEIGHT = 800
/** Frame width chosen so the fit-to-width scale works out to exactly 1. */
const FRAME_WIDTH = PAGE_WIDTH + 24

interface FakeItem {
  str: string
  width: number
  height: number
  transform: number[]
}

const state = vi.hoisted(() => ({
  fail: false,
  pages: [] as Array<{ items: FakeItem[] }>,
  destroyed: 0,
}))

vi.mock('../lib/pdfjs-runtime', () => ({
  documentParameters: (url: string) => ({ url }),
  loadPdfjs: async () => {
    if (state.fail) throw new Error('worker unavailable')
    return {
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: state.pages.length,
          getPage: (number: number) =>
            Promise.resolve({
              // The viewport pdf.js builds for an unrotated page: y flipped and
              // shifted by the page height.
              getViewport: ({ scale }: { scale: number }) => ({
                width: PAGE_WIDTH * scale,
                height: PAGE_HEIGHT * scale,
                scale,
                transform: [scale, 0, 0, -scale, 0, PAGE_HEIGHT * scale],
              }),
              render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
              getTextContent: () =>
                Promise.resolve({ items: state.pages[number - 1]?.items ?? [] }),
            }),
        }),
        destroy: () => {
          state.destroyed += 1
          return Promise.resolve()
        },
      }),
    }
  },
}))

/** A 12pt run of text with its baseline at PDF-space (72, `baseline`). */
const run = (str: string, baseline: number, width: number): FakeItem => ({
  str,
  width,
  height: 12,
  transform: [12, 0, 0, 12, 72, baseline],
})

const restoreObservers = { current: () => {} }

beforeEach(() => {
  state.fail = false
  state.destroyed = 0
  state.pages = []
  restoreObservers.current = installLayoutObservers({ frameWidth: FRAME_WIDTH })
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

  it('releases the document when the viewer goes away', async () => {
    state.pages = [{ items: [] }]
    const { unmount } = render(<PdfDocumentView src="/api/doc.pdf" title="doc.pdf" />)
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(1))
    unmount()
    await waitFor(() => expect(state.destroyed).toBe(1))
  })
})
