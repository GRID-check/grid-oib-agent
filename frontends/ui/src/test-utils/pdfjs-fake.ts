/**
 * A stand-in for the pdf.js runtime, for specs that render the PDF viewer.
 *
 * Shared rather than copied per spec because the interesting parts — the
 * viewport matrix and the shape of a text item — are exactly the contract the
 * viewer's geometry depends on. Two hand-maintained copies drift, and the
 * suite that still holds the stale one keeps passing against a pdf.js that no
 * longer exists.
 *
 * Usage, from a spec's `vi.mock` factory (which is hoisted, so the state object
 * must come from `vi.hoisted`):
 *
 *   const state = vi.hoisted(() => ({ fail: false, pages: [], destroyed: 0 }))
 *   vi.mock('../lib/pdfjs-runtime', () => fakePdfjsRuntime(state))
 */

import { screen, waitFor } from '@testing-library/react'

/** The fields of a pdf.js `TextItem` the viewer reads. */
export interface FakeTextItem {
  str: string
  width: number
  height: number
  transform: number[]
}

export interface FakePdfState {
  /** When true, `loadPdfjs` rejects — the viewer's fallback path. */
  fail: boolean
  /** One entry per page, in order. */
  pages: Array<{ items: FakeTextItem[] }>
  /** Incremented when the loading task is destroyed. */
  destroyed: number
  /**
   * When set, the document is encrypted with this password: opening it without
   * one rejects the way pdf.js does (`PasswordException`, code 1), and with a
   * wrong one as code 2.
   */
  password?: string
}

/** Page geometry the fake reports. A4-ish, and round enough to assert on. */
export const FAKE_PAGE_WIDTH = 600
export const FAKE_PAGE_HEIGHT = 800

/**
 * Frame width that makes fit-to-width resolve to a scale of exactly 1, so a
 * spec can assert page coordinates directly. Accounts for the viewer's gutter.
 */
export const FAKE_FRAME_WIDTH = FAKE_PAGE_WIDTH + 24

/** A 12pt run of text with its baseline at PDF-space (72, `baseline`). */
export const fakeTextRun = (str: string, baseline: number, width: number): FakeTextItem => ({
  str,
  width,
  height: 12,
  transform: [12, 0, 0, 12, 72, baseline],
})

/**
 * Build the module shape `vi.mock('../lib/pdfjs-runtime', …)` must return.
 * The viewport matrix is the one pdf.js builds for an unrotated page: x passes
 * through, y is flipped and shifted by the page height.
 */
export const fakePdfjsRuntime = (state: FakePdfState) => ({
  documentParameters: (url: string) => ({ url }),
  /**
   * Stand-in for the real text layer: one span per run, which is the part of it
   * a spec can meaningfully assert — that the page's words reach the DOM at all,
   * rather than living only on the canvas. Their pdf.js geometry is not
   * reproduced here; jsdom lays nothing out, so there would be nothing to read
   * back off it.
   */
  renderTextLayer: async (page: { textItems?: FakeTextItem[] }, container: HTMLElement) => {
    for (const item of page.textItems ?? []) {
      const span = document.createElement('span')
      span.textContent = item.str
      container.append(span)
    }
    return { destroy: () => container.replaceChildren() }
  },
  /**
   * Stand-in for the stream reader. The page carries its runs in `textItems`
   * (below), because the fake never builds a real text stream; the reader's own
   * behaviour, including that it never needs async iteration, is covered in
   * `pdfjs-runtime.spec.ts`.
   */
  readPageTextItems: async (page: { textItems?: FakeTextItem[] }) => page.textItems ?? [],
  loadPdfjs: async () => {
    if (state.fail) throw new Error('worker unavailable')
    return {
      getDocument: (parameters: { password?: string } = {}) => ({
        promise: (state.password && parameters.password !== state.password
          ? Promise.reject(
              Object.assign(new Error('No password given'), {
                name: 'PasswordException',
                code: parameters.password ? 2 : 1,
              }),
            )
          : Promise.resolve({
          numPages: state.pages.length,
          getPage: (number: number) =>
            Promise.resolve({
              getViewport: ({ scale }: { scale: number }) => ({
                width: FAKE_PAGE_WIDTH * scale,
                height: FAKE_PAGE_HEIGHT * scale,
                scale,
                transform: [scale, 0, 0, -scale, 0, FAKE_PAGE_HEIGHT * scale],
              }),
              render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
              cleanup: () => {},
              // Not a pdf.js field: how `renderTextLayer` and
              // `readPageTextItems` above know which page they were handed,
              // since neither touches a real stream.
              textItems: state.pages[number - 1]?.items ?? [],
            }),
          })),
        destroy: () => {
          state.destroyed += 1
          return Promise.resolve()
        },
      }),
    }
  },
})

/**
 * Wait until a page's text layer holds `text`, then select everything in it,
 * the way a drag across it would, and return the layer.
 *
 * The layer element is mounted before pdf.js has handed it the page's words:
 * they arrive from `getTextContent`, a promise. Selecting the moment the
 * element appears selects an empty node on a loaded runner, the selection
 * comes back collapsed, and the viewer rightly offers nothing. A spec that
 * expects an offer then fails one run in a few, and one that expects NO offer
 * passes without testing anything. Waiting for the words closes both.
 *
 * happy-dom has a Selection but no layout, so the range's bounding rect is all
 * zeros, which the viewer reads as the top-left of the page stack; no
 * assertion here is about the position.
 */
export async function selectRenderedText(text: string): Promise<HTMLElement> {
  const layer = await waitFor(() => {
    const found = screen.getAllByTestId('pdf-text-layer').find((node) => node.textContent?.includes(text))
    if (!found) throw new Error(`no text layer holds ${JSON.stringify(text)} yet`)
    return found
  })
  const range = document.createRange()
  range.selectNodeContents(layer)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return layer
}
