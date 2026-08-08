import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { installLayoutObservers } from '@/test-utils/layout-observers'
import { PdfViewerDialog } from './pdf-viewer-dialog'

const PAGE_WIDTH = 600
const PAGE_HEIGHT = 800
const FRAME_WIDTH = PAGE_WIDTH + 24

const state = vi.hoisted(() => ({
  items: [] as Array<{ str: string; width: number; height: number; transform: number[] }>,
}))

vi.mock('../lib/pdfjs-runtime', () => ({
  documentParameters: (url: string) => ({ url }),
  loadPdfjs: async () => ({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: () =>
          Promise.resolve({
            getViewport: ({ scale }: { scale: number }) => ({
              width: PAGE_WIDTH * scale,
              height: PAGE_HEIGHT * scale,
              scale,
              transform: [scale, 0, 0, -scale, 0, PAGE_HEIGHT * scale],
            }),
            render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
            getTextContent: () => Promise.resolve({ items: state.items }),
          }),
      }),
      destroy: () => Promise.resolve(),
    }),
  }),
}))

const restoreObservers = { current: () => {} }

beforeEach(() => {
  state.items = []
  restoreObservers.current = installLayoutObservers({ frameWidth: FRAME_WIDTH })
})

afterEach(() => {
  restoreObservers.current()
})

describe('PdfViewerDialog', () => {
  it('renders the document in the in-app viewer when opened', async () => {
    render(
      <PdfViewerDialog
        open
        onOpenChange={() => {}}
        fileName="plan.pdf"
        src="https://example.test/plan.pdf"
      />,
    )
    await waitFor(() => expect(document.querySelectorAll('[data-page]')).toHaveLength(1))
    // The passage highlight needs a text layer, which the browser's own viewer
    // never exposed — so the document must NOT be handed to a bare frame.
    expect(document.querySelector('iframe')).toBeNull()
  })

  /**
   * The in-app viewer scrolls itself, so `page` reaches it as a prop rather than
   * as a URL fragment. The fragment still has to be on the "open in new tab"
   * link, which hands the document to the BROWSER's viewer — dropping it there
   * would send someone who opened page 12 in a tab back to page 1.
   */
  it('keeps the page fragment on the link out to the browser viewer', () => {
    render(
      <PdfViewerDialog
        open
        onOpenChange={() => {}}
        fileName="plan.pdf"
        src="https://example.test/plan.pdf"
        page={12}
      />,
    )
    const link = screen.getByRole('link', { name: /Open in new tab/i })
    expect(link.getAttribute('href')).toBe('https://example.test/plan.pdf#page=12')
  })

  it('passes the cited passage through so the viewer can mark it', async () => {
    state.items = [
      { str: 'Die Frist betraegt vier Wochen', width: 180, height: 12, transform: [12, 0, 0, 12, 72, 700] },
    ]
    render(
      <PdfViewerDialog
        open
        onOpenChange={() => {}}
        fileName="plan.pdf"
        src="https://example.test/plan.pdf"
        page={1}
        highlight="Die Frist betraegt vier Wochen"
        highlightColor="var(--source-law)"
      />,
    )
    const mark = await screen.findByTestId('passage-mark')
    expect(mark.style.getPropertyValue('--passage-tint')).toBe('var(--source-law)')
  })

  it('renders an image source in the image frame, untouched by the PDF path', () => {
    render(
      <PdfViewerDialog
        open
        onOpenChange={() => {}}
        fileName="foto.png"
        src="https://example.test/foto.png"
        isImage
      />,
    )
    expect(screen.getByAltText('foto.png').tagName).toBe('IMG')
    expect(document.querySelector('[data-testid="pdf-scroll"]')).toBeNull()
  })

  // Regression: the shared DialogContent primitive carries `sm:max-w-lg`
  // (512px). Because tailwind-merge treats the `sm:` variant separately from an
  // unprefixed `max-w-*`, a plain override does NOT win at ≥sm viewports, so the
  // maximized viewer was silently clamped to 512px — tall-and-narrow, which
  // letterboxes wide/landscape drawings. The fix must override the `sm:` width
  // so the dialog can fill the viewport and render the document large.
  it('overrides the primitive sm width clamp so it is not capped at 512px', () => {
    render(
      <PdfViewerDialog
        open
        onOpenChange={() => {}}
        fileName="section.pdf"
        src="https://example.test/section.pdf"
      />,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('sm:max-w-[95vw]')
    // The narrow 512px clamp must not be the effective width.
    expect(dialog.className).not.toContain('sm:max-w-lg')
  })
})
